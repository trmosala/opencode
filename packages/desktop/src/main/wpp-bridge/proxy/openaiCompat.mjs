import { serializeChatCompletionRequest, serializableMessagesForRequest } from "./messageSerializer.mjs";
import { decideThreadMode, commitThread, resetThread, threadContinuityEnabled } from "./sessionThreads.mjs";
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

// OpenCode tags every model call with its session id (packages/opencode/src/session/llm/request.ts):
// `x-session-affinity` + `X-Session-Id` for plain providers, `x-opencode-session` for opencode ones.
// Node lowercases header names. First present wins; "" when none (no pinning, agent affinity only).
function sessionIdFromHeaders(headers = {}) {
  for (const name of ["x-session-affinity", "x-opencode-session", "x-session-id"]) {
    const value = headers[name];
    if (typeof value === "string" && value.trim()) return value.trim();
  }
  return "";
}

// A sub-agent (child) session carries x-parent-session-id (OpenCode sets it from session.parentID,
// see request.ts); a top-level interactive session never does. Sub-agents are throw-away, so the
// pool reaps their pinned tabs on a shorter TTL.
function hasParentSession(headers = {}) {
  const value = headers["x-parent-session-id"];
  return typeof value === "string" && value.trim().length > 0;
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

  // Route by the OpenAI model id (o1-code -> OgilvyOneCoder, o1-code-builder ->
  // OgilvyOneCoder_Builder). An explicit o1_code_model still overrides the mapping.
  const agentName = body.o1_code_model || resolveModelProfile(model).agentName;
  // OpenCode tags every call with its session id (request.ts). Pin session+agent to one WPP worker
  // tab so its thread holds context across turns; a mid-session model switch forks a new thread.
  // Compaction is a one-shot summarization: route it to an unpinned worker (sessionKey "") so it
  // never New-Chats and wipes the live thread, and always serialize it fresh.
  const sessionId = sessionIdFromHeaders(request.headers);
  const sessionKey = isCompaction || !sessionId ? "" : `${sessionId}::${agentName}`;
  // Sub-agent turns are still pinned (so the sub-agent keeps thread continuity across its own run)
  // but the pool reaps their tabs sooner — they never resume once the sub-agent returns.
  const subagent = Boolean(sessionKey) && hasParentSession(request.headers);
  const continuity = Boolean(sessionKey) && threadContinuityEnabled();
  // "continue" forwards only the new turn into the live thread; "fresh" replays the whole transcript
  // into a New Chat (first turn, prefix mismatch from a retry/edit/compaction, or a dead tab).
  const thread = continuity
    ? decideThreadMode(sessionKey, body, bridge.hasSession(sessionKey))
    : { mode: "fresh", sinceIndex: 0 };
  const continueThread = thread.mode === "continue";
  let prompt = serializeChatCompletionRequest(body, { provenance: !isCompaction, sinceIndex: thread.sinceIndex });
  // The full conversation is replayed, but images are only attached for the
  // latest user turn — earlier images remain text placeholders in the serialized history.
  const images = collectImageInputs(latestUserMessages(body));
  let context = buildContextMetrics(body, { prompt, serializableMessages, images });

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
  let streamSession = body.stream && !isCompaction ? createStreamSession() : null;

  const bridgeOptionsFor = (runContinueThread) => ({
    timeoutMs: body.o1_code_timeout_ms,
    target,
    url: body.o1_code_url,
    model: agentName,
    sessionKey,
    subagent,
    continueThread: runContinueThread,
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
  });
  const runBridgeTurn = (runPrompt, runContinueThread) => {
    const run = bridge.run(runPrompt, bridgeOptionsFor(runContinueThread));
    return body.stream ? waitForBridgeWithKeepAlive(run, response) : run;
  };
  const freshRetryPrompt = () => {
    const value = serializeChatCompletionRequest(body, { provenance: !isCompaction, sinceIndex: 0 });
    if (value.length <= maxPromptChars()) return value;
    const error = new Error(promptTooLargeMessage(value));
    error.statusCode = 413;
    error.type = "o1_code_prompt_too_large";
    throw error;
  };
  let retryCount = 0;
  let o1CodeRun;

  if (body.stream) {
    openChatCompletionStream(response, { id, model, created });

    try {
      o1CodeRun = await runBridgeTurn(prompt, continueThread);
    } catch (error) {
      let failure = error;
      if (shouldRetryFreshReplay(error, { streamSession, isCompaction })) {
        if (continuity) resetThread(sessionKey);
        retryCount = 1;
        prompt = freshRetryPrompt();
        context = buildContextMetrics(body, { prompt, serializableMessages, images });
        streamSession = createStreamSession();
        try {
          o1CodeRun = await runBridgeTurn(prompt, false);
          failure = null;
        } catch (retryError) {
          failure = retryError;
        }
      }
      if (failure) {
        // The thread may be in an unknown state (incl. content.js's o1_code_thread_desync) — drop the
        // watermark so the next turn replays fresh rather than extending a delta we can't trust.
        if (continuity) resetThread(sessionKey);
        // Retry exhausted: if the live WPP session is actually logged out, surface that (and pop SSO)
        // instead of a bare capture/recorder error.
        failure = await loginRequiredFailure(bridge, failure);
        await writeRunLog({
          id,
          startedAt,
          finishedAt: new Date().toISOString(),
          request: redact(body),
          prompt,
          context,
          images: imageLogSummary(images),
          error: {
            message: failure.message,
            type: failure.type || "o1_code_proxy_error",
            statusCode: failure.statusCode || 500,
            kind: failure.kind || undefined,
            capture: failure.capture || failure.diagnostics?.capture || undefined,
            retryCount
          },
          bridgeResult: failure.bridgeResult ? redact(failure.bridgeResult) : undefined
        }).catch(() => null);

        // If prose was already streamed live we can't restart the turn cleanly, so append the
        // error as a trailing content delta and close. Otherwise emit it as the whole body.
        if (streamSession && streamSession.hasStreamed()) {
          writeContentDelta(response, streamBase, `\n\n${failure.message}`);
          finishChatCompletion(response, streamBase, {
            finishReason: "stop",
            usage: buildUsage({
              promptTokens: context.input.estimatedTokens,
              completionText: failure.message
            }),
            includeUsage: shouldIncludeStreamUsage(body)
          });
        } else {
          writeChatCompletionBody(response, {
            id,
            model,
            created,
            content: failure.message,
            finishReason: "stop",
            usage: buildUsage({
              promptTokens: context.input.estimatedTokens,
              completionText: failure.message
            }),
            includeUsage: shouldIncludeStreamUsage(body)
          });
        }
        return;
      }
    }
  } else {
    try {
      o1CodeRun = await runBridgeTurn(prompt, continueThread);
    } catch (error) {
      let failure = error;
      if (shouldRetryFreshReplay(error, { streamSession, isCompaction })) {
        if (continuity) resetThread(sessionKey);
        retryCount = 1;
        prompt = freshRetryPrompt();
        context = buildContextMetrics(body, { prompt, serializableMessages, images });
        try {
          o1CodeRun = await runBridgeTurn(prompt, false);
          failure = null;
        } catch (retryError) {
          failure = retryError;
        }
      }
      if (failure) {
        if (continuity) resetThread(sessionKey);
        // Retry exhausted: if the live WPP session is actually logged out, surface that (and pop SSO)
        // instead of a bare capture/recorder error.
        failure = await loginRequiredFailure(bridge, failure);
        const logPath = await writeRunLog({
          id,
          startedAt,
          finishedAt: new Date().toISOString(),
          request: redact(body),
          prompt,
          context,
          images: imageLogSummary(images),
          error: {
            message: failure.message,
            type: failure.type || "o1_code_proxy_error",
            statusCode: failure.statusCode || 500,
            kind: failure.kind || undefined,
            capture: failure.capture || failure.diagnostics?.capture || undefined,
            retryCount
          },
          bridgeResult: failure.bridgeResult ? redact(failure.bridgeResult) : undefined
        });

        if (logPath) {
          response.setHeader("x-o1-code-proxy-log", logPath);
        }

        writeJson(response, failure.statusCode || 500, {
          error: {
            message: failure.message,
            type: failure.type || "o1_code_proxy_error",
            kind: failure.kind || undefined,
            capture: failure.capture || failure.diagnostics?.capture || undefined,
            retryCount,
            log: logPath || undefined,
            run_id: id
          }
        });
        return;
      }
    }
  }
  // The tab now holds the full current transcript — record it as the baseline so the next turn can
  // forward just its delta. Skipped for compaction/no-session (sessionKey "" -> continuity false).
  if (continuity) commitThread(sessionKey, body);

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
  // Prefer WPP's real cumulative token count (scraped from the conversation pill) for the prompt
  // side; fall back to the heuristic when the pill was absent/unparseable for this turn.
  const tokenPill = o1CodeRun.response?.usage;
  const usage = buildUsage({
    promptTokens: context.input.estimatedTokens,
    completionText: assistantOutputForUsage(normalized),
    realPromptTokens: Number.isFinite(tokenPill?.cumulativeTokens) ? tokenPill.cumulativeTokens : undefined
  });

  // Per-turn capture path: "network" = byte-exact recorder, "dom" = innerText DOM fallback, which is
  // whitespace-lossy and thus unreliable for byte-sensitive tool-call output. Promoted to a top-level
  // log field (instead of being buried in o1Code) so a failing turn can be attributed at a glance.
  const responseSource = o1CodeRun.response?.source || null;
  const capture = o1CodeRun.response?.capture || o1CodeRun.extension?.capture || null;
  const lowFidelity = responseSource === "dom" || capture?.lowFidelity === true;

  const logRecord = {
    id,
    startedAt,
    finishedAt: new Date().toISOString(),
    request: redact(body),
    prompt,
    context,
    responseSource,
    lowFidelity,
    capture: capture ? { ...capture, retryCount } : null,
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

  // Streaming already flushed its head, so headers can only be attached on the non-stream path; the
  // run log still records responseSource for streaming turns either way.
  if (!body.stream) {
    if (responseSource) response.setHeader("x-o1-code-response-source", responseSource);
    if (logPath) response.setHeader("x-o1-code-proxy-log", logPath);
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

// Failure types that one fresh replay can heal. All three are duplicate-safe to retry: a capture
// failure means the witness couldn't corroborate a trusted response (no usable answer was returned),
// and both recorder-not-armed and thread-desync are raised PRE-submit (no model request was sent).
// The retry path resets thread continuity and replays the full transcript into a fresh worker.
const FRESH_REPLAY_RETRY_TYPES = new Set([
  "o1_code_capture_failure",
  "o1_code_recorder_not_armed",
  "o1_code_thread_desync",
]);

export function shouldRetryFreshReplay(error, { streamSession, isCompaction }) {
  return FRESH_REPLAY_RETRY_TYPES.has(error?.type)
    && !isCompaction
    && !(streamSession && streamSession.hasStreamed());
}

// After a turn (and its one fresh replay) has failed, probe whether the real cause is a logged-out
// WPP session. When it is, mark auth-required (pops the SSO window via the bridge's fire-once edge)
// and return a typed wpp_auth_required error so the operator is told to log in instead of seeing a
// bare capture/recorder failure. Returns the original failure unchanged when already auth-typed, the
// session looks logged in, or the bridge can't probe (e.g. test doubles without checkAuthState).
async function loginRequiredFailure(bridge, failure) {
  if (failure?.type === "wpp_auth_required") return failure;

  const probe = bridge.checkAuthState?.();
  const reason = probe ? await probe.catch(() => null) : null;
  if (!reason) return failure;

  bridge.markAuthRequired?.(reason);
  const error = new Error(`WPP login required: ${reason}. Original failure: ${failure.message}`);
  error.statusCode = 401;
  error.type = "wpp_auth_required";
  error.diagnostics = failure.diagnostics || undefined;
  return error;
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

// `realPromptTokens`, when finite, is WPP's own cumulative conversation token count (scraped from
// the DOM pill). It is mapped onto prompt_tokens because OpenCode's overflow guard reads the latest
// assistant message as current context occupancy (see session/overflow.ts), and a normal provider's
// prompt_tokens already grows cumulatively — so the cumulative pill is the right shape. When it is
// absent we keep the chars/token heuristic (`promptTokens`), preserving its over-estimate safety bias.
// Caveat: total_tokens then slightly double-counts the current output (the cumulative prompt already
// includes prior outputs but not this turn's); minor and accepted.
function buildUsage({ promptTokens, completionText, realPromptTokens }) {
  const prompt = Number.isFinite(realPromptTokens)
    ? Math.max(0, Math.ceil(realPromptTokens))
    : Math.max(0, Math.ceil(Number(promptTokens) || 0));
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
