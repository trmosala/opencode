export const TOOL_CALL_SYSTEM_REMINDER = `When you need a local harness tool, request it with a tool call in this XML format:

<function_calls>
<invoke name="<tool_name>">
<parameter name="<param>">value</parameter>
</invoke>
</function_calls>

Rules:
- Use exact tool and parameter names from the Tools block below.
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
