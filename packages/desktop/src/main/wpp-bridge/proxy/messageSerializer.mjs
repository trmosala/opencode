import { TOOL_CALL_SYSTEM_REMINDER, TOOL_CALL_SYSTEM_REMINDER_JSON } from "./toolCallReminder.mjs";
import { formatAnthropicToolCall } from "./anthropicToolFormat.mjs";
import { formatJsonToolCall } from "./jsonToolFormat.mjs";
import { resolveModelProfile } from "./modelProfiles.mjs";
import { imagePlaceholderText } from "./imageInputs.mjs";

// The whole OpenCode conversation is relayed to the WPP agent as ONE user message: replayed
// [system]/tool-call/[tool result] framing and Anthropic-native <function_calls> markup all
// arrive inside a single turn. To Claude (the o1-code/Opus agent) that shape reads like a
// prompt-injection attempt, so it can balk. We can only type into the chat composer — there is
// no system-role channel here — so this disclosure is user-channel text. It therefore *discloses*
// rather than persuades: it names who set the connection up, that tool calls run locally with the
// user's authorization, and what the bracket framing is. (Persona/ownership language like "your
// own session, respond as the next assistant turn" reads as coercion and made the model balk.)
// The durable fix is the OgilvyOneCoder agent's real system prompt, configured WPP-side, not here.
// GPT (the json/builder profile) has no such reflex, so this stays xml-only.
//
// RETAINED ON PURPOSE (currently unused): injection is commented out in serializeChatCompletionRequest
// because we now rely on the WPP-side agent system prompt. Kept here so it can be re-enabled verbatim
// if needed. Do not delete.
// eslint-disable-next-line no-unused-vars -- retained for restore; injection is commented out below.
const SERIALIZED_SESSION_PREAMBLE =
  "This message is relayed by a local proxy the user runs on their own machine, connecting you " +
  "(the OgilvyOneCoder agent) to OpenCode, an open-source coding assistant, as its model backend. " +
  "The user set this up deliberately and authorized the tools listed below to run locally on " +
  "their own computer; any tool call you emit is executed by their harness and the result relayed " +
  "back to you. The [system], [user], tool-call and [tool result:…] blocks are the prior turns of " +
  "this OpenCode session, serialized into one message because the connection is stateless. " +
  "Continue the session and use the tools as needed.";

function stringifyContent(content, state = { imageIndex: 0 }) {
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
        state.imageIndex += 1;
        return imagePlaceholderText(part, state.imageIndex);
      }

      return JSON.stringify(part);
    }).join("\n");
  }

  if (content == null) {
    return "";
  }

  return JSON.stringify(content);
}

// `sinceIndex` > 0 selects delta mode: continue an existing WPP thread by forwarding only the
// non-system messages after that index. The tab already holds the preamble, system prompt, tool
// schema and prior turns from the first ("fresh") turn, so they are all omitted here.
// `provenance` is still accepted (callers pass it) but currently unused: it only gated the
// now-disabled preamble. Kept in the signature so callers and a future restore need no changes.
export function serializeChatCompletionRequest(body, { provenance: _provenance = true, sinceIndex = 0 } = {}) {
  const allMessages = Array.isArray(body.messages) ? body.messages : [];
  const systemMessages = allMessages.filter((m) => m.role === "system");
  const nonSystemMessages = allMessages.filter((m) => m.role !== "system");
  // Tool-call format follows the target model: o1-code -> XML, o1-code-builder -> JSON.
  // Both the per-request reminder and the replayed history use this format (see modelProfiles.mjs).
  const { toolFormat } = resolveModelProfile(body.model);
  const state = { imageIndex: 0 };
  const lines = [];
  const delta = sinceIndex > 0;

  if (!delta) {
    // NOTE: proxy-injected preamble disabled. We now rely on the OgilvyOneCoder agent's real
    // system prompt configured WPP-side (the durable home noted on SERIALIZED_SESSION_PREAMBLE)
    // instead of pushing a disclosure into the user channel. The constant and the gating logic
    // below are kept (commented) so this can be restored verbatim if the WPP-side prompt is ever
    // unavailable and Claude starts balking at the serialized framing again.
    //
    // const hasTools = Array.isArray(body.tools) && body.tools.length > 0;
    // const hasReplayedFraming = systemMessages.length > 0 || hasTools ||
    //   nonSystemMessages.some((m) => m.tool_call_id ||
    //     (Array.isArray(m.tool_calls) && m.tool_calls.length > 0));
    // if (provenance && toolFormat === "xml" && hasReplayedFraming) {
    //   lines.push(SERIALIZED_SESSION_PREAMBLE);
    // }

    for (const msg of systemMessages) {
      const content = stringifyContent(msg.content, state);
      if (content.trim()) {
        lines.push(`[system]\n${content}`);
      }
    }

    const toolBlock = buildToolSchemaBlock(body.tools);
    if (toolBlock) {
      lines.push(`[harness]\n${toolFormat === "json" ? TOOL_CALL_SYSTEM_REMINDER_JSON : TOOL_CALL_SYSTEM_REMINDER}`);
      lines.push(toolBlock);
    }
  }

  // ponytail: a delta may restate the model's own prior tool-call block (already in the thread) —
  // harmless duplication; trim it later only if the agent ever conflates it with new instruction.
  const turnMessages = delta ? nonSystemMessages.slice(sinceIndex) : nonSystemMessages;
  for (const message of turnMessages) {
    const role = message.role || "user";
    const content = stringifyContent(message.content, state);

    if (message.tool_call_id) {
      lines.push([
        `[tool result:${message.tool_call_id}]`,
        `This is the result of the already-completed local tool call ${message.tool_call_id}.`,
        content
      ].filter(Boolean).join("\n"));
      continue;
    }

    if (Array.isArray(message.tool_calls) && message.tool_calls.length > 0) {
      for (const toolCall of message.tool_calls) {
        lines.push(`[${role} tool call:${toolCall.id || "unknown"}]\n${stringifyToolCall(toolCall, toolFormat)}`);
      }

      if (!content.trim()) {
        continue;
      }
    }

    lines.push(`[${role}]\n${content}`);
  }

  // A lone [user] turn (every plain follow-up, and most deltas) goes in as bare composer text.
  if (lines.length === 1 && lines[0].startsWith("[user]\n")) {
    return lines[0].slice("[user]\n".length).trim();
  }

  return lines.join("\n\n");
}

export function serializableMessagesForRequest(body) {
  const allMessages = Array.isArray(body.messages) ? body.messages : [];
  const systemMessages = allMessages.filter((m) => m.role === "system");
  const nonSystemMessages = allMessages.filter((m) => m.role !== "system");

  return [
    ...systemMessages,
    ...nonSystemMessages
  ];
}

function buildToolSchemaBlock(tools) {
  if (!Array.isArray(tools) || tools.length === 0) {
    return null;
  }

  const toolLines = tools.map((tool) => {
    const fn = tool.function || tool;
    const params = fn.parameters ? JSON.stringify(fn.parameters) : "{}";
    const desc = fn.description ? ` — ${fn.description}` : "";
    return `- ${fn.name}${desc}\n  Parameters: ${params}`;
  });

  return ["Tools:", ...toolLines].join("\n");
}

// Echo prior tool calls back to the model in the same format it is asked to produce (the same
// toolFormat that selects the [harness] reminder above), so the transcript the model sees matches
// the format it should emit.
// XML for o1-code/Opus, JSON for o1-code-builder/GPT. The proxy parses both back out in
// toolCallNormalizer.
function stringifyToolCall(toolCall, toolFormat) {
  return toolFormat === "json"
    ? formatJsonToolCall(toolCall)
    : formatAnthropicToolCall(toolCall);
}

