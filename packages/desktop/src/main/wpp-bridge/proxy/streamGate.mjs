// Pure, transport-agnostic gate that decides — from cumulative text-so-far — whether a turn
// is plain prose (safe to stream live to the OpenCode UI) or a tool call (must be suppressed
// until the full text is captured and normalized into structured tool_calls).
//
// The OgilvyOneCoder persona emits tool calls as inline Anthropic-style XML
// (`<function_calls><invoke …>`), sometimes wrapped in a code fence, and occasionally as a
// leading JSON object (`{"type":"tool_call",…}`). The proxy only converts those into real
// tool_calls AFTER the complete text arrives (see toolCallNormalizer.mjs). If we streamed
// every delta as `content`, a tool-calling turn would spray raw XML/JSON into the UI before
// being retroactively replaced — so we hold back until we can tell which kind of turn it is.
//
// Decision policy: stay "undecided" until either (a) at least DECISION_THRESHOLD non-whitespace
// characters have arrived, or (b) the stream is finalized — whichever comes first. At that point
// inspect the LEADING content: anything that looks like a tool call → "suppressed"; otherwise
// "prose". Once "prose", every cumulative frame yields an incremental delta (the slice past what
// we've already emitted). Once "suppressed", nothing is ever emitted as content.
//
// This module is intentionally free of any I/O, OpenAI-shape, or extension concerns so it can be
// unit-tested in isolation and reused on either side of the bridge.

// Decide prose-vs-tool-call once this many non-whitespace characters have accumulated (or at
// finalize). This is the only added latency on a prose turn: the first ~24 non-whitespace chars
// are buffered before prose starts flowing. Large enough to contain a leading "<function_calls>"
// (16 chars) or "<invoke name=" marker so XML tool calls are caught before the gate opens.
export const DECISION_THRESHOLD = 24;

export class StreamGate {
  // How many chars of cumulative text we've already emitted as live prose. Internal: callers get
  // the un-emitted tail via trailingDiff() at finalize rather than slicing on this cursor themselves.
  #emittedLength = 0;

  constructor({ threshold = DECISION_THRESHOLD } = {}) {
    this.threshold = Math.max(1, Number(threshold) || DECISION_THRESHOLD);
    this.state = "undecided"; // "undecided" | "prose" | "suppressed"
    this.cumulative = "";
  }

  // Feed the latest cumulative text-so-far. Returns { state, delta } where delta is the new
  // prose text to emit since the previous call (empty string while undecided or suppressed).
  update(cumulativeText) {
    this.cumulative = typeof cumulativeText === "string" ? cumulativeText : "";

    if (this.state === "undecided") {
      if (nonWhitespaceLength(this.cumulative) < this.threshold) {
        return { state: this.state, delta: "" };
      }

      this.#decide(this.cumulative);
    }

    // Compute the delta first: it may flip the gate to "suppressed" on a mid-stream marker.
    const delta = this.#takeProseDelta();
    return { state: this.state, delta };
  }

  // Force a terminal decision using the authoritative final text (defaults to the last
  // cumulative frame). A turn that never reached the threshold is decided here. Returns the
  // trailing prose delta (empty for suppressed/tool-call turns).
  finalize(finalText) {
    if (typeof finalText === "string") {
      this.cumulative = finalText;
    }

    if (this.state === "undecided") {
      this.#decide(this.cumulative);
    }

    const delta = this.#takeProseDelta();
    return { state: this.state, delta };
  }

  // At stream end, return the portion of the authoritative final content not yet emitted live.
  // Unlike update(), no partial-marker hold-back: the content is final, so the whole un-emitted
  // tail is safe to flush. Keeps the emitted-char cursor internal to the gate.
  trailingDiff(finalContent) {
    const content = typeof finalContent === "string" ? finalContent : "";
    return content.length > this.#emittedLength ? content.slice(this.#emittedLength) : "";
  }

  #decide(text) {
    this.state = leadingLooksLikeToolCall(text) ? "suppressed" : "prose";
  }

  #takeProseDelta() {
    if (this.state !== "prose") {
      return "";
    }

    // A turn can lead with prose and THEN emit a tool call ("I'll search…" → {"type":"tool_call"}
    // → trailing refusal). The leading check can't catch that, so cap live prose at the first
    // tool-call marker and suppress everything after it — the call is delivered structurally at
    // finalize, never as raw text.
    const markerIndex = firstToolCallMarker(this.cumulative);
    // Otherwise stop short of a trailing fragment that could be the start of a marker split across
    // frames (e.g. cumulative ending in "{\"ty" or "<inv"), so we never stream a partial marker.
    const emitEnd = markerIndex >= 0
      ? markerIndex
      : this.cumulative.length - trailingMarkerPrefixLength(this.cumulative);

    if (emitEnd <= this.#emittedLength) {
      if (markerIndex >= 0) {
        this.state = "suppressed";
      }
      return "";
    }

    const delta = this.cumulative.slice(this.#emittedLength, emitEnd);
    this.#emittedLength = emitEnd;

    if (markerIndex >= 0) {
      this.state = "suppressed";
    }

    return delta;
  }
}

// Literal prefixes the tool-call markers begin with, used both to locate a complete marker and to
// hold back a partial one at a frame boundary. Kept in one place so the live gate and
// leadingLooksLikeToolCall can't drift apart on what counts as a tool call.
const TOOL_CALL_MARKER_PREFIXES = ["<function_calls", "<invoke", "{\"type\":\"tool_call\""];

// Index of the first complete tool-call marker anywhere in the text, or -1. The JSON form tolerates
// whitespace the literal prefix doesn't (e.g. `{ "type" : "tool_call"`).
function firstToolCallMarker(text) {
  const value = String(text || "");
  const match = value.match(/<function_calls\b|<invoke\b|\{\s*"type"\s*:\s*"tool_call"/i);
  return match ? match.index : -1;
}

// Length of a trailing run that is a (proper, incomplete) prefix of some marker, so it can be held
// back until the next frame resolves it. 0 when the tail can't be the start of a marker.
function trailingMarkerPrefixLength(text) {
  const value = String(text || "");
  let longest = 0;

  for (const prefix of TOOL_CALL_MARKER_PREFIXES) {
    for (let k = Math.min(prefix.length - 1, value.length); k > 0; k -= 1) {
      if (value.endsWith(prefix.slice(0, k))) {
        longest = Math.max(longest, k);
        break;
      }
    }
  }

  return longest;
}

// True when the LEADING non-whitespace content looks like the start of a tool call. Mirrors the
// signals toolCallNormalizer.mjs keys on so the live decision matches the final normalization:
// Anthropic XML (optionally wrapped in a leading code fence) or a leading JSON object (which may
// be a {"type":"tool_call"} or delegated-agent call). A leading "{" is treated conservatively as
// a potential tool call — prose almost never starts with a brace, and if it turns out to be
// content the finalize path still emits it as a trailing diff (just not streamed live).
export function leadingLooksLikeToolCall(text) {
  const trimmed = String(text || "").trimStart();

  if (!trimmed) {
    return false;
  }

  const candidate = stripLeadingCodeFence(trimmed).trimStart();

  if (!candidate) {
    // Nothing but an opening code fence so far — undecidable; treat as potential tool call so we
    // don't stream a fence that may wrap tool-call XML. Resolves once more text arrives.
    return true;
  }

  if (/^<function_calls\b/i.test(candidate) || /^<invoke\b/i.test(candidate)) {
    return true;
  }

  // A lone "<" with nothing after it yet could become "<function_calls" — hold back.
  if (candidate === "<") {
    return true;
  }

  if (candidate.startsWith("{")) {
    return true;
  }

  return false;
}

// Strip a single leading opening code fence (three backticks, optionally followed by a language
// tag and end-of-line) so a tool call wrapped in a fenced block is detected by its inner leading
// content rather than by the fence itself.
function stripLeadingCodeFence(text) {
  const match = String(text || "").match(/^```[a-zA-Z]*[ \t]*\r?\n?/);
  return match ? text.slice(match[0].length) : text;
}

function nonWhitespaceLength(text) {
  let count = 0;
  for (const char of text) {
    if (!/\s/.test(char)) {
      count += 1;
    }
  }
  return count;
}
