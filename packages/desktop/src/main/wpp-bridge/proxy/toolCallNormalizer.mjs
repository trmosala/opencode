import { looksLikeIncompleteAnthropicToolCall } from "./anthropicToolFormat.mjs";

export function chooseAssistantResponse(finalText, toolCallParts) {
  const fromText = normalizeAssistantMessage(finalText);
  const fromParts = normalizeFromToolCallParts(toolCallParts);

  if (fromText?.finish_reason === "tool_calls" && fromText.tool_calls?.length) {
    return fromText;
  }

  if (fromParts?.tool_calls?.length) {
    return fromParts;
  }

  return fromText;
}

export function normalizeFromToolCallParts(toolCallParts) {
  const parts = Object.values(toolCallParts || {}).filter((p) => p?.name);

  if (parts.length === 0) {
    return null;
  }

  const tool_calls = parts.map((part) => ({
    id: part.id || `call_${crypto.randomUUID().replace(/-/g, "")}`,
    type: "function",
    function: {
      name: part.name,
      arguments: part.arguments || "{}"
    }
  }));

  return {
    content: null,
    tool_calls,
    finish_reason: "tool_calls"
  };
}

export function normalizeAssistantMessage(content) {
  const unwrappedContent = unwrapSingleCodeFence(content);
  const extractionContent = unwrappedContent === content
    ? removeCodeFencedBlocks(content)
    : unwrappedContent;

  // A real XML tool call is emitted bare (the system prompt forbids fencing it), so parse it from
  // the RAW text starting at the first UNFENCED <function_calls>/<invoke>. This keeps code fences
  // INSIDE a parameter value intact — stripping them (removeCodeFencedBlocks) decapitates the
  // closing </parameter> when the model writes a markdown/code file, dropping the `content` arg.
  // A fenced *example* has its marker inside a fence, so it isn't found here and stays inert.
  let xmlCalls = null;
  if (unwrappedContent !== content) {
    xmlCalls = parseAnthropicXmlToolCalls(unwrappedContent);
  } else {
    const start = unfencedToolCallStart(content);
    if (start >= 0) {
      xmlCalls = parseAnthropicXmlToolCalls(content.slice(start));
    }
  }

  if (xmlCalls && xmlCalls.length > 0) {
    return {
      content: null,
      tool_calls: xmlCalls.map((call) => ({
        id: call.id || `call_${crypto.randomUUID().replace(/-/g, "")}`,
        type: "function",
        function: {
          name: call.name,
          arguments: JSON.stringify(call.args || {})
        }
      })),
      finish_reason: "tool_calls"
    };
  }

  const jsonToolCalls = parseTrailingToolCallJsons(extractionContent);

  if (jsonToolCalls?.length) {
    return {
      content: null,
      tool_calls: toolCallsFromJsonCalls(dedupeToolCalls(jsonToolCalls)),
      finish_reason: "tool_calls"
    };
  }

  // A model may emit several calls as one trailing JSON array ([{...},{...}]) rather than
  // back-to-back objects; accept that shape too.
  const arrayToolCalls = parseTrailingToolCallArray(extractionContent);

  if (arrayToolCalls?.length) {
    return {
      content: null,
      tool_calls: toolCallsFromJsonCalls(dedupeToolCalls(arrayToolCalls)),
      finish_reason: "tool_calls"
    };
  }

  const leadingJsonToolCall = parseLeadingToolCallJson(extractionContent);

  if (leadingJsonToolCall) {
    return {
      content: null,
      tool_calls: toolCallsFromJsonCalls([leadingJsonToolCall]),
      finish_reason: "tool_calls"
    };
  }

  const embeddedJsonToolCalls = parseEmbeddedToolCallJsons(extractionContent);

  if (embeddedJsonToolCalls?.length) {
    return {
      content: null,
      tool_calls: toolCallsFromJsonCalls(dedupeToolCalls(embeddedJsonToolCalls)),
      finish_reason: "tool_calls"
    };
  }

  const parsed = parseDelegatedAgentJson(extractionContent)
    || parseStrictJson(unwrappedContent);

  if (!parsed) {
    return {
      content,
      tool_calls: undefined,
      finish_reason: "stop"
    };
  }

  if (parsed.type === "final") {
    return {
      content: parsed.message || "",
      tool_calls: undefined,
      finish_reason: "stop"
    };
  }

  if (parsed.type === "tool_call" && parsed.tool) {
    return {
      content: null,
      tool_calls: [
        {
          id: parsed.id || `call_${crypto.randomUUID().replace(/-/g, "")}`,
          type: "function",
          function: {
            name: parsed.tool,
            arguments: JSON.stringify(parsed.args || {})
          }
        }
      ],
      finish_reason: "tool_calls"
    };
  }

  return {
    content,
    tool_calls: undefined,
    finish_reason: "stop"
  };
}

// Index of the first <function_calls>/<invoke> marker that is NOT inside a ``` fenced block, or
// -1. Fences are paired left-to-right (open/close); a real bare tool call's marker precedes any
// fences in its own parameter values, so it reads as unfenced, while a fenced example's marker sits
// inside a span and is skipped.
function unfencedToolCallStart(content) {
  if (typeof content !== "string") {
    return -1;
  }

  const ticks = [];
  const fence = /```/g;
  let f;
  while ((f = fence.exec(content)) !== null) {
    ticks.push(f.index);
  }

  const spans = [];
  for (let i = 0; i + 1 < ticks.length; i += 2) {
    spans.push([ticks[i], ticks[i + 1] + 3]);
  }

  const marker = /<function_calls\b|<invoke\b/g;
  let m;
  while ((m = marker.exec(content)) !== null) {
    if (!spans.some(([start, end]) => m.index >= start && m.index < end)) {
      return m.index;
    }
  }

  return -1;
}

export function parseAnthropicXmlToolCalls(content) {
  if (typeof content !== "string" || !content.includes("<invoke")) {
    return null;
  }

  const calls = [];
  const invokeRegex = /<invoke\s+name=(["'])([^"']+)\1\s*>([\s\S]*?)<\/invoke>/gi;
  let match;

  while ((match = invokeRegex.exec(content)) !== null) {
    const name = match[2];
    const body = match[3];
    calls.push(normalizeAnthropicInvoke({ name, args: extractInvokeParameters(body) }));
  }

  return calls.length > 0 ? calls : null;
}

// Extract <parameter name="X"> values from an invoke body. Each value runs from its opening tag to
// the EARLIEST terminator: the protocol's </parameter>, a name-based close the model sometimes
// emits instead (e.g. </content> for name="content"), or the next <parameter> opening. This
// tolerates the common Opus failure mode of closing the final/large parameter with the wrong tag or
// omitting it entirely, which otherwise drops the argument (observed: `write` losing `content`).
function extractInvokeParameters(body) {
  const args = {};
  const openRegex = /<parameter\s+name=(["'])([^"']+)\1\s*>/gi;
  const opens = [];
  let open;

  while ((open = openRegex.exec(body)) !== null) {
    opens.push({ name: open[2], valueStart: openRegex.lastIndex, openStart: open.index });
  }

  for (let i = 0; i < opens.length; i += 1) {
    const { name, valueStart } = opens[i];
    const hardEnd = i + 1 < opens.length ? opens[i + 1].openStart : body.length;
    const slice = body.slice(valueStart, hardEnd);
    const raw = decodeXmlEntities(trimParameterClose(slice, name));
    args[name] = coerceParameterValue(raw);
  }

  return args;
}

function trimParameterClose(value, name) {
  const ends = [];
  const standard = value.indexOf("</parameter>");
  if (standard >= 0) {
    ends.push(standard);
  }
  const named = value.search(new RegExp(`</${escapeRegExp(name)}\\s*>`, "i"));
  if (named >= 0) {
    ends.push(named);
  }

  return ends.length > 0 ? value.slice(0, Math.min(...ends)) : value;
}

function escapeRegExp(text) {
  return String(text).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function normalizeAnthropicInvoke(call) {
  const name = String(call.name || "").trim();

  if (isSubagentName(name) && typeof call.args?.prompt === "string") {
    return {
      name: "task",
      args: {
        subagent_type: name.toLowerCase(),
        prompt: call.args.prompt,
        description: typeof call.args.description === "string"
          ? call.args.description
          : summarizeTaskDescription(call.args.prompt)
      }
    };
  }

  return call;
}

function decodeXmlEntities(text) {
  return text
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, "\"")
    .replace(/&apos;/g, "'")
    .replace(/&#(\d+);/g, (_, code) => String.fromCharCode(Number(code)))
    .replace(/&amp;/g, "&");
}

function coerceParameterValue(raw) {
  const trimmed = raw.trim();

  if (trimmed === "") {
    return raw;
  }

  if (trimmed === "true") return true;
  if (trimmed === "false") return false;
  if (trimmed === "null") return null;

  if ((trimmed.startsWith("{") && trimmed.endsWith("}")) ||
      (trimmed.startsWith("[") && trimmed.endsWith("]"))) {
    try {
      return parseJsonWithRawWindowsPathRepair(trimmed);
    } catch {
      return raw;
    }
  }

  if (/^-?\d+$/.test(trimmed)) {
    const n = Number(trimmed);
    if (Number.isSafeInteger(n)) return n;
  }

  if (/^-?\d+\.\d+$/.test(trimmed)) {
    return Number(trimmed);
  }

  return raw;
}

function unwrapSingleCodeFence(content) {
  if (typeof content !== "string") {
    return content;
  }

  const match = content.trim().match(/^```(?:json|xml)?\s*\n?([\s\S]*?)\n?```$/);

  return match ? match[1] : content;
}

function removeCodeFencedBlocks(content) {
  if (typeof content !== "string") {
    return content;
  }

  return content.replace(/```[\s\S]*?```/g, "");
}

function parseStrictJson(content) {
  if (typeof content !== "string") {
    return null;
  }

  const trimmed = content.trim();

  if (!trimmed.startsWith("{") || !trimmed.endsWith("}")) {
    return null;
  }

  try {
    return parseJsonWithRawWindowsPathRepair(trimmed);
  } catch {
    return null;
  }
}

function parseJsonWithRawWindowsPathRepair(content) {
  const repaired = repairRawWindowsBackslashesInJsonStrings(content);

  if (repaired !== content) {
    try {
      return JSON.parse(repaired);
    } catch {
      // Fall through to the original parse so callers keep their existing behavior.
    }
  }

  return JSON.parse(content);
}

function repairRawWindowsBackslashesInJsonStrings(content) {
  if (typeof content !== "string" || !/[A-Za-z]:\\/.test(content)) {
    return content;
  }

  let output = "";
  let index = 0;

  while (index < content.length) {
    if (content[index] !== "\"") {
      output += content[index];
      index += 1;
      continue;
    }

    const start = index;
    index += 1;
    const valueStart = index;
    let slashCount = 0;

    while (index < content.length) {
      const char = content[index];

      if (char === "\"" && slashCount % 2 === 0) {
        break;
      }

      if (char === "\\") {
        slashCount += 1;
      } else {
        slashCount = 0;
      }

      index += 1;
    }

    const rawValue = content.slice(valueStart, index);
    const value = hasRawWindowsBackslash(rawValue)
      ? rawValue.replace(/(^|[^\\])\\(?!\\)/g, "$1\\\\")
      : rawValue;

    output += content[start] + value;

    if (index < content.length) {
      output += content[index];
      index += 1;
    }
  }

  return output;
}

function hasRawWindowsBackslash(value) {
  return /[A-Za-z]:/.test(value)
    && /(^|[^\\])\\(?!\\)/.test(value);
}

function parseDelegatedAgentJson(content) {
  if (typeof content !== "string") {
    return null;
  }

  for (const candidate of extractJsonObjects(content).reverse()) {
    try {
      const parsed = JSON.parse(candidate);
      const name = typeof parsed?.name === "string" ? parsed.name.trim() : "";

      if (!name || parsed?.type === "tool_call") {
        continue;
      }

      const args = { ...parsed };
      delete args.name;

      if (isSubagentName(name) && typeof args.prompt === "string") {
        return {
          type: "tool_call",
          tool: "task",
          args: {
            subagent_type: name.toLowerCase(),
            prompt: args.prompt,
            description: typeof args.description === "string"
              ? args.description
              : summarizeTaskDescription(args.prompt)
          }
        };
      }

      return {
        type: "tool_call",
        tool: name,
        args
      };
    } catch {
      continue;
    }
  }

  return null;
}

function isSubagentName(name) {
  return ["explore", "general", "scout", "search"].includes(String(name).toLowerCase());
}

function summarizeTaskDescription(prompt) {
  const text = String(prompt || "").trim().replace(/\s+/g, " ");

  if (!text) {
    return "Run subagent task";
  }

  const words = text.split(" ").slice(0, 5).join(" ");
  return words.length > 48 ? `${words.slice(0, 45)}...` : words;
}

function toolCallsFromJsonCalls(calls) {
  return calls.map((call) => ({
    id: call.id || `call_${crypto.randomUUID().replace(/-/g, "")}`,
    type: "function",
    function: {
      name: call.tool,
      arguments: JSON.stringify(call.args || {})
    }
  }));
}

// Accept a trailing JSON array whose elements are all tool_call objects, e.g.
// [{"type":"tool_call","tool":"a","args":{}},{"type":"tool_call","tool":"b","args":{}}].
function parseTrailingToolCallArray(content) {
  if (typeof content !== "string") {
    return null;
  }

  const arrays = extractJsonArraysWithPositions(content);

  if (arrays.length === 0) {
    return null;
  }

  const last = arrays[arrays.length - 1];

  if (content.slice(last.end).trim()) {
    return null;
  }

  let parsed;

  try {
    parsed = parseJsonWithRawWindowsPathRepair(last.text);
  } catch {
    return null;
  }

  if (!Array.isArray(parsed) || parsed.length === 0) {
    return null;
  }

  if (!parsed.every((call) => call?.type === "tool_call" && call.tool)) {
    return null;
  }

  return parsed;
}

function parseTrailingToolCallJsons(content) {
  if (typeof content !== "string") {
    return null;
  }

  const objects = extractJsonObjectsWithPositions(content);
  const calls = [];
  let cursor = content.length;

  for (let index = objects.length - 1; index >= 0; index -= 1) {
    const candidate = objects[index];

    if (content.slice(candidate.end, cursor).trim()) {
      break;
    }

    let parsed;

    try {
      parsed = parseJsonWithRawWindowsPathRepair(candidate.text);
    } catch (err) {
      process.stderr.write(`[toolCallNormalizer] JSON parse failed: ${err.message}\n`);
      break;
    }

    if (!(parsed?.type === "tool_call" && parsed.tool)) {
      break;
    }

    calls.unshift(parsed);
    cursor = candidate.start;
  }

  return calls.length > 0 ? calls : null;
}

function parseLeadingToolCallJson(content) {
  if (typeof content !== "string") {
    return null;
  }

  const trimmedStart = content.search(/\S/u);

  if (trimmedStart < 0) {
    return null;
  }

  const firstObject = extractJsonObjectsWithPositions(content)
    .find((object) => object.start === trimmedStart);

  if (!firstObject) {
    return null;
  }

  try {
    const parsed = parseJsonWithRawWindowsPathRepair(firstObject.text);

    return parsed?.type === "tool_call" && parsed.tool ? parsed : null;
  } catch {
    return null;
  }
}

// Collect every {"type":"tool_call",...} object embedded anywhere in the text, regardless of
// surrounding prose — the JSON analogue of parseAnthropicXmlToolCalls's global <invoke> scan.
// Runs only AFTER the strict leading/trailing checks fail, so cleanly-shaped turns keep their
// existing behavior; this is the placement-tolerance path for models that narrate around their
// tool-call JSON ("I'll do X… {tool_call} …then Y"). Operates on the same fence-stripped
// extraction content as the XML scan, so fenced examples stay inert (XML parity).
function parseEmbeddedToolCallJsons(content) {
  if (typeof content !== "string" || !content.includes("\"tool_call\"")) {
    return null;
  }

  const calls = [];

  for (const candidate of extractJsonObjectsWithPositions(content)) {
    let parsed;

    try {
      parsed = parseJsonWithRawWindowsPathRepair(candidate.text);
    } catch {
      continue;
    }

    if (parsed?.type === "tool_call" && parsed.tool) {
      calls.push(parsed);
    }
  }

  return calls.length > 0 ? calls : null;
}

function dedupeToolCalls(calls) {
  const seen = new Set();
  const result = [];

  for (const call of calls) {
    const key = JSON.stringify({
      tool: call.tool,
      args: call.args || {}
    });

    if (seen.has(key)) {
      continue;
    }

    seen.add(key);
    result.push(call);
  }

  return result;
}

function extractJsonObjects(content) {
  return extractJsonObjectsWithPositions(content).map((object) => object.text);
}

// Like extractJsonObjectsWithPositions but for top-level [...] arrays, with the same
// string/escape awareness so brackets inside string literals are ignored.
function extractJsonArraysWithPositions(content) {
  const arrays = [];
  let start = -1;
  let depth = 0;
  let inString = false;
  let escaped = false;

  for (let i = 0; i < content.length; i++) {
    const char = content[i];

    if (inString) {
      if (escaped) {
        escaped = false;
      } else if (char === "\\") {
        escaped = true;
      } else if (char === "\"") {
        inString = false;
      }
      continue;
    }

    if (char === "\"") {
      inString = true;
      continue;
    }

    if (char === "[") {
      if (depth === 0) {
        start = i;
      }
      depth += 1;
      continue;
    }

    if (char === "]" && depth > 0) {
      depth -= 1;

      if (depth === 0 && start !== -1) {
        arrays.push({
          text: content.slice(start, i + 1),
          start,
          end: i + 1
        });
        start = -1;
      }
    }
  }

  return arrays;
}

function extractJsonObjectsWithPositions(content) {
  const objects = [];
  let start = -1;
  let depth = 0;
  let inString = false;
  let escaped = false;

  for (let i = 0; i < content.length; i++) {
    const char = content[i];

    if (inString) {
      if (escaped) {
        escaped = false;
      } else if (char === "\\") {
        escaped = true;
      } else if (char === "\"") {
        inString = false;
      }
      continue;
    }

    if (char === "\"") {
      inString = true;
      continue;
    }

    if (char === "{") {
      if (depth === 0) {
        start = i;
      }
      depth += 1;
      continue;
    }

    if (char === "}" && depth > 0) {
      depth -= 1;

      if (depth === 0 && start !== -1) {
        objects.push({
          text: content.slice(start, i + 1),
          start,
          end: i + 1
        });
        start = -1;
      }
    }
  }

  return objects;
}

export { looksLikeIncompleteAnthropicToolCall };
