import { describe, expect, test } from "bun:test"
import { cleanupWindowOnFailure, classifyWppAuthState, classifyWppProjectAccessState, classifyWppSessionProbe, isWppFrameUrl, wppAuthRequiredError, wppProjectAccessError } from "./worker-startup"
import { selectWorkerSlot, shouldReapWorker, ttlForWorker, type WorkerView } from "./worker-slot"
import { WorkerPool, openAssistantPopover } from "./worker-pool"
import vm from "node:vm"
import type { WebContents } from "electron"
import { runLogRecord } from "./proxy/logging.mjs"
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

describe("WorkerPool cancellation", () => {
  test("discards the leased worker when its client aborts", async () => {
    const pool = new WorkerPool({ chatUrl: "https://example.test/chat" })
    let destroyed = false
    const worker = {
      id: 1,
      window: {
        isDestroyed: () => destroyed,
        destroy: () => {
          destroyed = true
        },
      },
      controller: {
        runJob: () => new Promise(() => {}),
      },
      netWitness: { summarizeWindow: () => ({}) },
      agent: "CM_GPT-5.6 Sol - High",
      protocolAgent: "CM_GPT-5.6 Sol - High",
      sessionKey: "session",
      subagent: false,
      busy: true,
      lastUsed: Date.now(),
    }
    Reflect.get(pool, "workers").set(worker.id, worker)
    Reflect.set(pool, "acquire", async () => worker)
    const controller = new AbortController()
    const run = pool.run({
      id: "job",
      payload: {
        model: worker.agent,
        sessionKey: worker.sessionKey,
        continueThread: true,
      },
    }, undefined, controller.signal).then(
      () => "resolved",
      (error) => Reflect.get(error, "type"),
    )

    controller.abort()
    const outcome = await Promise.race([
      run,
      new Promise<string>((resolve) => setTimeout(() => resolve("pending"), 50)),
    ])

    expect(outcome).toBe("o1_code_client_aborted")
    expect(destroyed).toBe(true)
    pool.destroy()
  })
})

describe("WorkerPool capture failures", () => {
  test("discards a worker after an image attachment desync", async () => {
    const pool = new WorkerPool({ chatUrl: "https://example.test/chat" })
    let destroyed = false
    const worker = {
      id: 2,
      window: {
        isDestroyed: () => destroyed,
        destroy: () => {
          destroyed = true
        },
      },
      controller: {
        runJob: async () => ({
          ok: false,
          error: "Timed out waiting for trusted image paste.",
          statusCode: 502,
          type: "o1_code_image_attachment_desync",
        }),
      },
      netWitness: { summarizeWindow: () => ({}) },
      agent: "CM_GPT-5.6 Sol - High",
      protocolAgent: "CM_GPT-5.6 Sol - High",
      sessionKey: "session",
      subagent: false,
      busy: true,
      lastUsed: Date.now(),
    }
    Reflect.get(pool, "workers").set(worker.id, worker)
    Reflect.set(pool, "acquire", async () => worker)

    const error = await pool
      .run({
        id: "job",
        payload: {
          model: worker.agent,
          sessionKey: worker.sessionKey,
          continueThread: true,
        },
      })
      .then(
        () => null,
        (failure) => failure,
      )

    expect(Reflect.get(error, "type")).toBe("o1_code_image_attachment_desync")
    expect(destroyed).toBe(true)
    pool.destroy()
  })

  test("classifies a no-network-response worker result for fresh replay", async () => {
    const pool = new WorkerPool({ chatUrl: "https://example.test/chat" })
    let destroyed = false
    const worker = {
      id: 2,
      window: {
        isDestroyed: () => destroyed,
        destroy: () => {
          destroyed = true
        },
      },
      controller: {
        runJob: async () => ({
          ok: false,
          error: "Network recorder saw 1 request(s), but no completed model response.",
          diagnostics: { phase: "no-network-response" },
        }),
      },
      netWitness: {
        summarizeWindow: () => ({
          cdpRequestSeen: true,
          cdpStatus: 200,
          cdpBytes: 0,
          cdpFinished: false,
          cdpFailed: false,
          failureText: null,
          eventSourceMessages: 0,
        }),
      },
      agent: "CM_GPT-5.6 Sol - High",
      protocolAgent: "CM_GPT-5.6 Sol - High",
      sessionKey: "session",
      subagent: false,
      busy: true,
      lastUsed: Date.now(),
    }
    Reflect.get(pool, "workers").set(worker.id, worker)
    Reflect.set(pool, "acquire", async () => worker)

    const error = await pool.run({
      id: "job",
      payload: {
        model: worker.agent,
        sessionKey: worker.sessionKey,
        continueThread: true,
      },
    }).then(
      () => null,
      (failure) => failure,
    )

    expect(Reflect.get(error, "type")).toBe("o1_code_capture_failure")
    expect(Reflect.get(error, "kind")).toBe("wpp_request_failed")
    expect(destroyed).toBe(true)
    pool.destroy()
  })
})

describe("assistant popover startup", () => {
  test("prefers the dedicated control even without an English label", async () => {
    const h = popoverHarness()
    h.button.innerText = ""
    h.button.textContent = ""
    await h.run()
    expect(h.clicks).toEqual([{ time: 0, x: 120 }])
  })

  test("falls back to an aria-labelled button when the dedicated control is absent", async () => {
    const h = popoverHarness()
    h.state.dedicated = false
    h.fallback.innerText = ""
    h.fallback.textContent = ""
    h.fallback.attributes["aria-label"] = "AI Assistant"
    await h.run()
    expect(h.clicks).toEqual([{ time: 0, x: 320 }])
  })

  test("does not toggle a slowly opening expanded panel closed", async () => {
    const h = popoverHarness()
    h.state.openAfter = 45000
    h.state.expandOnClick = true
    await h.run()
    expect(h.clicks).toEqual([{ time: 0, x: 120 }])
    expect(h.state.time).toBe(45000)
  })

  test("spaces retries while still detecting readiness on every poll", async () => {
    const h = popoverHarness()
    h.state.openAfter = 3500
    await h.run()
    expect(h.clicks).toEqual([{ time: 0, x: 120 }, { time: 3000, x: 120 }])
    expect(h.state.time).toBe(3500)
  })

  test.each(["disabled", "aria-disabled"])("waits for a %s control to become enabled", async (attribute) => {
    const h = popoverHarness()
    h.button.attributes[attribute] = "true"
    h.state.onPoll = () => {
      if (h.state.time >= 1000) delete h.button.attributes[attribute]
    }
    await h.run()
    expect(h.clicks).toEqual([{ time: 1000, x: 120 }])
  })

  test("waits for an overlay to clear and accepts a child hit target", async () => {
    const h = popoverHarness()
    h.state.covered = true
    h.state.onPoll = () => { h.state.covered = h.state.time < 1000 }
    await h.run()
    expect(h.clicks).toEqual([{ time: 1000, x: 120 }])
  })

  test("does not click a zero-sized control even when its centre hits a child", async () => {
    const h = popoverHarness()
    h.state.onPoll = () => {
      h.button.rect.height = h.state.time < 1000 ? 0 : 20
    }
    await h.run()
    expect(h.clicks).toEqual([{ time: 1000, x: 120 }])
  })

  test("waits until an offscreen control enters the viewport", async () => {
    const h = popoverHarness()
    h.state.onPoll = () => {
      h.button.rect.left = h.state.time < 1000 ? -100 : 100
    }
    await h.run()
    expect(h.clicks).toEqual([{ time: 1000, x: 120 }])
  })

  test("returns immediately when the assistant iframe already exists", async () => {
    const h = popoverHarness()
    h.state.openAfter = 0
    await h.run()
    expect(h.clicks).toEqual([])
    expect(h.state.time).toBe(0)
  })

  test("preserves safe timeout diagnostics through default run-log filtering", async () => {
    const h = popoverHarness()
    h.state.openAfter = Infinity
    h.state.expandOnClick = true
    h.state.iframeSrc = "about:blank"
    const error = await h.run().catch((failure) => failure)
    expect(error.message).toBe("Timed out opening WPP AI Assistant popover.")
    expect(error.diagnostics).toEqual({
      phase: "assistant-popover",
      elapsedMs: 60000,
      clickCount: 1,
      inspectionFailures: 0,
      popover: {
        buttonFound: true,
        expanded: true,
        disabled: false,
        unobscured: true,
        iframePresent: true,
      },
    })
    expect(runLogRecord({ bridgeResult: error.bridgeResult }, false)).toEqual({
      bridgeResult: { diagnostics: error.diagnostics },
    })
    expect(JSON.stringify(error.bridgeResult)).not.toContain("private")
  })

  test("records missing controls and failed inspections without leaking errors", async () => {
    const h = popoverHarness()
    h.state.openAfter = Infinity
    h.state.dedicated = false
    h.state.fallback = false
    h.state.failInspection = true
    const error = await h.run().catch((failure) => failure)
    expect(error.diagnostics).toMatchObject({
      clickCount: 0,
      inspectionFailures: 1,
      popover: { buttonFound: false, expanded: null, iframePresent: false },
    })
    expect(JSON.stringify(error.bridgeResult)).not.toContain("private")
  })
})

function popoverHarness() {
  const state = {
    time: 0,
    dedicated: true,
    fallback: true,
    covered: false,
    openAfter: 500,
    expandOnClick: false,
    iframeSrc: "",
    failInspection: false,
    onPoll: () => {},
  }
  const clicks: { time: number; x: number }[] = []
  const button = popoverButton(100)
  const fallback = popoverButton(300)
  const document = {
    querySelector(selector: string) {
      if (selector === "#assistant-iframe") {
        if (state.time >= state.openAfter && (clicks.length > 0 || state.openAfter === 0)) {
          return { src: "https://open-web-assistant-cs.wpp.ai/external?private=value" }
        }
        return state.iframeSrc ? { src: state.iframeSrc } : null
      }
      return state.dedicated ? button : null
    },
    querySelectorAll() {
      // Generic text matches can appear before the dedicated control in document order.
      return [state.fallback ? fallback : null, state.dedicated ? button : null].filter(Boolean)
    },
    elementFromPoint(x: number) {
      if (x < 0 || x >= 1440) return null
      if (state.covered) return {}
      return x === 120 ? button.child : fallback.child
    },
  }
  const context = vm.createContext({ document })
  const contents = {
    async executeJavaScript(source: string) {
      state.onPoll()
      if (state.failInspection) {
        state.failInspection = false
        throw new Error("private page error")
      }
      return vm.runInContext(source, context)
    },
    sendInputEvent(event: Parameters<WebContents["sendInputEvent"]>[0]) {
      if (event.type !== "mouseUp" || !("x" in event)) return
      clicks.push({ time: state.time, x: event.x })
      if (state.expandOnClick) button.attributes["aria-expanded"] = "true"
    },
    getURL: () => "https://ogilvy.os.wpp.com/orchestration/project/private",
    mainFrame: { framesInSubtree: [] },
  }
  return {
    state, clicks, button, fallback,
    run: () => openAssistantPopover(contents, {
      now: () => state.time,
      sleep: async (ms: number) => { state.time += ms },
    }),
  }
}

function popoverButton(left: number) {
  const attributes: Record<string, string> = {}
  const child = {}
  return {
    attributes,
    child,
    innerText: "AI Assistant",
    textContent: "AI Assistant",
    rect: { left, top: 0, width: 40, height: 20 },
    getAttribute(name: string) { return attributes[name] ?? null },
    hasAttribute(name: string) { return Object.hasOwn(attributes, name) },
    matches() { return Object.hasOwn(attributes, "disabled") },
    closest() {
      return Object.hasOwn(attributes, "disabled") || attributes["aria-disabled"] === "true" ? this : null
    },
    contains(node: unknown) { return node === child },
    getBoundingClientRect() { return this.rect },
  }
}

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
