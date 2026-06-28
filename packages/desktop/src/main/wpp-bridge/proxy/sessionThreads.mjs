// In-memory session -> WPP-thread watermark. OpenCode resends the FULL transcript on every call
// (stateless OpenAI protocol), so we never lose data: this only records how much of the transcript
// the pinned tab has already been shown, letting us forward just the new turn ("continue") instead
// of replaying everything ("fresh"). Co-located with the worker pool in the Electron main process,
// so a process restart clears both the map and the tabs together — they can't disagree.
//
// "continue" requires ALL of: continuity enabled, a live pinned tab, and the stored hashes being an
// exact prefix of the current transcript. Any retry/edit/branch/compaction in OpenCode breaks the
// prefix, and a reaped/crashed tab fails the liveness check — either way we fall back to "fresh"
// (full replay), which is always safe because body.messages still holds the whole conversation.

const threads = new Map(); // sessionKey -> { hashes: string[] }

export function threadContinuityEnabled() {
  return process.env.O1_CODE_THREAD_CONTINUITY !== "0";
}

function nonSystemMessages(body) {
  const all = Array.isArray(body?.messages) ? body.messages : [];
  return all.filter((message) => message.role !== "system");
}

// fnv-1a over the message's identity-bearing fields. Content can be large (tool results, image
// placeholders); a hash keeps the map small while still detecting any edit to a prior turn.
function hashMessage(message) {
  const canonical = JSON.stringify([
    message.role || "user",
    message.content ?? null,
    message.tool_call_id || "",
    Array.isArray(message.tool_calls) ? message.tool_calls.map((call) => call.id || "") : null,
  ]);
  let hash = 0x811c9dc5;
  for (let index = 0; index < canonical.length; index += 1) {
    hash ^= canonical.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(16);
}

function hashesFor(body) {
  return nonSystemMessages(body).map(hashMessage);
}

function isPrefix(prev, next) {
  if (prev.length > next.length) return false;
  return prev.every((hash, index) => hash === next[index]);
}

// Decide how to serialize this turn. `sinceIndex` indexes into the non-system messages (the same
// order messageSerializer iterates), so "continue" forwards only messages after the watermark.
export function decideThreadMode(sessionKey, body, tabAlive) {
  if (!sessionKey || !tabAlive) return { mode: "fresh", sinceIndex: 0 };

  const entry = threads.get(sessionKey);
  if (!entry) return { mode: "fresh", sinceIndex: 0 };

  const current = hashesFor(body);
  if (!isPrefix(entry.hashes, current) || current.length <= entry.hashes.length) {
    return { mode: "fresh", sinceIndex: 0 };
  }

  return { mode: "continue", sinceIndex: entry.hashes.length };
}

// Record that the tab now holds the full current transcript. Called after a successful turn in
// either mode (fresh resets the thread to the full history; continue extends it), so the next turn
// can compute its delta against this baseline.
export function commitThread(sessionKey, body) {
  if (!sessionKey) return;
  threads.set(sessionKey, { hashes: hashesFor(body) });
}

// Drop the watermark so the next turn replays fresh — used when a turn fails (the tab may be in an
// unknown state) so we never extend a delta onto a thread we can't trust.
export function resetThread(sessionKey) {
  if (sessionKey) threads.delete(sessionKey);
}
