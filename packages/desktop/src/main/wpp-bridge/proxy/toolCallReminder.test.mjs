import { describe, expect, test } from "bun:test"
import {
  TOOL_CALL_SYSTEM_REMINDER,
  TOOL_CALL_SYSTEM_REMINDER_JSON,
  toolCallInstructions,
  toolCallRecoveryInstructions,
} from "./toolCallReminder.mjs"

describe("tool-call transport instructions", () => {
  test("selects concrete XML instructions for XML model profiles", () => {
    expect(toolCallInstructions("xml")).toBe(TOOL_CALL_SYSTEM_REMINDER)
    expect(toolCallInstructions("xml")).toContain("<function_calls>")
  })

  test("selects concrete JSON instructions for JSON model profiles", () => {
    expect(toolCallInstructions("json")).toStartWith(TOOL_CALL_SYSTEM_REMINDER_JSON)
    expect(toolCallInstructions("json")).toContain('{"type":"tool_call"')
  })
    expect(toolCallInstructions("json")).toContain("CM_TASK_COMPLETE_V1")

  test("builds a bounded recovery instruction with the exact available tool names", () => {
    const instruction = toolCallRecoveryInstructions(["bash", "read", "bash"])
    expect(instruction).toContain("tool-routing step for a local coding session")
    expect(instruction).toContain("Available tool names: bash, read")
    expect(instruction).toContain("begin with bash or read")
    expect(instruction).not.toContain("system instructions")
  })
})
