import { estimateTokens, estimateImageTokens } from "./tokenEstimate.mjs";

export function buildContextMetrics(body = {}, { prompt = "", serializableMessages = [], images = [] } = {}) {
  const requestJson = safeJsonStringify(body);
  const toolsJson = safeJsonStringify(body.tools || []);
  const allMessages = Array.isArray(body.messages) ? body.messages : [];
  const promptMetrics = textMetrics(prompt);
  const imageTokens = estimateImageTokens(images);

  return {
    model: body.model || null,
    stream: Boolean(body.stream),
    request: textMetrics(requestJson),
    prompt: promptMetrics,
    // Structured input estimate the context-window gauge should consume: the serialized prompt
    // (system + tools + messages, exactly what we send the model) plus a flat per-image cost.
    // NOT request JSON — that counts brace/quote/field-name overhead the model never sees.
    input: {
      estimatedTokens: promptMetrics.estimatedTokens + imageTokens,
      imageTokens
    },
    messages: {
      total: allMessages.length,
      serialized: serializableMessages.length,
      byRole: countByRole(allMessages),
      serializedByRole: countByRole(serializableMessages),
      entries: allMessages.map((message, index) => messageMetrics(message, index)),
      serializedEntries: serializableMessages.map((message, index) => messageMetrics(message, index))
    },
    tools: {
      count: Array.isArray(body.tools) ? body.tools.length : 0,
      schema: textMetrics(toolsJson)
    },
    images: {
      count: images.length,
      totalBytes: images.reduce((total, image) => total + (Number(image.sizeBytes) || 0), 0)
    },
    requestedLimits: {
      max_tokens: numberOrNull(body.max_tokens),
      max_completion_tokens: numberOrNull(body.max_completion_tokens),
      temperature: numberOrNull(body.temperature),
      top_p: numberOrNull(body.top_p)
    }
  };
}

export function buildResponseMetrics({ finalText = "", normalizedContent = "", toolCalls = [] } = {}) {
  const toolArguments = Array.isArray(toolCalls)
    ? toolCalls.map((call) => call?.function?.arguments || "").join("")
    : "";

  return {
    rawFinalText: textMetrics(finalText),
    assistantContent: textMetrics(normalizedContent || ""),
    toolCalls: {
      count: Array.isArray(toolCalls) ? toolCalls.length : 0,
      arguments: textMetrics(toolArguments)
    }
  };
}

function messageMetrics(message = {}, index) {
  const contentText = stringifyContentForMetrics(message.content);
  const toolCallsJson = safeJsonStringify(message.tool_calls || []);

  return {
    index,
    role: message.role || null,
    content: textMetrics(contentText),
    contentParts: Array.isArray(message.content) ? message.content.length : null,
    toolCalls: {
      count: Array.isArray(message.tool_calls) ? message.tool_calls.length : 0,
      schema: textMetrics(toolCallsJson)
    },
    hasToolCallId: Boolean(message.tool_call_id)
  };
}

function textMetrics(text) {
  const value = String(text || "");

  return {
    chars: value.length,
    estimatedTokens: estimateTokens(value)
  };
}

function stringifyContentForMetrics(content) {
  if (typeof content === "string") {
    return content;
  }

  if (Array.isArray(content)) {
    return content.map((part) => {
      if (typeof part === "string") {
        return part;
      }

      if (part?.type === "text") {
        return part.text || "";
      }

      if (part?.type === "image_url") {
        return "[image_url]";
      }

      return safeJsonStringify(part);
    }).join("\n");
  }

  if (content == null) {
    return "";
  }

  return safeJsonStringify(content);
}

function countByRole(messages) {
  const counts = {};

  for (const message of messages) {
    const role = message?.role || "unknown";
    counts[role] = (counts[role] || 0) + 1;
  }

  return counts;
}

function numberOrNull(value) {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function safeJsonStringify(value) {
  try {
    return JSON.stringify(value ?? null);
  } catch {
    return "";
  }
}
