import { describe, expect, test } from "bun:test"
import {
  cleanupWindowOnFailure,
  classifyWppAuthState,
  classifyWppProjectAccessState,
  classifyWppSessionProbe,
  isWppFrameUrl,
  wppAuthRequiredError,
  wppProjectAccessError,
} from "./worker-startup"
import { selectWorkerSlot, shouldReapWorker, ttlForWorker, type WorkerView } from "./worker-slot"
import { WorkerPool, submissionStartedAt, toggleWorkerWindows } from "./worker-pool"
import { createCdpNetworkReducer } from "./cdp-network-recorder"
import { WPP_COOKIE_MONSTER_PROJECT_URL } from "./proxy/wppProject.mjs"
import { commitThread, resetThread, threadContextUsage } from "./proxy/sessionThreads.mjs"

const DESKTOP_KEY = JSON.stringify(["desktop", "runtime-D", "sess-A", "CM_Opus5.5-High"])
const CLI_KEY = JSON.stringify(["cli", "runtime-A", "sess-A", "CM_Opus5.5-High"])
const OTHER_CLI_KEY = JSON.stringify(["cli", "runtime-B", "sess-A", "CM_Opus5.5-High"])

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
    const slot = selectWorkerSlot([worker(1, "GPT", false, 1), worker(2, "Opus", false, 2)], "Opus", "sess-A::Opus")
    expect(slot).toEqual({ action: "reuse", id: 2 })
  })

  test("a sessionless request does not steal a session-pinned worker", () => {
    const slot = selectWorkerSlot([worker(1, "Opus", false, 1, "sess-A::Opus"), worker(2, "", false, 5)], "Opus")
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

  test("desktop session-pinned worker uses the pinned TTL", () => {
    expect(ttlForWorker(worker(1, "Opus", false, 0, DESKTOP_KEY), ttls)).toBe(30)
  })

  test("non-desktop runtime-pinned workers use the short TTL", () => {
    expect(ttlForWorker(worker(1, "Opus", false, 0, CLI_KEY), ttls)).toBe(5)
    expect(ttlForWorker(worker(1, "Opus", false, 0, JSON.stringify(["acp", "r", "s", "Opus"])), ttls)).toBe(5)
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
    const interactive = worker(2, "Opus", false, lastUsed, DESKTOP_KEY)

    expect(shouldReapWorker(sub, now, ttlForWorker(sub, { idle, pinned, subagent }))).toBe(true)
    expect(shouldReapWorker(interactive, now, ttlForWorker(interactive, { idle, pinned, subagent }))).toBe(false)
  })
})

describe("WorkerPool startup visibility", () => {
  test("toggles starting windows before they enter the ready pool", () => {
    const pool = new WorkerPool({ chatUrl: "https://example.test/chat" })
    const calls: string[] = []
    let destroyed = false
    Reflect.get(pool, "startingWorkers").set(1, {
      window: {
        isDestroyed: () => destroyed,
        showInactive: () => calls.push("show"),
        hide: () => calls.push("hide"),
        setTitle: (title: string) => calls.push(title),
        destroy: () => {
          destroyed = true
        },
      },
      agent: "test-agent",
      sessionKey: "test-session",
      subagent: false,
    })
    const visible = toggleWorkerWindows()
    expect(calls[0]).toBe(visible ? "show" : "hide")
    calls.length = 0
    expect(toggleWorkerWindows()).toBe(!visible)
    expect(calls[0]).toBe(visible ? "hide" : "show")
    pool.destroy()
    expect(destroyed).toBe(true)
    expect(Reflect.get(pool, "startingWorkers").size).toBe(0)
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
    const run = pool
      .run(
        {
          id: "job",
          payload: {
            model: worker.agent,
            sessionKey: worker.sessionKey,
            continueThread: true,
          },
        },
        undefined,
        controller.signal,
      )
      .then(
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
  test.each(["o1_code_image_attachment_desync", "o1_code_greeting_not_settled", "o1_code_fresh_chat_failed"])(
    "discards a worker after %s",
    async (type) => {
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
            type,
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

      expect(Reflect.get(error, "type")).toBe(type)
      expect(destroyed).toBe(true)
      pool.destroy()
    },
  )

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

    expect(Reflect.get(error, "type")).toBe("o1_code_capture_failure")
    expect(Reflect.get(error, "kind")).toBe("wpp_request_failed")
    expect(destroyed).toBe(true)
    pool.destroy()
  })
})

describe("WorkerPool retirement", () => {
  const mirrorBody = { model: "CM_Opus5.5-High", messages: [{ role: "user", content: "hi" }] }
  const mirror = (key: string) =>
    commitThread(key, mirrorBody, { role: "assistant", content: "ok" }, { totalTokens: 10 })
  const fakeWorker = (id: number, sessionKey: string, lastUsed: number, busy = false) => {
    const state = { destroyed: false }
    return {
      state,
      worker: {
        id,
        window: {
          isDestroyed: () => state.destroyed,
          destroy: () => {
            state.destroyed = true
          },
        },
        controller: { runJob: async () => ({ ok: false, type: "o1_code_thread_desync", error: "lost" }) },
        netWitness: { summarizeWindow: () => ({}) },
        agent: "CM_Opus5.5-High",
        protocolAgent: "CM_Opus5.5-High",
        sessionKey,
        subagent: false,
        busy,
        lastUsed,
      },
    }
  }
  const keys = [DESKTOP_KEY, CLI_KEY, OTHER_CLI_KEY]

  test("prune retires an idle non-desktop runtime tab and its mirror, keeping live and busy tabs", () => {
    const pool = new WorkerPool({ chatUrl: "https://example.test/chat" })
    const stale = Date.now() - 6 * 60 * 1000
    const abandoned = fakeWorker(1, CLI_KEY, stale)
    const desktop = fakeWorker(2, DESKTOP_KEY, stale)
    const otherRuntime = fakeWorker(3, OTHER_CLI_KEY, Date.now())
    const busy = fakeWorker(4, JSON.stringify(["cli", "runtime-C", "sess-A", "CM_Opus5.5-High"]), stale, true)
    const workers = Reflect.get(pool, "workers")
    for (const entry of [abandoned, desktop, otherRuntime, busy]) workers.set(entry.worker.id, entry.worker)
    keys.forEach(mirror)

    expect(pool.hasSession(CLI_KEY)).toBe(false)
    expect(abandoned.state.destroyed).toBe(true)
    expect(threadContextUsage(CLI_KEY)).toBeUndefined()
    expect(desktop.state.destroyed).toBe(false)
    expect(threadContextUsage(DESKTOP_KEY)?.totalTokens).toBe(10)
    expect(otherRuntime.state.destroyed).toBe(false)
    expect(threadContextUsage(OTHER_CLI_KEY)?.totalTokens).toBe(10)
    expect(busy.state.destroyed).toBe(false)
    expect(pool.hasSession(busy.worker.sessionKey)).toBe(true)

    pool.destroy()
    keys.forEach(resetThread)
  })

  test("discard after a pre-submit failure clears that tab's mirror", async () => {
    const pool = new WorkerPool({ chatUrl: "https://example.test/chat" })
    const entry = fakeWorker(5, CLI_KEY, Date.now(), true)
    Reflect.get(pool, "workers").set(entry.worker.id, entry.worker)
    Reflect.set(pool, "acquire", async () => entry.worker)
    mirror(CLI_KEY)

    const error = await pool.run({ id: "job", payload: { model: entry.worker.agent, sessionKey: CLI_KEY } }).then(
      () => null,
      (failure) => failure,
    )

    expect(Reflect.get(error, "type")).toBe("o1_code_thread_desync")
    expect(entry.state.destroyed).toBe(true)
    expect(threadContextUsage(CLI_KEY)).toBeUndefined()
    pool.destroy()
  })

  test.each([
    "o1_code_thread_desync",
    "o1_code_recorder_not_armed",
    "o1_code_greeting_not_settled",
    "o1_code_fresh_chat_failed",
    "o1_code_image_attachment_desync",
  ])("discards a direct pre-submit rejection %s and preserves its identity", async (type) => {
    const pool = new WorkerPool({ chatUrl: "https://example.test/chat" })
    const entry = fakeWorker(8, CLI_KEY, Date.now(), true)
    const failure = new Error("failed before RUN_JOB was posted")
    Reflect.set(failure, "type", type)
    Reflect.set(failure, "statusCode", 502)
    entry.worker.controller.runJob = async (job?: { id?: string }) => {
      expect(job?.id).toBe("job")
      throw failure
    }
    Reflect.get(pool, "workers").set(entry.worker.id, entry.worker)
    Reflect.set(pool, "acquire", async () => entry.worker)
    mirror(CLI_KEY)

    const error = await pool
      .run({ id: "job", payload: { model: entry.worker.agent, sessionKey: CLI_KEY, continueThread: true } })
      .catch((error) => error)

    expect(error).toBe(failure)
    expect(entry.state.destroyed).toBe(true)
    expect(Reflect.get(pool, "workers").has(entry.worker.id)).toBe(false)
    expect(threadContextUsage(CLI_KEY)).toBeUndefined()
    pool.destroy()
  })

  test("does not reclassify an uncertain generic controller rejection as pre-submit", async () => {
    const pool = new WorkerPool({ chatUrl: "https://example.test/chat" })
    const entry = fakeWorker(9, CLI_KEY, Date.now(), true)
    const failure = new Error("renderer evaluation failed after possible submission")
    entry.worker.controller.runJob = async (job?: { id?: string }) => {
      expect(job?.id).toBe("job")
      throw failure
    }
    Reflect.get(pool, "workers").set(entry.worker.id, entry.worker)
    Reflect.set(pool, "acquire", async () => entry.worker)
    mirror(CLI_KEY)

    const error = await pool
      .run({ id: "job", payload: { model: entry.worker.agent, sessionKey: CLI_KEY, continueThread: true } })
      .catch((error) => error)

    expect(error).toBe(failure)
    expect(Reflect.get(error, "type")).toBeUndefined()
    expect(entry.state.destroyed).toBe(false)
    expect(threadContextUsage(CLI_KEY)?.totalTokens).toBe(10)
    pool.destroy()
  })

  test("destroy clears every live tab's mirror", () => {
    const pool = new WorkerPool({ chatUrl: "https://example.test/chat" })
    const desktop = fakeWorker(6, DESKTOP_KEY, Date.now())
    const cli = fakeWorker(7, CLI_KEY, Date.now())
    const workers = Reflect.get(pool, "workers")
    workers.set(desktop.worker.id, desktop.worker)
    workers.set(cli.worker.id, cli.worker)
    keys.forEach(mirror)

    pool.destroy()

    expect(desktop.state.destroyed && cli.state.destroyed).toBe(true)
    expect(threadContextUsage(DESKTOP_KEY)).toBeUndefined()
    expect(threadContextUsage(CLI_KEY)).toBeUndefined()
    expect(threadContextUsage(OTHER_CLI_KEY)?.totalTokens).toBe(10)
    keys.forEach(resetThread)
  })
})

describe("submission witness boundary", () => {
  test("excludes launch and reset greetings, including late greeting completion", () => {
    let now = 100
    const witness = createCdpNetworkReducer(() => now)
    const request = { url: "https://open-web-assistant-cs.wpp.ai/v1/chat", method: "POST" }
    witness.handle("Network.requestWillBeSent", { requestId: "greeting", request })
    now = 200
    witness.handle("Network.loadingFinished", { requestId: "greeting", encodedDataLength: 100 })
    const start = submissionStartedAt({ submitted: { startedAtMs: 150 } }, 90)
    expect(witness.summarizeWindow(start).cdpRequestSeen).toBe(false)
    witness.handle("Network.requestWillBeSent", { requestId: "prompt", request })
    expect(witness.summarizeWindow(start).cdpRequestSeen).toBe(true)
  })

  test("uses error diagnostics and fails closed on missing or invalid timestamps", () => {
    expect(submissionStartedAt({ diagnostics: { submitted: { startedAtMs: 150 } } }, 90)).toBe(150)
    for (const startedAtMs of [undefined, null, "150", NaN, Infinity, 89, Date.now() + 60000]) {
      expect(submissionStartedAt({ submitted: { startedAtMs } }, 90)).toBe(Infinity)
    }
    expect(submissionStartedAt({}, 90)).toBe(Infinity)
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

    await expect(
      cleanupWindowOnFailure(window, async () => {
        throw new Error("startup failed")
      }),
    ).rejects.toThrow("startup failed")

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
