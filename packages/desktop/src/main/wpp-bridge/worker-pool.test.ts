import { describe, expect, test } from "bun:test"
import { cleanupWindowOnFailure, classifyWppAuthState, wppAuthRequiredError } from "./worker-startup"
import { selectWorkerSlot, shouldReapWorker, ttlForWorker, type WorkerView } from "./worker-slot"

const worker = (
  id: number,
  agent: string,
  busy: boolean,
  lastUsed: number,
  sessionKey = "",
  subagent = false,
): WorkerView => ({
  id,
  agent,
  sessionKey,
  subagent,
  busy,
  lastUsed,
})

describe("selectWorkerSlot", () => {
  test("reuses a free worker already pinned to the requested agent", () => {
    const slot = selectWorkerSlot([worker(1, "GPT", false, 1), worker(2, "Opus", false, 2)], "Opus")
    expect(slot).toEqual({ action: "reuse", id: 2 })
  })

  test("prefers an agent-pinned worker over a more-idle untagged one", () => {
    const slot = selectWorkerSlot([worker(1, "", false, 1), worker(2, "Opus", false, 9)], "Opus")
    expect(slot).toEqual({ action: "reuse", id: 2 })
  })

  test("falls back to an untagged free worker when none match the agent", () => {
    const slot = selectWorkerSlot([worker(1, "GPT", false, 1), worker(2, "", false, 2)], "Opus")
    expect(slot).toEqual({ action: "reuse", id: 2 })
  })

  test("grows rather than stealing another agent's idle worker", () => {
    const slot = selectWorkerSlot([worker(1, "GPT", false, 1)], "Opus")
    expect(slot).toEqual({ action: "grow" })
  })

  test("grows from an empty pool", () => {
    expect(selectWorkerSlot([], "Opus")).toEqual({ action: "grow" })
  })

  test("grows instead of re-tagging another agent's idle worker", () => {
    const slot = selectWorkerSlot([worker(1, "GPT", false, 30), worker(2, "GPT", false, 10)], "Opus")
    expect(slot).toEqual({ action: "grow" })
  })

  test("grows when every worker is busy", () => {
    const slot = selectWorkerSlot([worker(1, "GPT", true, 1), worker(2, "Opus", true, 2)], "Opus")
    expect(slot).toEqual({ action: "grow" })
  })

  test("skips a busy same-agent worker and reuses an untagged free one", () => {
    const slot = selectWorkerSlot([worker(1, "Opus", true, 1), worker(2, "", false, 2)], "Opus")
    expect(slot).toEqual({ action: "reuse", id: 2 })
  })

  test("matches only untagged free workers for a blank agent request", () => {
    const slot = selectWorkerSlot([worker(1, "GPT", false, 1), worker(2, "", false, 2)], "")
    expect(slot).toEqual({ action: "reuse", id: 2 })
  })

  test("reuses the session's own pinned tab over an idle unpinned worker", () => {
    const slot = selectWorkerSlot(
      [worker(1, "Opus", false, 1), worker(2, "Opus", false, 9, "sess-A::Opus")],
      "Opus",
      "sess-A::Opus",
    )
    expect(slot).toEqual({ action: "reuse", id: 2 })
  })

  test("never steals a tab pinned to a different session — grows instead", () => {
    const slot = selectWorkerSlot([worker(1, "Opus", false, 1, "sess-B::Opus")], "Opus", "sess-A::Opus")
    expect(slot).toEqual({ action: "grow" })
  })

  test("adopts an unpinned agent-matching worker when the session has no tab yet", () => {
    const slot = selectWorkerSlot(
      [worker(1, "GPT", false, 1), worker(2, "Opus", false, 2)],
      "Opus",
      "sess-A::Opus",
    )
    expect(slot).toEqual({ action: "reuse", id: 2 })
  })

  test("a sessionless request does not steal a session-pinned worker", () => {
    const slot = selectWorkerSlot(
      [worker(1, "Opus", false, 1, "sess-A::Opus"), worker(2, "", false, 5)],
      "Opus",
    )
    expect(slot).toEqual({ action: "reuse", id: 2 })
  })

  test("reaps only idle workers past the TTL", () => {
    const ttl = 1000
    const now = 5000
    expect(shouldReapWorker(worker(1, "Opus", false, now - ttl), now, ttl)).toBe(true)
    expect(shouldReapWorker(worker(2, "Opus", false, now - ttl + 1), now, ttl)).toBe(false)
    expect(shouldReapWorker(worker(3, "Opus", true, now - ttl), now, ttl)).toBe(false)
  })
})

describe("ttlForWorker", () => {
  const ttls = { idle: 10, pinned: 30, subagent: 5 }

  test("unpinned worker uses the idle TTL", () => {
    expect(ttlForWorker(worker(1, "Opus", false, 0), ttls)).toBe(10)
  })

  test("session-pinned worker uses the pinned TTL", () => {
    expect(ttlForWorker(worker(1, "Opus", false, 0, "sess-A::Opus"), ttls)).toBe(30)
  })

  test("sub-agent pinned worker uses the shorter subagent TTL", () => {
    expect(ttlForWorker(worker(1, "Opus", false, 0, "sub-A::Opus", true), ttls)).toBe(5)
  })

  test("subagent flag only matters when pinned", () => {
    // An unpinned worker is scratch regardless of the flag — it never holds a sub-agent thread.
    expect(ttlForWorker(worker(1, "Opus", false, 0, "", true), ttls)).toBe(10)
  })

  test("a sub-agent tab is reaped while a same-age interactive tab survives", () => {
    const now = 100_000
    const lastUsed = now - 6 * 60 * 1000 // idle 6 min
    const idle = 10 * 60 * 1000
    const pinned = 30 * 60 * 1000
    const subagent = 5 * 60 * 1000

    const sub = worker(1, "Opus", false, lastUsed, "sub-A::Opus", true)
    const interactive = worker(2, "Opus", false, lastUsed, "sess-A::Opus")

    expect(shouldReapWorker(sub, now, ttlForWorker(sub, { idle, pinned, subagent }))).toBe(true)
    expect(shouldReapWorker(interactive, now, ttlForWorker(interactive, { idle, pinned, subagent }))).toBe(false)
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
