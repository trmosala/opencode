import { describe, expect, test } from "bun:test"
import { serializeChatCompletionRequest } from "./messageSerializer.mjs"

const framed = (model = "o1-code") => ({
  model,
  tools: [{ function: { name: "bash", description: "run", parameters: { type: "object" } } }],
  messages: [
    { role: "system", content: "you are opencode" },
    { role: "user", content: "do the thing" },
  ],
})

describe("CookieMonster request envelope", () => {
  test("preserves fresh instructions, tools, and message roles without privileged-looking prose", () => {
    const raw = serializeChatCompletionRequest(framed())
    const out = JSON.parse(raw)

    expect(out).toEqual({
      type: "CM_REQUEST_V1",
      version: 1,
      mode: "fresh",
      purpose: "chat",
      instructions: ["you are opencode"],
      toolCallProtocol: "CM_XML_TOOL_CALL_V1",
      tools: [{ name: "bash", description: "run", parameters: { type: "object" } }],
      messages: [{ role: "user", content: "do the thing" }],
    })
    expect(raw).not.toContain("relayed by a local proxy")
    expect(raw).not.toContain("[system]")
    expect(raw).not.toContain("<function_calls>")
  })

  test("uses the profile's custom tool-call protocol", () => {
    const out = JSON.parse(serializeChatCompletionRequest(framed("o1-code-builder")))
    expect(out.toolCallProtocol).toBe("CM_XML_TOOL_CALL_V1")
  })

  test("keeps prior assistant tool calls and tool results as structured history", () => {
    const body = framed()
    body.messages.push(
      {
        role: "assistant",
        content: "",
        tool_calls: [{ id: "call-1", function: { name: "bash", arguments: '{"command":"pwd"}' } }],
      },
      { role: "tool", tool_call_id: "call-1", content: "D:/repo" },
    )
    const out = JSON.parse(serializeChatCompletionRequest(body))

    expect(out.messages.at(-2)).toEqual({
      role: "assistant",
      content: "",
      toolCalls: [{ id: "call-1", name: "bash", arguments: '{"command":"pwd"}' }],
    })
    expect(out.messages.at(-1)).toEqual({ role: "tool", content: "D:/repo", toolCallId: "call-1" })
  })

  test("continuation includes only unseen messages and omits fresh context", () => {
    const body = framed()
    body.messages.push({ role: "assistant", content: "done" }, { role: "user", content: "one more thing" })
    const out = JSON.parse(serializeChatCompletionRequest(body, { sinceIndex: 2 }))

    expect(out).toEqual({
      type: "CM_REQUEST_V1",
      version: 1,
      mode: "continue",
      purpose: "chat",
      messages: [{ role: "user", content: "one more thing" }],
    })
  })

  test("a bare request still uses the versioned envelope", () => {
    const out = JSON.parse(
      serializeChatCompletionRequest({ model: "o1-code", messages: [{ role: "user", content: "hi" }] }),
    )
    expect(out.type).toBe("CM_REQUEST_V1")
    expect(out.messages).toEqual([{ role: "user", content: "hi" }])
  })
})
