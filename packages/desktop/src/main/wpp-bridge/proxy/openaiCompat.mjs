import { serializeChatCompletionRequest, serializableMessagesForRequest } from "./messageSerializer.mjs";
import { extensionBridge } from "./extensionBridge.mjs";
import { chooseAssistantResponse } from "./toolCallNormalizer.mjs";
import { StreamGate } from "./streamGate.mjs";
import {
  createChatCompletionResponse,
  openChatCompletionStream,
  writeChatCompletionBody,
  writeChatCompletionStream,
  streamChunkBase,
  writeContentDelta,
  writeContentBody,
  writeToolCallChunks,
  finishChatCompletion
} from "./streamAdapter.mjs";
import { writeRunLog } from "./logging.mjs";
import { redact } from "./policy.mjs";
import { collectImageInputs } from "./imageInputs.mjs";
import { buildContextMetrics, buildResponseMetrics } from "./contextMetrics.mjs";
import { estimateTokens } from "./tokenEstimate.mjs";
import { MODEL_IDS, resolveModelProfile } from "./modelProfiles.mjs";

const OOC_TOOL_MODEL_ID = "o1-code";
const DEFAULT_MAX_PROMPT_CHARS = 600000;
const STREAM_KEEP_ALIVE_MS = 10000;

// Stable anchors from OpenCode's compaction prompt (packages/core/src/session/compaction.ts),
// confirmed against a captured /compact run log. Both live in the LAST user message.
const COMPACTION_PROMPT_ANCHORS = [
  "Output exactly the Markdown structure shown inside",
  "Do not mention the summary process"
];

function maxPromptChars() {
  const configured = Number(process.env.O1_CODE_MAX_PROMPT_CHARS);
  return Number.isFinite(configured) && configured > 0 ? configured : DEFAULT_MAX_PROMPT_CHARS;
}

function promptTooLargeMessage(prompt) {
  return `Serialized prompt is ${prompt.length} chars, over the ${maxPromptChars()} char cap `
    + "(O1_CODE_MAX_PROMPT_CHARS). Reduce the conversation/context or raise the cap.";
}

// Image attachments come only from the latest user turn (see handleChatCompletions).
function latestUserMessages(body) {
  const messages = Array.isArray(body?.messages) ? body.messages : [];

  for (let index = messages.length - 1; index >= 0; index -= 1) {
    if (messages[index]?.role === "user") {
      return [messages[index]];
    }
  }

  return [];
}

export function listModels() {
  return {
    object: "list",
    data: MODEL_IDS.map((id) => ({
      id,
      object: "model",
      created: 0,
      owned_by: "o1-code"
    }))
  };
}

export async function handleChatCompletions(request, response, body, { bridge = extensionBridge } = {}) {
  const id = `chatcmpl_${crypto.randomUUID().replace(/-/g, "")}`;
  const created = Math.floor(Date.now() / 1000);
  const model = body.model || OOC_TOOL_MODEL_ID;
  const startedAt = new Date().toISOString();
  const target = body.o1_code_target || "coding-agent";

  response.setHeader("x-o1-code-proxy-run-id", id);

  if (isTitleGenerationRequest(body)) {
    const prompt = serializeChatCompletionRequest(body, { provenance: false });
    const message = {
      content: generateLocalTitle(body),
      tool_calls: undefined,
      finish_reason: "stop"
    };
    const usage = buildUsage({
      promptTokens: estimateTokens(prompt),
      completionText: message.content
    });

    if (body.stream) {
      await writeChatCompletionStream(response, {
        id,
        model,
        created,
        content: message.content,
        tool_calls: undefined,
        finishReason: "stop",
        usage,
        includeUsage: shouldIncludeStreamUsage(body)
      });
      return;
    }

    writeJson(response, 200, createChatCompletionResponse({
      id,
      model,
      created,
      message,
      finishReason: "stop",
      usage
    }));
    return;
  }

  const isCompaction = isCompactionRequest(body);
  const serializableMessages = serializableMessagesForRequest(body);
  const prompt = serializeChatCompletionRequest(body, { provenance: !isCompaction });
  // The full conversation is replayed, but images are only attached for the
  // latest user turn — earlier images remain text placeholders in the serialized history.
  const images = collectImageInputs(latestUserMessages(body));
  const context = buildContextMetrics(body, { prompt, serializableMessages, images });

  if (prompt.length > maxPromptChars()) {
    const logPath = await writeRunLog({
      id,
      startedAt,
      finishedAt: new Date().toISOString(),
      request: redact(body),
      prompt: `${prompt.slice(0, 2000)}…[truncated for log]`,
      context,
      images: imageLogSummary(images),
      error: {
        message: promptTooLargeMessage(prompt),
        type: "o1_code_prompt_too_large",
        statusCode: 413
      }
    });

    if (logPath) {
      response.setHeader("x-o1-code-proxy-log", logPath);
    }

    writeJson(response, 413, {
      error: {
        message: promptTooLargeMessage(prompt),
        type: "o1_code_prompt_too_large",
        promptChars: prompt.length,
        maxPromptChars: maxPromptChars(),
        estimatedTokens: context.input.estimatedTokens,
        log: logPath || undefined,
        run_id: id
      }
    });
    return;
  }

  const streamBase = streamChunkBase({ id, model, created });
  // Live streaming is gated off for compaction: its summary must be sanitized as a whole
  // (sanitizeCompactionSummary) before any text is emitted, so we never stream it incrementally.
  const streamSession = body.stream && !isCompaction ? createStreamSession() : null;

  const bridgeOptions = {
    timeoutMs: body.o1_code_timeout_ms,
    target,
    url: body.o1_code_url,
    // Route by the OpenAI model id (o1-code -> OgilvyOneCoder, o1-code-builder ->
    // OgilvyOneCoder_Builder). An explicit o1_code_model still overrides the mapping.
    model: body.o1_code_model || resolveModelProfile(model).agentName,
    images,
    // React to live progress frames by streaming prose deltas as they land. The bridge owns the
    // subscription lifecycle (subscribe on enqueue, unsubscribe when the job settles), so a late
    // frame can't interleave a stray delta after the turn is done.
    onProgress: streamSession
      ? (frame) => {
          const { delta } = streamSession.update(frame.finalText);
          if (delta) {
            writeContentDelta(response, streamBase, delta);
          }
        }
      : undefined
  };
  let o1CodeRun;

  if (body.stream) {
    openChatCompletionStream(response, { id, model, created });

    try {
      o1CodeRun = await waitForBridgeWithKeepAlive(bridge.run(prompt, bridgeOptions), response);
    } catch (error) {
      await writeRunLog({
        id,
        startedAt,
        finishedAt: new Date().toISOString(),
        request: redact(body),
        prompt,
        context,
        images: imageLogSummary(images),
        error: {
          message: error.message,
          type: error.type || "o1_code_proxy_error",
          statusCode: error.statusCode || 500
        },
        bridgeResult: error.bridgeResult ? redact(error.bridgeResult) : undefined
      }).catch(() => null);

      // If prose was already streamed live we can't restart the turn cleanly, so append the
      // error as a trailing content delta and close. Otherwise emit it as the whole body.
      if (streamSession && streamSession.hasStreamed()) {
        writeContentDelta(response, streamBase, `\n\n${error.message}`);
        finishChatCompletion(response, streamBase, {
          finishReason: "stop",
          usage: buildUsage({
            promptTokens: context.input.estimatedTokens,
            completionText: error.message
          }),
          includeUsage: shouldIncludeStreamUsage(body)
        });
      } else {
        writeChatCompletionBody(response, {
          id,
          model,
          created,
          content: error.message,
          finishReason: "stop",
          usage: buildUsage({
            promptTokens: context.input.estimatedTokens,
            completionText: error.message
          }),
          includeUsage: shouldIncludeStreamUsage(body)
        });
      }
      return;
    }
  } else {
    try {
      o1CodeRun = await bridge.run(prompt, bridgeOptions);
    } catch (error) {
      const logPath = await writeRunLog({
        id,
        startedAt,
        finishedAt: new Date().toISOString(),
        request: redact(body),
        prompt,
        context,
        images: imageLogSummary(images),
        error: {
          message: error.message,
          type: error.type || "o1_code_proxy_error",
          statusCode: error.statusCode || 500
        },
        bridgeResult: error.bridgeResult ? redact(error.bridgeResult) : undefined
      });

      if (logPath) {
        response.setHeader("x-o1-code-proxy-log", logPath);
      }

      writeJson(response, error.statusCode || 500, {
        error: {
          message: error.message,
          type: error.type || "o1_code_proxy_error",
          log: logPath || undefined,
          run_id: id
        }
      });
      return;
    }
  }
  const finalText = o1CodeRun.response.finalText;
  const toolCallParts = o1CodeRun.response.toolCallParts;
  // Compaction summaries must be returned as clean content (no tool_calls) so OpenCode
  // renders them as an invisible summary instead of a visible assistant/tool-calling turn.
  const normalized = isCompaction
    ? {
        content: sanitizeCompactionSummary(finalText, toolCallParts),
        tool_calls: undefined,
        finish_reason: "stop"
      }
    : chooseAssistantResponse(finalText, toolCallParts);
  if (!isCompaction) {
    normalizeToolCallArguments(normalized.tool_calls, body.tools);
  }
  const finishReason = normalized.finish_reason || o1CodeRun.request?.finishReason || "stop";
  const responseMetrics = buildResponseMetrics({
    finalText,
    normalizedContent: normalized.content || "",
    toolCalls: normalized.tool_calls || []
  });
  const usage = buildUsage({
    promptTokens: context.input.estimatedTokens,
    completionText: assistantOutputForUsage(normalized)
  });

  const logRecord = {
    id,
    startedAt,
    finishedAt: new Date().toISOString(),
    request: redact(body),
    prompt,
    context,
    responseMetrics,
    images: imageLogSummary(images),
    o1Code: o1CodeRun,
    response: {
      content: normalized.content,
      tool_calls: normalized.tool_calls,
      finishReason,
      usage
    }
  };
  const logPath = body.stream
    ? await writeRunLog(logRecord).catch(() => null)
    : await writeRunLog(logRecord);

  if (logPath && !body.stream) {
    response.setHeader("x-o1-code-proxy-log", logPath);
  }

  if (body.stream) {
    if (streamSession) {
      finalizeStreamedCompletion(response, streamBase, {
        streamSession,
        normalized,
        finishReason,
        usage,
        includeUsage: shouldIncludeStreamUsage(body)
      });
      return;
    }

    // No live session (compaction): emit the sanitized content as a whole body.
    writeChatCompletionBody(response, {
      id,
      model,
      created,
      content: normalized.content || "",
      tool_calls: normalized.tool_calls,
      finishReason,
      usage,
      includeUsage: shouldIncludeStreamUsage(body)
    });
    return;
  }

  writeJson(response, 200, createChatCompletionResponse({
    id,
    model,
    created,
    message: normalized,
    finishReason,
    usage
  }));
}

export async function waitForBridgeWithKeepAlive(bridgePromise, response, intervalMs = STREAM_KEEP_ALIVE_MS) {
  const timer = setInterval(() => {
    response.write(": keep-alive\n\n");
  }, intervalMs);

  timer.unref?.();

  try {
    return await bridgePromise;
  } finally {
    clearInterval(timer);
  }
}

// Wrap a StreamGate with the small amount of session state the SSE handler needs: a `streamed`
// flag (did we ever emit a live prose delta?) and the trailing diff at finalize (the authoritative
// content past what we've already sent). The gate itself owns the prose-vs-tool-call decision, the
// incremental slicing, and the emitted-char cursor.
function createStreamSession() {
  const gate = new StreamGate();
  let streamed = false;

  return {
    // Feed the latest cumulative text-so-far; returns the incremental prose delta to emit (empty
    // while undecided/suppressed). Records that we've streamed once any delta is produced.
    update(cumulativeText) {
      const result = gate.update(cumulativeText);
      if (result.delta) {
        streamed = true;
      }
      return result;
    },
    // True once at least one live prose delta has been written to the client.
    hasStreamed() {
      return streamed;
    },
    // Given the authoritative normalized content, return the part not yet emitted live — the
    // trailing diff to flush at finalize. The emitted-char cursor stays inside the gate.
    trailingDiff(finalContent) {
      return gate.trailingDiff(finalContent);
    },
    get state() {
      return gate.state;
    }
  };
}

// Close out a streamed completion using the authoritative normalized result. Three shapes:
//  1. tool_calls → the gate suppressed all live prose; emit structured tool-call chunks.
//  2. prose already streamed live → emit only the trailing diff (normalized content past what we
//     already sent), so the client isn't sent duplicate text.
//  3. nothing streamed yet (short/undecided prose, or a leading-brace turn the normalizer decided
//     was content after all) → emit the whole content body.
// Always terminates the stream via finishChatCompletion. The caller must unsubscribe from progress
// BEFORE calling this so a late frame can't interleave a delta after finish_reason.
function finalizeStreamedCompletion(response, streamBase, {
  streamSession,
  normalized,
  finishReason,
  usage,
  includeUsage
}) {
  const tool_calls = normalized.tool_calls;
  const content = normalized.content || "";

  if (Array.isArray(tool_calls) && tool_calls.length > 0) {
    writeToolCallChunks(response, streamBase, tool_calls);
  } else if (streamSession.hasStreamed()) {
    // Emit the authoritative content past what we've already streamed live.
    const trailing = streamSession.trailingDiff(content);
    if (trailing) {
      writeContentDelta(response, streamBase, trailing);
    }
  } else {
    writeContentBody(response, streamBase, content);
  }

  finishChatCompletion(response, streamBase, {
    finishReason,
    usage,
    includeUsage,
    content,
    tool_calls
  });
}

function buildUsage({ promptTokens, completionText }) {
  const prompt = Math.max(0, Math.ceil(Number(promptTokens) || 0));
  const completion = estimateTokens(completionText || "");

  return {
    prompt_tokens: prompt,
    completion_tokens: completion,
    total_tokens: prompt + completion
  };
}

function assistantOutputForUsage(message = {}) {
  const parts = [];

  if (message.content) {
    parts.push(message.content);
  }

  if (Array.isArray(message.tool_calls) && message.tool_calls.length > 0) {
    parts.push(JSON.stringify(message.tool_calls));
  }

  return parts.join("\n");
}

function shouldIncludeStreamUsage(body) {
  return body?.stream_options?.include_usage === true;
}

function imageLogSummary(images) {
  return images.map((image) => ({
    id: image.id,
    name: image.name,
    mimeType: image.mimeType,
    sizeBytes: image.sizeBytes
  }));
}

export function normalizeToolCallArguments(toolCalls, tools = []) {
  if (!Array.isArray(toolCalls) || toolCalls.length === 0) {
    return;
  }

  const toolSchema = new Map(tools.map((tool) => {
    const fn = tool?.function || tool;
    return [fn?.name, fn?.parameters?.properties || {}];
  }));

  for (const call of toolCalls) {
    const name = call?.function?.name;
    const properties = toolSchema.get(name) || {};
    let args;

    try {
      args = JSON.parse(call.function.arguments || "{}");
    } catch {
      continue;
    }

    if (properties.filePath && args.path && !args.filePath) {
      args.filePath = args.path;
      delete args.path;
    }

    if (properties.oldString && args.old && !args.oldString) {
      args.oldString = args.old;
      delete args.old;
    }

    if (properties.newString && args.new && !args.newString) {
      args.newString = args.new;
      delete args.new;
    }

    if (name === "bash" && properties.description && args.command && !args.description) {
      args.description = describeShellCommand(args.command);
    }

    call.function.arguments = JSON.stringify(args);
  }
}

export function isCompactionRequest(body) {
  // Compaction is sent with empty/absent tools (noTools corroboration).
  if (Array.isArray(body?.tools) && body.tools.length > 0) {
    return false;
  }

  const messages = Array.isArray(body?.messages) ? body.messages : [];
  let lastUserContent = null;

  for (let index = messages.length - 1; index >= 0; index -= 1) {
    if (messages[index]?.role === "user") {
      lastUserContent = stringContent(messages[index].content);
      break;
    }
  }

  if (!lastUserContent) {
    return false;
  }

  // Both anchors must appear in the LAST user message (confirmed against a captured log).
  return COMPACTION_PROMPT_ANCHORS.every((anchor) => lastUserContent.includes(anchor));
}

// Compaction summaries must come back as clean Markdown so OpenCode renders them as an
// invisible summary. The OgilvyOneCoder persona habitually emits tool-call XML/JSON and
// chatter; strip that so the summary isn't parsed into a tool-calling turn.
export function sanitizeCompactionSummary(finalText, toolCallParts = {}) {
  let text = typeof finalText === "string" ? finalText : "";

  // Drop fenced blocks that wrap tool-call XML (so no empty code fence remains).
  text = text.replace(/\x60{3}[a-zA-Z]*\s*<function_calls>[\s\S]*?<\/function_calls>\s*\x60{3}/gi, "");
  // Drop complete Anthropic-style tool-call XML blocks.
  text = text.replace(/<function_calls>[\s\S]*?<\/function_calls>/gi, "");
  // Drop a stray unterminated tool-call XML trailer.
  text = text.replace(/<function_calls>[\s\S]*$/i, "");
  // Drop trailing tool-call JSON objects (e.g. {"type":"tool_call","tool":"..."}).
  text = text.replace(/\{[^{}]*"type"\s*:\s*"tool_call"[\s\S]*?\}\s*$/g, "");

  text = text.trim();

  return text;
}

export function isTitleGenerationRequest(body) {
  return Array.isArray(body?.messages)
    && body.messages.some((message) =>
      message?.role === "system"
      && /You are a title generator\./i.test(stringContent(message.content))
    );
}

export function generateLocalTitle(body) {
  const latestUserText = Array.isArray(body?.messages)
    ? body.messages
      .filter((message) => message?.role === "user")
      .map((message) => stringContent(message.content).trim())
      .filter(Boolean)
      .at(-1)
    : "";
  const title = summarizeTitleText(latestUserText || "Conversation");

  return title || "Conversation";
}

function summarizeTitleText(text) {
  const normalized = String(text || "")
    .replace(/\s+/g, " ")
    .replace(/^generate a title for this conversation:\s*/i, "")
    .trim();

  if (!normalized) {
    return "Conversation";
  }

  if (/^(hi|hello|hey|yo|howdy|what'?s up)[.!?]*$/i.test(normalized)) {
    return "Greeting";
  }

  const words = normalized
    .replace(/[^A-Za-z0-9\s._:/-]/g, "")
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 6);

  if (words.length === 0) {
    return "Conversation";
  }

  const title = words.join(" ");

  return title.length > 60 ? `${title.slice(0, 57).trim()}...` : title;
}

function stringContent(content) {
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

      return "";
    }).join("\n");
  }

  if (content == null) {
    return "";
  }

  return String(content);
}

function describeShellCommand(command) {
  const text = String(command).trim();

  if (text === "pwd") {
    return "Print the current working directory";
  }

  if (text.startsWith("ls")) {
    return "List files";
  }

  if (text.startsWith("rg ")) {
    return "Search repository contents";
  }

  if (text.startsWith("cat ")) {
    return "Print file contents";
  }

  return text.length > 80 ? `Run shell command: ${text.slice(0, 77)}...` : `Run shell command: ${text}`;
}

export function writeJson(response, statusCode, payload) {
  response.writeHead(statusCode, { "content-type": "application/json; charset=utf-8" });
  response.end(`${JSON.stringify(payload, null, 2)}\n`);
}
