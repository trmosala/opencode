import { describe, expect, test } from "bun:test"
import { sessionWorkflowState } from "./session-workflow"

const idle = { working: false, attention: false, prompt: 10 }
const busy = { ...idle, working: true }

describe("session workflow", () => {
  test("idle chats belong to Inbox, executing chats to Working", () => {
    expect(sessionWorkflowState(undefined, 20, idle)).toBe("inbox")
    expect(sessionWorkflowState(undefined, 20, busy)).toBe("working")
    expect(sessionWorkflowState(undefined, 20, { ...busy, attention: true })).toBe("inbox")
  })
  test("settlement survives reading and metadata changes but wakes for a new prompt", () => {
    const entry = { state: "settled" as const, at: 15, updated: 10, prompt: 10 }
    expect(sessionWorkflowState(entry, 100, idle)).toBe("settled")
    expect(sessionWorkflowState(entry, 100, { ...idle, prompt: 16 })).toBe("inbox")
    expect(sessionWorkflowState(entry, 100, { ...busy, prompt: 16 })).toBe("working")
  })
  test("attention overrides both organization states", () => {
    for (const state of ["settled", "snoozed"] as const) {
      const entry = { state, at: 15, updated: 10, prompt: 10, until: 100 }
      expect(sessionWorkflowState(entry, 20, { ...busy, attention: true })).toBe("inbox")
    }
  })
  test("snooze takes precedence over execution until expiry or a new prompt", () => {
    const entry = { state: "snoozed" as const, at: 15, updated: 10, prompt: 10, until: 30 }
    expect(sessionWorkflowState(entry, 29, busy)).toBe("snoozed")
    expect(sessionWorkflowState(entry, 30, busy)).toBe("working")
    expect(sessionWorkflowState(entry, 30, idle)).toBe("inbox")
    expect(sessionWorkflowState(entry, 20, { ...busy, prompt: 16 })).toBe("working")
    expect(sessionWorkflowState({ ...entry, until: undefined }, 20, idle)).toBe("inbox")
  })
  test("prompt wake uses the backend watermark despite client clock skew", () => {
    for (const state of ["settled", "snoozed"] as const) {
      const entry = { state, at: 60_000, updated: 30_000, prompt: 29_000, until: 100_000 }
      expect(sessionWorkflowState(entry, 61_000, { ...idle, prompt: 29_000 })).toBe(state)
      expect(sessionWorkflowState(entry, 61_000, { ...idle, prompt: 31_000 })).toBe("inbox")
    }
  })
  test("older persisted entries and pending settlement remain readable", () => {
    expect(sessionWorkflowState({ state: "settled", updated: 10 }, 20, idle)).toBe("settled")
    expect(sessionWorkflowState({ state: "settled", updated: 10, pending: true }, 20, busy)).toBe("working")
  })
})
