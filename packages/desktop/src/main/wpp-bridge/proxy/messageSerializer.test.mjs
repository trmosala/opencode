import { describe, expect, test } from "bun:test"
import {
  serializeChatCompletionRequest,
  serializeIncompleteTaskContinuationRequest,
  serializeToolRecoveryRequest,
} from "./messageSerializer.mjs"
import { TASK_COMPLETION_SYSTEM_REMINDER, TOOL_CALL_SYSTEM_REMINDER } from "./toolCallReminder.mjs"

const framed = (model = "CM_Opus 5 - Extra High") => ({
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
      instructions: [`you are opencode\n\n${TOOL_CALL_SYSTEM_REMINDER}\n\n${TASK_COMPLETION_SYSTEM_REMINDER}`],
      toolCallProtocol: "CM_XML_TOOL_CALL_V1",
      completionProtocol: "CM_TASK_COMPLETE_V1",
      tools: [{ name: "bash", description: "run", parameters: { type: "object" } }],
      messages: [{ role: "user", content: "do the thing" }],
    })
    expect(raw).not.toContain("relayed by a local proxy")
    expect(raw).not.toContain("[system]")
    expect(raw).toContain("<function_calls>")
  })

  test("uses the Opus tool-call protocol for GPT models", () => {
    const out = JSON.parse(serializeChatCompletionRequest(framed("CM_GPT-5.6 Sol - Extra High")))
    expect(out.toolCallProtocol).toBe("CM_XML_TOOL_CALL_V1")
    expect(out.completionProtocol).toBe("CM_TASK_COMPLETE_V1")
  })

  test("labels GPT-5.6 assistant history with conservative phase semantics", () => {
    const body = framed("CM_GPT-5.6 Sol - High")
    body.messages.push(
      { role: "assistant", content: "First task complete." },
      { role: "user", content: "Inspect the worktree." },
      {
        role: "assistant",
        content: "I'll inspect it now.",
        tool_calls: [{ id: "call-1", function: { name: "bash", arguments: '{"command":"git status"}' } }],
      },
      { role: "tool", tool_call_id: "call-1", content: "clean" },
    )

    const out = JSON.parse(serializeChatCompletionRequest(body))

    expect(out.messages[1].phase).toBe("final_answer")
    expect(out.messages[3].phase).toBe("commentary")
  })

  test("keeps an unconfirmed active GPT-5.6 assistant response in commentary", () => {
    const body = framed("CM_GPT-5.6 Sol - High")
    body.messages.push({ role: "assistant", content: "I'll inspect it now." })

    const out = JSON.parse(serializeChatCompletionRequest(body))

    expect(out.messages.at(-1).phase).toBe("commentary")
  })

  test("labels only the last assistant response in a completed turn as final", () => {
    const body = framed("CM_GPT-5.6 Sol - High")
    body.messages.push(
      { role: "assistant", content: "I’ll inspect it now." },
      { role: "assistant", content: "Inspection complete." },
      { role: "user", content: "What did you find?" },
    )

    const out = JSON.parse(serializeChatCompletionRequest(body))

    expect(out.messages.at(-3).phase).toBe("commentary")
    expect(out.messages.at(-2).phase).toBe("final_answer")
  })

  test("keeps the established Opus envelope byte-identical", () => {
    const raw = serializeChatCompletionRequest(framed())
    expect(new Bun.CryptoHasher("sha256").update(raw).digest("hex")).toBe(
      "87f727b61b18d52b89403822ca36d1bc8dbe199c97ca91b32780c20cb66ba771",
    )
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

  test("continuation repeats tools while omitting fresh context", () => {
    const body = framed()
    body.messages.push({ role: "assistant", content: "done" }, { role: "user", content: "one more thing" })
    const out = JSON.parse(serializeChatCompletionRequest(body, { sinceIndex: 2 }))

    expect(out).toEqual({
      type: "CM_REQUEST_V1",
      version: 1,
      mode: "continue",
      purpose: "chat",
      toolCallProtocol: "CM_XML_TOOL_CALL_V1",
      completionProtocol: "CM_TASK_COMPLETE_V1",
      instructions: [`${TOOL_CALL_SYSTEM_REMINDER}\n\n${TASK_COMPLETION_SYSTEM_REMINDER}`],
      tools: [{ name: "bash", description: "run", parameters: { type: "object" } }],
      messages: [{ role: "user", content: "one more thing" }],
    })
  })

  test("incomplete-task continuation repeats the current tool definitions", () => {
    const out = JSON.parse(serializeIncompleteTaskContinuationRequest(framed()))

    expect(out.mode).toBe("continue")
    expect(out.completionProtocol).toBe("CM_TASK_COMPLETE_V1")
    expect(out.tools).toEqual([{ name: "bash", description: "run", parameters: { type: "object" } }])
  })

  test("a bare request still uses the versioned envelope", () => {
    const out = JSON.parse(
      serializeChatCompletionRequest({ model: "CM_Opus 5 - Extra High", messages: [{ role: "user", content: "hi" }] }),
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
