import { estimateTokens } from "./tokenEstimate.mjs";

export function createChatCompletionResponse({ id, model, created, message, finishReason, usage }) {
  const choice = {
    index: 0,
    message: {
      role: "assistant",
      content: message.content
    },
    finish_reason: finishReason
  };

  if (message.tool_calls) {
    choice.message.tool_calls = message.tool_calls;
  }

  return {
    id,
    object: "chat.completion",
    created,
    model,
    choices: [choice],
    usage: normalizeUsage(usage, message)
  };
}

export function openChatCompletionStream(response, {
  id,
  model,
  created
}) {
  response.writeHead(200, {
    "content-type": "text/event-stream; charset=utf-8",
    "cache-control": "no-cache, no-transform",
    connection: "keep-alive",
    "x-accel-buffering": "no"
  });

  const base = { id, object: "chat.completion.chunk", created, model };

  response.write(formatSse({
    ...base,
    choices: [{ index: 0, delta: { role: "assistant" }, finish_reason: null }]
  }));

  return base;
}

// Build the per-chunk envelope shared by every SSE frame for a single completion stream.
export function streamChunkBase({ id, model, created }) {
  return { id, object: "chat.completion.chunk", created, model };
}

// Write a single content delta chunk verbatim (no word-splitting). Used by the live streaming
// path, which already receives incremental prose slices from the StreamGate. Empty deltas are
// skipped so we never emit a no-op chunk. Returns the number of chars written.
export function writeContentDelta(response, base, text) {
  const delta = typeof text === "string" ? text : "";

  if (!delta) {
    return 0;
  }

  response.write(formatSse({
    ...base,
    choices: [{ index: 0, delta: { content: delta }, finish_reason: null }]
  }));

  return delta.length;
}

// Emit a content body by word-splitting it into multiple deltas (the legacy non-live path used
// for title/error/fallback turns where the full text is already known).
export function writeContentBody(response, base, content) {
  for (const chunk of splitForStreaming(content || "")) {
    writeContentDelta(response, base, chunk);
  }
}

// Emit OpenAI-style tool-call chunks: one header chunk per call (id, name, empty arguments),
// then streamed argument chunks per call.
export function writeToolCallChunks(response, base, tool_calls) {
  if (!Array.isArray(tool_calls) || tool_calls.length === 0) {
    return;
  }

  for (const [i, tc] of tool_calls.entries()) {
    response.write(formatSse({
      ...base,
      choices: [{
        index: 0,
        delta: {
          tool_calls: [{
            index: i,
            id: tc.id,
            type: "function",
            function: { name: tc.function.name, arguments: "" }
          }]
        },
        finish_reason: null
      }]
    }));
  }

  for (const [i, tc] of tool_calls.entries()) {
    for (const chunk of splitForStreaming(tc.function.arguments || "{}")) {
      response.write(formatSse({
        ...base,
        choices: [{
          index: 0,
          delta: { tool_calls: [{ index: i, function: { arguments: chunk } }] },
          finish_reason: null
        }]
      }));
    }
  }
}

// Write the terminal frames of a completion stream: the finish_reason chunk, an optional usage
// chunk, the [DONE] sentinel, and end the response. Safe to call exactly once per stream.
export function finishChatCompletion(response, base, {
  finishReason,
  usage,
  includeUsage = false,
  content,
  tool_calls
}) {
  response.write(formatSse({
    ...base,
    choices: [{ index: 0, delta: {}, finish_reason: finishReason }]
  }));

  if (includeUsage) {
    response.write(formatSse({
      ...base,
      choices: [],
      usage: normalizeUsage(usage, { content, tool_calls })
    }));
  }

  response.write("data: [DONE]\n\n");
  response.end();
}

export function writeChatCompletionBody(response, {
  id,
  model,
  created,
  content,
  tool_calls,
  finishReason,
  usage,
  includeUsage = false
}) {
  const base = streamChunkBase({ id, model, created });

  if (Array.isArray(tool_calls) && tool_calls.length > 0) {
    writeToolCallChunks(response, base, tool_calls);
  } else {
    writeContentBody(response, base, content);
  }

  finishChatCompletion(response, base, {
    finishReason,
    usage,
    includeUsage,
    content,
    tool_calls
  });
}

export async function writeChatCompletionStream(response, options) {
  openChatCompletionStream(response, options);
  writeChatCompletionBody(response, options);
}

function splitForStreaming(text) {
  const matches = text.match(/\S+\s*/g);
  return matches || (text ? [text] : []);
}

function formatSse(payload) {
  return `data: ${JSON.stringify(payload)}\n\n`;
}

function normalizeUsage(usage, message = {}) {
  if (usage && Number.isFinite(usage.prompt_tokens) && Number.isFinite(usage.completion_tokens)) {
    const promptTokens = Math.max(0, Math.ceil(usage.prompt_tokens));
    const completionTokens = Math.max(0, Math.ceil(usage.completion_tokens));
    const totalTokens = Number.isFinite(usage.total_tokens)
      ? Math.max(0, Math.ceil(usage.total_tokens))
      : promptTokens + completionTokens;

    return {
      prompt_tokens: promptTokens,
      completion_tokens: completionTokens,
      total_tokens: totalTokens
    };
  }

  const completionTokens = estimateTokens(message.content || toolCallsForUsage(message.tool_calls));

  return {
    prompt_tokens: 0,
    completion_tokens: completionTokens,
    total_tokens: completionTokens
  };
}

function toolCallsForUsage(toolCalls) {
  return Array.isArray(toolCalls) && toolCalls.length > 0 ? JSON.stringify(toolCalls) : "";
}
