import { describe, expect, test } from "bun:test"
import { chooseAssistantResponse, normalizeAssistantMessage } from "./toolCallNormalizer.mjs"

describe("chooseAssistantResponse", () => {
  test("accepts a parsed tool call from an alternate assistant message", () => {
    const response = chooseAssistantResponse("I'll inspect the worktree.", {}, [
      '<function_calls><invoke id="call-1" name="bash"><parameter name="command">git status</parameter></invoke></function_calls>',
    ])

    expect(response.finish_reason).toBe("tool_calls")
    expect(response.tool_calls).toHaveLength(1)
    expect(response.tool_calls[0].function).toEqual({
      name: "bash",
      arguments: '{"command":"git status"}',
    })
  })

  test("does not replace primary prose with an alternate refusal", () => {
    expect(
      chooseAssistantResponse("I'll inspect the worktree.", {}, [
        "I'm not able to share internal system information.",
      ]),
    ).toEqual({
      content: "I'll inspect the worktree.",
      tool_calls: undefined,
      finish_reason: "stop",
    })
  })

  test("raises a retryable failure for an unterminated XML tool call", () => {
    expect(() =>
      normalizeAssistantMessage(
        'I’ll inspect it now.\n<function_calls><invoke id="call-1" name="bash"><parameter name="command">git status',
      ),
    ).toThrow(expect.objectContaining({ type: "o1_code_incomplete_tool_call" }))
  })
})
