(() => {
const VERSION = "2026-05-25-native-streaming";
const INSTALL_KEY = `__o1CodeBridgePageRecorder_${VERSION}`;
const CONTENT_SOURCE = "o1-code-bridge-content";
const PAGE_SOURCE = "o1-code-bridge-page";
const POST_THROTTLE_MS = 150;
const MAX_EVENTS = 200;

if (window[INSTALL_KEY]) {
  return;
}

window[INSTALL_KEY] = true;

let activeRunId = null;
let verboseRecorder = false;
let sequence = 0;

postStatus("ready");

window.addEventListener("message", (event) => {
  if (event.source !== window || event.data?.source !== CONTENT_SOURCE) {
    return;
  }

  if (event.data.type === "O1_CODE_BRIDGE_RECORDER_RESET") {
    activeRunId = event.data.runId || null;
    verboseRecorder = event.data.verboseRecorder === true;
    sequence = 0;
    postStatus("reset", { runId: activeRunId });
  }
});

const originalFetch = window.fetch?.bind(window);

if (originalFetch) {
  window.fetch = async (...args) => {
    const requestInfo = describeFetchRequest(args);
    const response = await originalFetch(...args);

    if (activeRunId && verboseRecorder) {
      emitObservedRequest(requestInfo, response.status);
    }

    if (activeRunId && shouldRecordRequest(requestInfo)) {
      postStatus("request", { runId: activeRunId, url: requestInfo.url, method: requestInfo.method });
      recordResponse(response, requestInfo).catch((error) => {
        postRecord({
          id: requestInfo.id,
          runId: requestInfo.runId,
          url: requestInfo.url,
          method: requestInfo.method,
          done: true,
          error: error.message
        });
      });
    }

    return response;
  };
}

const OriginalXMLHttpRequest = window.XMLHttpRequest;

if (OriginalXMLHttpRequest?.prototype) {
  const originalOpen = OriginalXMLHttpRequest.prototype.open;
  const originalSend = OriginalXMLHttpRequest.prototype.send;

  OriginalXMLHttpRequest.prototype.open = function open(method, url, ...rest) {
    this.__o1CodeBridgeRequest = {
      id: `xhr_${Date.now()}_${++sequence}`,
      runId: activeRunId,
      url: String(url || location.href),
      method: String(method || "GET").toUpperCase(),
      startedAt: new Date().toISOString()
    };

    return originalOpen.call(this, method, url, ...rest);
  };

  OriginalXMLHttpRequest.prototype.send = function send(...args) {
    const requestInfo = {
      ...(this.__o1CodeBridgeRequest || {
        id: `xhr_${Date.now()}_${++sequence}`,
        url: location.href,
        method: "GET",
        startedAt: new Date().toISOString()
      }),
      runId: activeRunId
    };

    if (activeRunId && verboseRecorder) {
      observeXhr(this, requestInfo);
    }

    if (activeRunId && shouldRecordRequest(requestInfo)) {
      recordXhr(this, requestInfo);
      postStatus("request", { runId: activeRunId, url: requestInfo.url, method: requestInfo.method });
    }

    return originalSend.apply(this, args);
  };
}

function describeFetchRequest(args) {
  const [input, init = {}] = args;
  const method = String(init.method || input?.method || "GET").toUpperCase();
  const url = String(typeof input === "string" ? input : input?.url || location.href);

  return {
    id: `network_${Date.now()}_${++sequence}`,
    runId: activeRunId,
    url,
    method,
    startedAt: new Date().toISOString()
  };
}

function shouldRecordRequest(request) {
  if (typeof window.__o1CodeShouldRecordRequest === "function") {
    try {
      return window.__o1CodeShouldRecordRequest(request);
    } catch {}
  }

  if (request.method !== "POST") {
    return false;
  }

  const requestUrl = String(request.url || "");
  const url = safeUrl(request.url);
  const host = url?.hostname || "";

  return !(
    host.includes("datadoghq") ||
    host.startsWith("dataplane.rum.") ||
    requestUrl.includes("datadoghq") ||
    requestUrl.includes("dataplane.rum.") ||
    requestUrl.includes("/v1/project/") ||
    requestUrl.includes("/v1/tools/") ||
    requestUrl.includes("/v1/oauth/")
  );
}

function safeUrl(value) {
  try {
    return new URL(String(value || ""), typeof location === "undefined" ? "https://open-web-assistant-cs.wpp.ai/" : location.href);
  } catch {
    return null;
  }
}

// Diagnostic-only (verbose): emit EVERY request the recorder observes during an active run —
// including non-POST and otherwise-filtered requests that shouldRecordRequest drops — so a
// failing image turn reveals whether the model/upload request fires as a non-recordable shape
// (e.g. a presigned PUT, or a filtered path) or never fires in this frame at all. Metadata only
// (method/url/status), no body, and gated behind verboseRecorder so normal runs pay nothing.
// The HTTP status is carried as `httpStatus` to avoid colliding with the message-level `status`
// field ("observed") that postStatus sets.
function emitObservedRequest(requestInfo, httpStatus) {
  postStatus("observed", {
    runId: requestInfo.runId || activeRunId,
    url: requestInfo.url,
    method: requestInfo.method,
    httpStatus: typeof httpStatus === "number" ? httpStatus : null
  });
}

function observeXhr(xhr, requestInfo) {
  xhr.addEventListener("loadend", () => {
    emitObservedRequest(requestInfo, xhr.status || null);
  }, { once: true });
}

async function recordResponse(response, requestInfo) {
  const record = createRecord(requestInfo, {
    responseStatus: response.status,
    responseHeaders: headersObject(response.headers)
  });

  postRecord(record);

  const clone = response.clone();
  const contentType = clone.headers.get("content-type") || "";

  if (clone.body && (contentType.includes("text/event-stream") || contentType.includes("application/json"))) {
    await readStream(clone.body, record);
  } else {
    const text = await clone.text();
    appendChunk(record, text);
    parseChunk(record, text);
  }

  record.done = true;
  postRecord(record);
}

function recordXhr(xhr, requestInfo) {
  const record = createRecord(requestInfo);
  let parsedLength = 0;
  let pending = "";

  postRecord(record);

  xhr.addEventListener("readystatechange", () => {
    record.responseStatus = xhr.status || record.responseStatus;
    record.responseHeaders = parseResponseHeaders(xhr.getAllResponseHeaders?.() || "");

    if (xhr.readyState >= XMLHttpRequest.LOADING) {
      const result = readXhrText(xhr, record, parsedLength, pending);
      parsedLength = result.parsedLength;
      pending = result.pending;
    }

    if (xhr.readyState === XMLHttpRequest.DONE) {
      const result = readXhrText(xhr, record, parsedLength, pending);
      parsedLength = result.parsedLength;
      pending = result.pending;
      if (pending.trim()) {
        parseDataLine(record, pending.trim());
        pending = "";
      }
      record.done = true;
      postRecord(record);
    }
  });

  xhr.addEventListener("error", () => {
    record.error = "XMLHttpRequest failed.";
    record.done = true;
    postRecord(record);
  });

  xhr.addEventListener("abort", () => {
    record.error = "XMLHttpRequest aborted.";
    record.done = true;
    postRecord(record);
  });
}

function readXhrText(xhr, record, parsedLength, pending) {
  if (xhr.responseType && xhr.responseType !== "text") {
    return { parsedLength, pending };
  }

  let text = "";

  try {
    text = xhr.responseText || "";
  } catch {
    return { parsedLength, pending };
  }

  if (text.length <= parsedLength) {
    return { parsedLength, pending };
  }

  const chunk = text.slice(parsedLength);
  appendChunk(record, chunk);
  const nextPending = parseChunk(record, pending + chunk);
  postRecord(record);
  return { parsedLength: text.length, pending: nextPending };
}

function createRecord(requestInfo, extra = {}) {
  return {
    ...requestInfo,
    responseStatus: null,
    responseHeaders: {},
    model: null,
    finalText: "",
    finishReason: null,
    events: [],
    chunks: [],
    toolCallParts: {},
    unparsed: [],
    eventCount: 0,
    byteCount: 0,
    done: false,
    error: null,
    ...extra
  };
}

async function readStream(body, record) {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let pending = "";

  while (true) {
    const { value, done } = await reader.read();

    if (done) {
      break;
    }

    const chunk = decoder.decode(value, { stream: true });
    appendChunk(record, chunk);
    pending = parseChunk(record, pending + chunk);
    postRecord(record);
  }

  const tail = decoder.decode();
  if (tail) {
    appendChunk(record, tail);
    pending = parseChunk(record, pending + tail);
  }

  if (pending.trim()) {
    parseDataLine(record, pending.trim());
  }
}

function parseChunk(record, chunk) {
  if (!chunk.includes("data:")) {
    parseDataLine(record, chunk.trim());
    return "";
  }

  const lines = chunk.split(/\r?\n/);
  const trailing = chunk.endsWith("\n") || chunk.endsWith("\r")
    ? ""
    : lines.pop() || "";

  for (const line of lines) {
    if (line.startsWith("data:")) {
      parseDataLine(record, line.slice(5).trim());
    }
  }

  return trailing;
}

function parseDataLine(record, data) {
  if (!data || data === "[DONE]") {
    return;
  }

  try {
    const parsed = JSON.parse(data);
    const event = {
      id: parsed.id || null,
      model: parsed.model || null,
      messageId: parsed.message_id || parsed.messageId || null,
      finishReason: null,
      content: "",
      thinking: "",
      toolCalls: []
    };

    // First non-null model on the stream identifies the responder. For an agent (e.g.
    // OgilvyOneCoder) this reports the agent's underlying base model, so it is observability
    // only — the wrong-agent gate keys off the selected picker label, not this field.
    if (!record.model && event.model) {
      record.model = event.model;
    }

    for (const choice of parsed.choices || []) {
      const delta = choice.delta || {};
      const message = choice.message || {};

      if (typeof delta.content === "string") {
        event.content += delta.content;
        record.finalText += delta.content;
      }

      if (typeof message.content === "string") {
        event.content += message.content;
        record.finalText += message.content;
      }

      if (typeof delta.thinking === "string") {
        event.thinking += delta.thinking;
      }

      if (Array.isArray(delta.tool_calls)) {
        event.toolCalls.push(...delta.tool_calls);
        for (const toolCall of delta.tool_calls) {
          accumulateToolCall(record, toolCall);
        }
      }

      if (Array.isArray(delta.toolCalls)) {
        event.toolCalls.push(...delta.toolCalls);
        for (const toolCall of delta.toolCalls) {
          accumulateToolCall(record, toolCall);
        }
      }

      if (Array.isArray(message.tool_calls)) {
        event.toolCalls.push(...message.tool_calls);
        for (const toolCall of message.tool_calls) {
          accumulateToolCall(record, toolCall);
        }
      }

      if (choice.finish_reason || choice.finishReason) {
        event.finishReason = choice.finish_reason || choice.finishReason;
        record.finishReason = event.finishReason;
      }
    }

    if (event.content || event.thinking || event.toolCalls.length > 0 || event.finishReason) {
      record.events.push(event);
      record.eventCount = (record.eventCount || 0) + 1;

      if (record.events.length > MAX_EVENTS) {
        record.events.splice(0, record.events.length - MAX_EVENTS);
      }
    }
  } catch {
    record.unparsed.push(data);
    if (record.unparsed.length > 50) {
      record.unparsed.splice(0, record.unparsed.length - 50);
    }
  }
}

function accumulateToolCall(record, toolCall) {
  const key = String(toolCall.index ?? toolCall.id ?? 0);
  const existing = record.toolCallParts[key] || {
    id: toolCall.id || null,
    type: toolCall.type || "function",
    name: "",
    arguments: ""
  };
  const fn = toolCall.function || {};

  existing.id = toolCall.id || existing.id;
  existing.type = toolCall.type || existing.type;
  existing.name = fn.name || toolCall.name || existing.name || "";

  if (typeof fn.arguments === "string") {
    existing.arguments += fn.arguments;
  } else if (typeof toolCall.arguments === "string") {
    existing.arguments += toolCall.arguments;
  }

  record.toolCallParts[key] = existing;
}

function headersObject(headers) {
  const result = {};

  for (const [key, value] of headers.entries()) {
    result[key] = value;
  }

  return result;
}

function parseResponseHeaders(value) {
  return String(value || "")
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .reduce((headers, line) => {
      const index = line.indexOf(":");
      if (index > 0) {
        headers[line.slice(0, index).trim().toLowerCase()] = line.slice(index + 1).trim();
      }
      return headers;
    }, {});
}

function appendChunk(record, chunk) {
  record.byteCount = (record.byteCount || 0) + String(chunk || "").length;
  record.chunks.push(chunk);

  if (record.chunks.length > 20) {
    record.chunks.splice(0, record.chunks.length - 20);
  }
}

const postThrottleState = new WeakMap();

// Throttle interim record posts. Each post structured-clones the record across the
// page<->content boundary, so posting on every SSE chunk is O(n^2) over a long stream.
// Non-terminal posts are coalesced to one per POST_THROTTLE_MS (the latest record state
// wins); terminal posts (done/error) flush immediately so the final answer is never
// delayed. Interim posts still carry the live finalText so the content script can salvage
// a partial answer if the stream stalls without a finish reason.
function postRecord(record) {
  if (record.done || record.error) {
    flushRecordPost(record);
    return;
  }

  let state = postThrottleState.get(record);

  if (!state) {
    state = { lastPostAt: 0, timer: null };
    postThrottleState.set(record, state);
  }

  if (state.timer) {
    return;
  }

  const elapsed = Date.now() - state.lastPostAt;

  if (elapsed >= POST_THROTTLE_MS) {
    state.lastPostAt = Date.now();
    postRecordNow(record);
    return;
  }

  state.timer = setTimeout(() => {
    state.timer = null;
    state.lastPostAt = Date.now();
    postRecordNow(record);
  }, POST_THROTTLE_MS - elapsed);
}

function flushRecordPost(record) {
  const state = postThrottleState.get(record);

  if (state?.timer) {
    clearTimeout(state.timer);
    state.timer = null;
  }

  postThrottleState.delete(record);
  postRecordNow(record);
}

function postRecordNow(record) {
  record.updatedAt = new Date().toISOString();
  window.postMessage({
    source: PAGE_SOURCE,
    type: "O1_CODE_BRIDGE_NETWORK_RECORD",
    record: serializeRecord(record, verboseRecorder)
  }, "*");
}

function serializeRecord(record, verbose = false) {
  const counts = {
    chunks: Array.isArray(record.chunks) ? record.chunks.length : 0,
    events: Array.isArray(record.events) ? record.events.length : 0,
    unparsed: Array.isArray(record.unparsed) ? record.unparsed.length : 0,
    eventCount: Number(record.eventCount) || 0,
    byteCount: Number(record.byteCount) || 0
  };
  const compact = {
    id: record.id,
    runId: record.runId,
    url: record.url,
    method: record.method,
    startedAt: record.startedAt,
    updatedAt: record.updatedAt,
    responseStatus: record.responseStatus,
    responseHeaders: record.responseHeaders || {},
    model: record.model || null,
    finalText: record.finalText || "",
    finishReason: record.finishReason || null,
    toolCallParts: record.toolCallParts || {},
    eventCount: counts.eventCount,
    byteCount: counts.byteCount,
    chunkCount: counts.chunks,
    unparsedCount: counts.unparsed,
    counts,
    done: Boolean(record.done),
    error: record.error || null
  };

  if (verbose) {
    compact.chunks = record.chunks || [];
    compact.events = record.events || [];
    compact.unparsed = record.unparsed || [];
  }

  return compact;
}

function postStatus(status, extra = {}) {
  window.postMessage({
    source: PAGE_SOURCE,
    type: "O1_CODE_BRIDGE_RECORDER_STATUS",
    status,
    ...extra
  }, "*");
}

if (globalThis.__O1_CODE_BRIDGE_TEST_HOOKS__ && globalThis.process?.versions?.node) {
  globalThis.__o1CodeBridgePageRecorderTest = {
    createRecord,
    shouldRecordRequest,
    emitObservedRequest,
    parseChunk,
    parseDataLine,
    accumulateToolCall,
    postRecord,
    appendChunk,
    serializeRecord,
    windowForTest: window
  };
}
})();
