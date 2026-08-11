import { CM_TASK_COMPLETE_PROTOCOL } from "./protocol.mjs"

export const TOOL_CALL_SYSTEM_REMINDER = `When you need a local harness tool, request it with a tool call in this XML format:

<function_calls>
<invoke id="<unique_call_id>" name="<tool_name>">
<parameter name="<param>">value</parameter>
</invoke>
</function_calls>

Rules:
- Generate a unique stable id for every call, and use exact tool and parameter names from the Tools block below.
- One value per <parameter>. For object or array arguments, put JSON inside the parameter, e.g. <parameter name="edits">[{"old":"a","new":"b"}]</parameter>.
- To run independent tools at once, emit several <invoke> blocks inside one <function_calls>. Otherwise wait for each tool result before the next call.
- Prior assistant tool calls in this thread already use this same XML format; the harness parses that same format back from you.
- When finished with no further tools, answer in plain text only (no tool-call XML).`;

export const TOOL_CALL_SYSTEM_REMINDER_JSON = `When you need a local harness tool, request it with a tool call as a single JSON object on its own, at the very end of your message (no markdown code fences around it):

{"type":"tool_call","tool":"<tool_name>","args":{"<param>":"value"}}

Rules:
- Use exact tool and parameter names from the Tools block below. Put every argument inside "args" with its natural JSON type (strings, numbers, booleans, objects, arrays).
- To run independent tools at once, emit several such JSON objects back-to-back at the end of the message. Otherwise wait for each tool result before the next call.
- Prior assistant tool calls in this thread already use this same JSON format; the harness parses that same format back from you.
- When finished with no further tools, answer in plain text only (no tool-call JSON).`;

export const TOOL_CALL_SYSTEM_REMINDER_PHASED = TOOL_CALL_SYSTEM_REMINDER
  .replace("in this XML format:", "in this XML format, with no Markdown fence:")
  .replace(
    "Prior assistant tool calls in this thread already use this same XML format; the harness parses that same format back from you.",
    "Prior assistant tool calls are represented structurally in messages[].toolCalls; do not copy them as new calls.",
  )

export const TASK_COMPLETION_SYSTEM_REMINDER = `Task completion contract:
- Keep working until the latest user request is fully resolved. A plan, progress update, initial inspection, or partial result is not complete.
- If more local work is needed, call an available tool and do not emit the completion marker.
- Only when the task is fully resolved, end the final plain-text answer with ${CM_TASK_COMPLETE_PROTOCOL} on its own line.
- A response that says the task is incomplete, could not be completed, or still requires local work contradicts and invalidates the completion marker.
- Do not claim local tool execution is unavailable unless an attempted tool call returned an error.`

export function toolCallInstructions(toolFormat, { commentaryPhase = false } = {}) {
  const toolReminder = toolFormat === "json"
    ? TOOL_CALL_SYSTEM_REMINDER_JSON
    : commentaryPhase
      ? TOOL_CALL_SYSTEM_REMINDER_PHASED
      : TOOL_CALL_SYSTEM_REMINDER
  return `${toolReminder}\n\n${TASK_COMPLETION_SYSTEM_REMINDER}`
}

export function toolCallRecoveryInstructions(toolNames = []) {
  const names = [...new Set(toolNames.filter((name) => typeof name === "string" && name.trim()))]
  const available = names.length > 0 ? ` Available tool names: ${names.join(", ")}.` : ""
  return `You are the tool-routing step for a local coding session. The listed tools are available now.${available} The messages may include recent tool calls and results that are already completed progress; use them and do not repeat a completed call unless its result requires a retry. Do not answer the user request in prose. Select and call at least one appropriate next tool, then wait for its result. For a request about the current workspace, repository, files, changes, diffs, or tests, begin with bash or read when either is listed and neither has already supplied the needed information.`
}
