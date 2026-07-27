import { describe, expect, test } from "bun:test"
import { cleanupWindowOnFailure, classifyWppAuthState, classifyWppProjectAccessState, classifyWppSessionProbe, isWppFrameUrl, wppAuthRequiredError, wppProjectAccessError } from "./worker-startup"
import { selectWorkerSlot, shouldReapWorker, ttlForWorker, type WorkerView } from "./worker-slot"
import { WPP_COOKIE_MONSTER_PROJECT_URL } from "./proxy/wppProject.mjs"

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

  test("waits for the session's busy pinned tab instead of forking a second thread", () => {
    // The whole session-fork bug: adopting an idle unpinned worker here opens a 2nd WPP thread for
    // sess-A, and its concurrent turns then split across two chat branches.
    const slot = selectWorkerSlot(
      [worker(1, "Opus", true, 1, "sess-A::Opus"), worker(2, "", false, 2)],
      "Opus",
      "sess-A::Opus",
    )
    expect(slot).toEqual({ action: "wait", id: 1 })
  })

  test("prefers reusing a free same-session tab over waiting on a busy one", () => {
    const slot = selectWorkerSlot(
      [worker(1, "Opus", true, 1, "sess-A::Opus"), worker(2, "Opus", false, 2, "sess-A::Opus")],
      "Opus",
      "sess-A::Opus",
    )
    expect(slot).toEqual({ action: "reuse", id: 2 })
  })

  test("a busy tab pinned to a different session does not trigger a wait", () => {
    const slot = selectWorkerSlot([worker(1, "Opus", true, 1, "sess-B::Opus")], "Opus", "sess-A::Opus")
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
    expect(classifyWppAuthState({ url: WPP_COOKIE_MONSTER_PROJECT_URL, text: "AI Assistant" })).toBe(null)

    const error = wppAuthRequiredError("WPP page is asking for sign-in") as Error & {
      statusCode: number
      type: string
    }
    expect(error.statusCode).toBe(401)
    expect(error.type).toBe("wpp_auth_required")
  })

  test("reports project authorization separately from login", () => {
    const state = { url: WPP_COOKIE_MONSTER_PROJECT_URL, text: "Access denied" }
    const reason = classifyWppProjectAccessState(state)
    expect(reason).toContain("does not have access")
    expect(classifyWppAuthState(state)).toBe(null)

    const error = wppProjectAccessError(reason, state) as Error & { statusCode: number; type: string }
    expect(error.statusCode).toBe(403)
    expect(error.type).toBe("wpp_project_access_denied")
  })

  test("scopes the logout probe to WPP frames only", () => {
    expect(isWppFrameUrl(WPP_COOKIE_MONSTER_PROJECT_URL)).toBe(true)
    expect(isWppFrameUrl("https://open-web-deeplink-cs.wpp.ai/chat")).toBe(true)
    // A silent-SSO renewer iframe on the IdP origin must NOT be probed: its URL matches the login
    // pattern even while the session is perfectly healthy.
    expect(isWppFrameUrl("https://login.microsoftonline.com/silent-renew")).toBe(false)
    expect(
      isWppFrameUrl(
        "https://authenticate.os.wpp.com/auth/realms/os-prod/protocol/openid-connect/login-status-iframe.html",
      ),
    ).toBe(false)
    expect(isWppFrameUrl("about:blank")).toBe(false)
    expect(isWppFrameUrl("")).toBe(false)
  })

  test("classifies a soft-logout document re-fetch as auth required", () => {
    // Dead cookies: the document request is bounced to the IdP (opaque cross-origin redirect) or
    // rejected outright, even though the cached SPA shell still renders with no sign-in text.
    expect(classifyWppSessionProbe({ status: 0, type: "opaqueredirect" })).toContain("expired")
    expect(classifyWppSessionProbe({ status: 302, type: "default" })).toContain("expired")
    expect(classifyWppSessionProbe({ status: 401, type: "basic" })).toContain("401")
    expect(classifyWppSessionProbe({ status: 403, type: "basic" })).toBe(null)
    // Live session answers 2xx; a failed/unreadable probe stays inconclusive rather than
    // false-positiving the SSO popup after an unrelated turn failure.
    expect(classifyWppSessionProbe({ status: 200, type: "basic" })).toBe(null)
    expect(classifyWppSessionProbe(null)).toBe(null)
  })
})
