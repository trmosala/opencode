import { parseToolArguments } from "./toolArguments.mjs";

// Render an OpenAI tool_call back into the JSON protocol the GPT/"o1-code-builder" agent emits,
// so prior tool calls replayed into the transcript match the format the model is asked to produce
// (see TOOL_CALL_SYSTEM_REMINDER_JSON). The proxy parses this same shape back out in
// src/toolCallNormalizer.mjs (parseTrailingToolCallJsons / parseLeadingToolCallJson).
//
// Mirrors src/anthropicToolFormat.mjs's formatAnthropicToolCall, but for JSON instead of XML.
export function formatJsonToolCall(toolCall) {
  const fn = toolCall?.function || toolCall;
  const name = fn?.name || "unknown";
  const args = parseToolArguments(fn?.arguments);

  return JSON.stringify({ type: "tool_call", tool: name, args });
}
