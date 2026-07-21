import { describe, expect, test } from "bun:test"
import { serializeChatCompletionRequest, serializeIncompleteTaskContinuationRequest, serializeToolRecoveryRequest } from "./messageSerializer.mjs"
import { TOOL_CALL_SYSTEM_REMINDER } from "./toolCallReminder.mjs"

const framed = (model = "CM_Opus 4.8 - Extra High") => ({
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
      instructions: [`you are opencode\n\n${TOOL_CALL_SYSTEM_REMINDER}`],
      toolCallProtocol: "CM_XML_TOOL_CALL_V1",
      tools: [{ name: "bash", description: "run", parameters: { type: "object" } }],
      messages: [{ role: "user", content: "do the thing" }],
    })
    expect(raw).not.toContain("relayed by a local proxy")
    expect(raw).not.toContain("[system]")
    expect(raw).toContain("<function_calls>")
  })

  test("uses the profile's custom tool-call protocol", () => {
    const out = JSON.parse(serializeChatCompletionRequest(framed("CM_GPT-5.5 - Extra High")))
    expect(out.toolCallProtocol).toBe("CM_JSON_TOOL_CALL_V1")
    expect(out.completionProtocol).toBe("CM_TASK_COMPLETE_V1")
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

  test("continuation keeps tools explicitly available while omitting fresh context", () => {
    const body = framed()
    body.messages.push({ role: "assistant", content: "done" }, { role: "user", content: "one more thing" })
    const out = JSON.parse(serializeChatCompletionRequest(body, { sinceIndex: 2 }))

    expect(out).toEqual({
      type: "CM_REQUEST_V1",
      version: 1,
      mode: "continue",
      purpose: "chat",
      toolCallProtocol: "CM_XML_TOOL_CALL_V1",
      instructions: [TOOL_CALL_SYSTEM_REMINDER],
      toolsAvailable: true,
      messages: [{ role: "user", content: "one more thing" }],
    })
  })

  test("a bare request still uses the versioned envelope", () => {
    const out = JSON.parse(
      serializeChatCompletionRequest({ model: "CM_Opus 4.8 - Extra High", messages: [{ role: "user", content: "hi" }] }),
    )
    expect(out.type).toBe("CM_REQUEST_V1")
    expect(out.messages).toEqual([{ role: "user", content: "hi" }])
  })

  test("builds a compact tool-router replay with recent completed progress from the active turn", () => {
    const body = framed()
    body.messages.push(
      { role: "assistant", content: "Local tools were unavailable." },
      { role: "user", content: "inspect the workspace now" },
      {
        role: "assistant",
        content: "I checked the worktree.",
        tool_calls: [{ id: "call-1", function: { name: "bash", arguments: '{"command":"git status --short"}' } }],
      },
      { role: "tool", tool_call_id: "call-1", content: " M changed.mjs" },
    )
    const out = JSON.parse(serializeToolRecoveryRequest(body))
    expect(out.mode).toBe("fresh")
    expect(out.instructions).toHaveLength(1)
    expect(out.instructions[0]).toContain("tool-routing step for a local coding session")
    expect(out.instructions[0]).toContain("Available tool names: bash")
    expect(out.messages).toEqual([
      { role: "user", content: "inspect the workspace now" },
      {
        role: "assistant",
        content: "I checked the worktree.",
        toolCalls: [{ id: "call-1", name: "bash", arguments: '{"command":"git status --short"}' }],
      },
      { role: "tool", content: " M changed.mjs", toolCallId: "call-1" },
    ])
    expect(out.instructions[0]).not.toContain("Local tools were unavailable")
    expect(out.instructions[0]).toContain("do not repeat a completed call")
  })
})

  test("builds a marker-enforcing continuation without replaying logical messages", () => {
    const out = JSON.parse(serializeIncompleteTaskContinuationRequest(framed("CM_GPT-5.5 - Medium")))
    expect(out).toMatchObject({
      mode: "continue",
      completionProtocol: "CM_TASK_COMPLETE_V1",
      resumeIncomplete: true,
      toolsAvailable: true,
      messages: [],
    })
    expect(out.instructions[0]).toContain("CM_TASK_COMPLETE_V1")
  })
