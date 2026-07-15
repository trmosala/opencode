import { describe, expect, test } from "bun:test"
import { formatAnthropicToolCall } from "./anthropicToolFormat.mjs"
import { normalizeAssistantMessage, parseAnthropicXmlToolCalls } from "./toolCallNormalizer.mjs"

describe("XML tool-call identity", () => {
  test("formats an OpenCode call id into the XML visible to WPP", () => {
    const xml = formatAnthropicToolCall({
      id: "call_read_1",
      function: { name: "read", arguments: '{"filePath":"a.txt"}' },
    })
    expect(xml).toContain('<invoke id="call_read_1" name="read">')
  })

  test("preserves ids from parallel WPP XML calls", () => {
    const xml = `<function_calls>
<invoke id="call_a" name="read"><parameter name="filePath">a.txt</parameter></invoke>
<invoke name="write" id="call_b"><parameter name="filePath">b.txt</parameter></invoke>
</function_calls>`
    expect(parseAnthropicXmlToolCalls(xml)).toEqual([
      { id: "call_a", name: "read", args: { filePath: "a.txt" } },
      { id: "call_b", name: "write", args: { filePath: "b.txt" } },
    ])
    expect(normalizeAssistantMessage(xml).tool_calls.map((call) => call.id)).toEqual(["call_a", "call_b"])
  })

  test("keeps legacy id-less XML compatible", () => {
    const normalized = normalizeAssistantMessage(
      '<function_calls><invoke name="read"><parameter name="filePath">a.txt</parameter></invoke></function_calls>',
    )
    expect(normalized.tool_calls[0].id).toMatch(/^call_/)
  })
})
