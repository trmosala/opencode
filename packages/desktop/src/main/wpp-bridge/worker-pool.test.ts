import { describe, expect, test } from "bun:test"
import { cleanupWindowOnFailure, classifyWppAuthState, wppAuthRequiredError } from "./worker-startup"
import { selectWorkerSlot, type WorkerView } from "./worker-slot"

const worker = (id: number, agent: string, busy: boolean, lastUsed: number): WorkerView => ({
  id,
  agent,
  busy,
  lastUsed,
})

describe("selectWorkerSlot", () => {
  test("reuses a free worker already pinned to the requested agent", () => {
    const slot = selectWorkerSlot([worker(1, "GPT", false, 1), worker(2, "Opus", false, 2)], 5, "Opus")
    expect(slot).toEqual({ action: "reuse", id: 2 })
  })

  test("prefers an agent-pinned worker over a more-idle untagged one", () => {
    const slot = selectWorkerSlot([worker(1, "", false, 1), worker(2, "Opus", false, 9)], 5, "Opus")
    expect(slot).toEqual({ action: "reuse", id: 2 })
  })

  test("falls back to an untagged free worker when none match the agent", () => {
    const slot = selectWorkerSlot([worker(1, "GPT", false, 1), worker(2, "", false, 2)], 5, "Opus")
    expect(slot).toEqual({ action: "reuse", id: 2 })
  })

  test("grows rather than stealing another agent's idle worker when capacity remains", () => {
    const slot = selectWorkerSlot([worker(1, "GPT", false, 1)], 5, "Opus")
    expect(slot).toEqual({ action: "grow" })
  })

  test("grows from an empty pool", () => {
    expect(selectWorkerSlot([], 5, "Opus")).toEqual({ action: "grow" })
  })

  test("re-tags the LRU free worker when the pool is full", () => {
    const slot = selectWorkerSlot([worker(1, "GPT", false, 30), worker(2, "GPT", false, 10)], 2, "Opus")
    expect(slot).toEqual({ action: "retag", id: 2 })
  })

  test("waits when the pool is full and every worker is busy", () => {
    const slot = selectWorkerSlot([worker(1, "GPT", true, 1), worker(2, "Opus", true, 2)], 2, "Opus")
    expect(slot).toEqual({ action: "wait" })
  })

  test("skips a busy same-agent worker and reuses an untagged free one", () => {
    const slot = selectWorkerSlot([worker(1, "Opus", true, 1), worker(2, "", false, 2)], 5, "Opus")
    expect(slot).toEqual({ action: "reuse", id: 2 })
  })

  test("matches only untagged free workers for a blank agent request", () => {
    const slot = selectWorkerSlot([worker(1, "GPT", false, 1), worker(2, "", false, 2)], 5, "")
    expect(slot).toEqual({ action: "reuse", id: 2 })
  })
})

describe("worker startup helpers", () => {
  test("destroys a created window when startup fails", async () => {
    let destroyed = false
    const window = {
      isDestroyed: () => destroyed,
      destroy: () => {
        destroyed = true
      },
    }

    await expect(cleanupWindowOnFailure(window, async () => {
      throw new Error("startup failed")
    })).rejects.toThrow("startup failed")

    expect(destroyed).toBe(true)
  })

  test("classifies login-like WPP startup states as auth required", () => {
    expect(classifyWppAuthState({ url: "https://idp.example.com/oauth/authorize" })).toContain("login")
    expect(classifyWppAuthState({ text: "Your session expired. Sign in again." })).toContain("sign-in")
    expect(classifyWppAuthState({ url: "https://ogilvy.os.wpp.com/agent/workspace", text: "AI Assistant" })).toBe(null)

    const error = wppAuthRequiredError("WPP page is asking for sign-in") as Error & {
      statusCode: number
      type: string
    }
    expect(error.statusCode).toBe(401)
    expect(error.type).toBe("wpp_auth_required")
  })
})
