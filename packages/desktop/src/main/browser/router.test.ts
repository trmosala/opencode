import { expect, test } from "bun:test"
import { EventEmitter, getEventListeners } from "node:events"
import { ipcPort } from "@cookiemonster/cm-browser/port"
import { attachBrowserBridge } from "./bridge"
import type { ToolContext } from "@opencode-ai/plugin"
import {
  MAX_SNAPSHOT_BYTES,
  parseBrowserIpcRequest,
  type BrowserIpcResult,
  type BrowserIpcRequest,
  type Request,
  type WriteRequest,
} from "@cookiemonster/cm-browser/protocol"
import { browserTools } from "@cookiemonster/cm-browser/tools"
import { registerBrowserTab, setBrowserAgentEnabled, type BrowserRegistration } from "./registry"
import { routeBrowserRequest } from "./router"

function fixture(isAllowed = (url: string) => ["localhost", "127.0.0.1"].includes(new URL(url).hostname)) {
  const calls: string[] = []
  let url = "http://localhost/"
  const tab: BrowserRegistration = {
    id: "route-one",
    sessionID: "route-session",
    ownerID: 1,
    revision: 0,
    agentAccess: true,
    transferGuarded: true,
    contents: {
      isDestroyed: () => false,
      isLoadingMainFrame: () => false,
      stop: () => {},
      getURL: () => url,
      loadURL: async (next) => {
        url = next
        tab.revision++
      },
      debugger: {
        isAttached: () => true,
        attach: () => {},
        sendCommand: async (method) => {
          calls.push(method)
          return {
            result: {
              value: {
                url,
                title: "",
                visibleText: "hello",
                elements: [
                  {
                    tag: "button",
                    role: "",
                    label: "Send",
                    text: "Send",
                    fingerprint: "send",
                    rect: { x: 0, y: 0, width: 10, height: 10 },
                  },
                ],
              },
            },
          }
        },
      },
    },
  }
  const remove = registerBrowserTab(tab)
  const route = (request: Request, sessionID = tab.sessionID) =>
    routeBrowserRequest(
      { type: "browser_request", id: "request", sessionID, request } satisfies BrowserIpcRequest,
      isAllowed,
    )
  const write = async (request: WriteRequest) => {
    const prepared = await route({ op: "prepare_write", request })
    if (!prepared.ok) return prepared
    if (!prepared.result.context) throw new Error("Missing approval context")
    return route({ ...request, context: prepared.result.context })
  }
  return { tab, calls, remove, route, write }
}

test.each(["scroll", "wait_for_element"] as const)(
  "%s retains held native ownership and rejects interrupted epochs",
  async (op) => {
    for (const reason of ["cancel", "timeout", "revoke", "navigate", "unregister", "reject", "success"] as const) {
      const { tab, calls, route, remove } = fixture()
      const controller = new AbortController()
      const entered = Promise.withResolvers<void>()
      const held = Promise.withResolvers<void>()
      const settled = Promise.withResolvers<void>()
      const send = tab.contents.debugger.sendCommand.bind(tab.contents.debugger)
      const state = await route({ op: "read_state", tabID: tab.id })
      if (!state.ok) throw new Error("No snapshot")
      const request =
        op === "scroll"
          ? {
              op,
              tabID: tab.id,
              ref: state.result.elements[0].ref,
              deltaX: 0,
              deltaY: 20,
              timeoutMs: reason === "timeout" ? 50 : 1000,
            }
          : { op, tabID: tab.id, selector: "#ready", timeoutMs: reason === "timeout" ? 50 : 1000 }
      const prepared =
        op === "scroll" && request.op === "scroll" ? await route({ op: "prepare_write", request }) : undefined
      tab.contents.backgroundThrottling = true
      tab.contents.debugger.sendCommand = async (method, params) => {
        if (method === "Page.getFrameTree") return { frameTree: { frame: { id: "main" } } }
        if (method === "Page.createIsolatedWorld") return { executionContextId: 7 }
        if (params?.type === "mouseWheel" || params?.contextId === 7) {
          entered.resolve()
          await held.promise
          if (reason === "reject") throw new Error("Secret-bearing native exception must be suppressed")
          return { result: { value: true } }
        }
        return send(method, params)
      }
      const pending = routeBrowserRequest(
        {
          type: "browser_request",
          id: "held-observation",
          sessionID: tab.sessionID,
          request:
            request.op === "scroll"
              ? { ...request, context: prepared && prepared.ok ? prepared.result.context! : state.result.context! }
              : request,
        },
        () => true,
        {
          signal: controller.signal,
          onSettled: (operation) => {
            void operation.finally(() => settled.resolve())
          },
        },
      )
      try {
        await entered.promise
        if (reason === "cancel") controller.abort()
        if (reason === "revoke") {
          setBrowserAgentEnabled(false)
          setBrowserAgentEnabled(true)
          tab.agentAccess = true
        }
        if (reason === "navigate") await tab.contents.loadURL("http://localhost/new")
        if (reason === "unregister") remove()
        if (reason === "cancel" || reason === "timeout") {
          expect(await pending).toMatchObject({ code: reason === "cancel" ? "cancelled" : "timeout" })
          expect(tab.contents.backgroundThrottling).toBe(false)
          expect(await route({ op: "read_state", tabID: tab.id })).toMatchObject({ code: "unavailable" })
        }
        const count = calls.length
        held.resolve()
        const response = await pending
        await settled.promise
        expect(response).toMatchObject(
          reason === "success"
            ? { ok: true }
            : { code: reason === "cancel" ? "cancelled" : reason === "timeout" ? "timeout" : "unavailable" },
        )
        expect(JSON.stringify(response)).not.toContain("Secret-bearing")
        expect(tab.contents.backgroundThrottling).toBe(true)
        expect(getEventListeners(controller.signal, "abort")).toHaveLength(0)
        if (reason !== "success") expect(calls).toHaveLength(count)
        tab.contents.debugger.sendCommand = send
      } finally {
        held.resolve()
        controller.abort()
        await settled.promise
        remove()
        setBrowserAgentEnabled(true)
      }
    }
  },
)

test.each(["scroll", "wait_for_element", "wait_for_navigation"] as const)(
  "%s shares its deadline with final capture",
  async (op) => {
    const { tab, route, remove } = fixture()
    const send = tab.contents.debugger.sendCommand.bind(tab.contents.debugger)
    const entered = Promise.withResolvers<void>()
    const held = Promise.withResolvers<void>()
    const settled = Promise.withResolvers<void>()
    let ready = op !== "scroll"
    tab.contents.debugger.sendCommand = async (method, params) => {
      if (method === "Page.getFrameTree") return { frameTree: { frame: { id: "main" } } }
      if (method === "Page.createIsolatedWorld") return { executionContextId: 7 }
      if (params?.contextId === 7) return { result: { value: true } }
      if (method === "Page.getLayoutMetrics") return { cssVisualViewport: { clientWidth: 600, clientHeight: 400 } }
      if (params?.type === "mouseWheel") ready = true
      const value = await send(method, params)
      if (ready && params?.returnByValue) {
        entered.resolve()
        await held.promise
      }
      return value
    }
    const request =
      op === "scroll"
        ? { op, tabID: tab.id, deltaX: 0, deltaY: 1, timeoutMs: 400 }
        : op === "wait_for_element"
          ? { op, tabID: tab.id, selector: "#ready", timeoutMs: 400 }
          : { op, tabID: tab.id, url: tab.contents.getURL(), timeoutMs: 400 }
    const prepared = request.op === "scroll" ? await route({ op: "prepare_write", request }) : undefined
    const pending = routeBrowserRequest(
      {
        type: "browser_request",
        id: "final-capture",
        sessionID: tab.sessionID,
        request:
          request.op === "scroll"
            ? { ...request, context: prepared && prepared.ok ? prepared.result.context! : undefined! }
            : request,
      },
      () => true,
      {
        onSettled: (operation) => {
          void operation.finally(() => settled.resolve())
        },
      },
    )
    try {
      await entered.promise
      expect(await pending).toMatchObject({ code: "timeout" })
      expect(await route({ op: "read_state", tabID: tab.id })).toMatchObject({ code: "unavailable" })
      held.resolve()
      await settled.promise
      expect(tab.navigationAllowed).toBeUndefined()
      tab.contents.debugger.sendCommand = send
      expect((await route({ op: "read_state", tabID: tab.id })).ok).toBe(true)
    } finally {
      held.resolve()
      await settled.promise
      remove()
    }
  },
)

test("navigation wait tolerates loading, pins destination, and never blocks user navigation", async () => {
  const { tab, route, remove } = fixture()
  const load = tab.contents.loadURL.bind(tab.contents)
  let loading = true
  tab.contents.isLoadingMainFrame = () => loading
  tab.contents.stop = () => {
    throw new Error("Observation must not stop")
  }
  tab.contents.loadURL = async () => {
    throw new Error("Observation must not navigate")
  }
  const timer = setTimeout(() => {
    loading = false
    void load("http://localhost/done")
  }, 20)
  try {
    const pending = route({ op: "wait_for_navigation", tabID: tab.id, url: "http://localhost/done", timeoutMs: 1000 })
    expect(tab.navigationAllowed).toBeUndefined()
    expect(await pending).toMatchObject({ ok: true, result: { url: "http://localhost/done" } })
    const send = tab.contents.debugger.sendCommand.bind(tab.contents.debugger)
    tab.contents.debugger.sendCommand = async (method, params) => {
      const value = await send(method, params)
      tab.revision++
      return value
    }
    expect(
      await route({ op: "wait_for_navigation", tabID: tab.id, url: "http://localhost/done", timeoutMs: 1000 }),
    ).toMatchObject({ code: "unavailable" })
  } finally {
    clearTimeout(timer)
    remove()
  }
})

test.each(["cancel", "timeout", "revoke", "unregister", "navigate", "owner", "target-policy"])(
  "observation wait handles %s and cleans up without input",
  async (reason) => {
    let targetAllowed = true
    const { tab, calls, route, remove } = fixture((url) => !url.endsWith("/done") || targetAllowed)
    const controller = new AbortController()
    const request = {
      op: "wait_for_navigation",
      tabID: tab.id,
      url: "http://localhost/done",
      timeoutMs: reason === "timeout" ? 30 : 1000,
    } as const
    const pending = routeBrowserRequest(
      { type: "browser_request", id: "observe", sessionID: tab.sessionID, request },
      (url) => new URL(url).hostname === "localhost" && (!url.endsWith("/done") || targetAllowed),
      { signal: controller.signal },
    )
    try {
      if (reason === "cancel") controller.abort()
      if (reason === "revoke") {
        setBrowserAgentEnabled(false)
        setBrowserAgentEnabled(true)
        tab.agentAccess = true
      }
      if (reason === "unregister") remove()
      if (reason === "navigate") await tab.contents.loadURL("http://blocked.test/")
      if (reason === "owner") tab.ownerID++
      if (reason === "target-policy") targetAllowed = false
      expect(await pending).toMatchObject({
        code: reason === "cancel" ? "cancelled" : reason === "timeout" ? "timeout" : "unavailable",
      })
      await new Promise((resolve) => setImmediate(resolve))
      expect(getEventListeners(controller.signal, "abort")).toHaveLength(0)
      expect(tab.navigationAllowed).toBeUndefined()
      expect(calls).toEqual([])
      if (reason === "timeout" || reason === "cancel")
        expect((await route({ op: "read_state", tabID: tab.id })).ok).toBe(true)
    } finally {
      controller.abort()
      remove()
      setBrowserAgentEnabled(true)
    }
  },
)

test.each(["route-session", "foreign-session"])(
  "duplicate %s keeps the original IPC waiter cancellable",
  async (sessionID) => {
    const { tab, calls, remove } = fixture()
    const parent = new EventEmitter()
    const child = new EventEmitter()
    const requests: BrowserIpcRequest[] = []
    const replies: BrowserIpcResult[] = []
    const entered = Promise.withResolvers<void>()
    const held = Promise.withResolvers<void>()
    const settled = Promise.withResolvers<void>()
    const controller = new AbortController()
    let signal: AbortSignal | undefined
    const send = tab.contents.debugger.sendCommand.bind(tab.contents.debugger)
    tab.contents.debugger.sendCommand = async (method, params) => {
      entered.resolve()
      await held.promise
      return send(method, params)
    }
    const port = ipcPort(
      Object.assign(parent, {
        postMessage: (message: unknown) => {
          const request = parseBrowserIpcRequest(message)
          if (request) requests.push(request)
          child.emit("message", structuredClone(message))
        },
      }),
    )
    const stop = attachBrowserBridge(
      Object.assign(child, {
        postMessage: (message: BrowserIpcResult) => {
          replies.push(message)
          parent.emit("message", { data: structuredClone(message) })
        },
      }),
      (request, _allowed, control) => {
        signal = control.signal
        return routeBrowserRequest(request, () => true, {
          ...control,
          onSettled: (operation) => {
            control.onSettled?.(operation)
            void operation.finally(() => settled.resolve())
          },
        })
      },
    )
    try {
      const pending = port.send(tab.sessionID, { op: "read_state", tabID: tab.id }, controller.signal)
      await entered.promise
      child.emit("message", structuredClone({ ...requests[0], sessionID }))
      controller.abort()
      expect(await pending).toMatchObject({ code: "cancelled" })
      expect(signal?.aborted).toBe(true)
      expect(replies).toHaveLength(1)
      expect(replies[0]?.response).toMatchObject({ code: "cancelled" })
      expect(parent.listenerCount("message")).toBe(0)
      expect(getEventListeners(controller.signal, "abort")).toHaveLength(0)
      // The occupied ID stays reserved after the reply until real native settlement.
      child.emit("message", structuredClone(requests[0]))
      expect(replies).toHaveLength(1)
      held.resolve()
      await settled.promise
      await new Promise((resolve) => setImmediate(resolve))
      expect(calls).toHaveLength(1)
      expect(replies).toHaveLength(1)
    } finally {
      controller.abort()
      held.resolve()
      await settled.promise
      stop()
      remove()
    }
  },
)

test.each(["cancel", "exit"])(
  "port and sidecar %s retain a held navigation until native settlement",
  async (reason) => {
    const { tab, calls, remove } = fixture(() => true)
    const parent = new EventEmitter()
    const child = new EventEmitter()
    const frames: unknown[] = []
    const port = ipcPort(
      Object.assign(parent, {
        postMessage: (message: unknown) => {
          frames.push(message)
          child.emit("message", structuredClone(message))
        },
      }),
    )
    const stop = attachBrowserBridge(
      Object.assign(child, {
        postMessage: (message: unknown) => {
          parent.emit("message", { data: structuredClone(message) })
        },
      }),
    )
    const controller = new AbortController()
    const entered = Promise.withResolvers<void>()
    const held = Promise.withResolvers<void>()
    const load = tab.contents.loadURL.bind(tab.contents)
    let stops = 0
    tab.contents.backgroundThrottling = true
    tab.contents.stop = () => {
      stops++
    }
    tab.contents.loadURL = async (url) => {
      entered.resolve()
      await held.promise
      await load(url)
    }
    try {
      const request: WriteRequest = { op: "navigate", tabID: tab.id, url: "http://localhost/next" }
      const prepared = await port.send(tab.sessionID, { op: "prepare_write", request })
      if (!prepared.ok || !prepared.result.context) throw new Error("Preparation failed")
      const pending = port.send(tab.sessionID, { ...request, context: prepared.result.context }, controller.signal)
      await entered.promise
      if (reason === "exit") child.emit("exit", 1)
      controller.abort()
      expect(await pending).toMatchObject({ code: "cancelled" })
      expect(parent.listenerCount("message")).toBe(0)
      expect(getEventListeners(controller.signal, "abort")).toHaveLength(0)
      expect(JSON.stringify(frames)).not.toContain("signal")
      expect(frames.at(-1)).toMatchObject({ type: "browser_cancel", sessionID: tab.sessionID })
      expect(tab.contents.backgroundThrottling).toBe(false)
      expect(tab.navigationAllowed).toBeDefined()
      expect(
        await routeBrowserRequest(
          {
            type: "browser_request",
            id: "overlap",
            sessionID: tab.sessionID,
            request: { ...request, context: prepared.result.context },
          },
          () => true,
        ),
      ).toMatchObject({ code: "unavailable" })
      // A user's independently observed navigation is not stopped on cancellation.
      await load("http://localhost/user")
      expect(stops).toBe(0)
      held.resolve()
      await new Promise((resolve) => setImmediate(resolve))
      expect(calls).toEqual([])
      expect(tab.contents.backgroundThrottling).toBe(true)
      expect(tab.navigationAllowed).toBeUndefined()
      expect(
        (
          await routeBrowserRequest(
            {
              type: "browser_request",
              id: "recover",
              sessionID: tab.sessionID,
              request: { op: "read_state", tabID: tab.id },
            },
            () => true,
          )
        ).ok,
      ).toBe(true)
    } finally {
      held.resolve()
      controller.abort()
      stop()
      remove()
    }
  },
)

test("deadline reached inside a native completion is typed timeout, not unavailable", async () => {
  const { tab, route, remove } = fixture()
  const original = tab.contents.debugger.sendCommand.bind(tab.contents.debugger)
  const deadline = Date.now() + 25
  tab.contents.debugger.sendCommand = async (method, params) => {
    const value = await original(method, params)
    // Hold this turn past the deadline, before the main timer gets its turn.
    while (Date.now() <= deadline) {}
    return value
  }
  try {
    expect(
      await routeBrowserRequest(
        {
          type: "browser_request",
          id: "deadline",
          sessionID: tab.sessionID,
          request: { op: "read_state", tabID: tab.id },
        },
        () => true,
        { deadline },
      ),
    ).toMatchObject({ code: "timeout" })
    tab.contents.debugger.sendCommand = original
    expect((await route({ op: "read_state", tabID: tab.id })).ok).toBe(true)
  } finally {
    remove()
  }
})

test.each(["cancel", "deadline"])(
  "%s bounds response but retains native ownership until settlement",
  async (reason) => {
    const { tab, calls, route, remove } = fixture()
    const entered = Promise.withResolvers<void>()
    const held = Promise.withResolvers<void>()
    const settled = Promise.withResolvers<void>()
    const controller = new AbortController()
    const original = tab.contents.debugger.sendCommand.bind(tab.contents.debugger)
    tab.contents.backgroundThrottling = true
    tab.contents.debugger.sendCommand = async (method, params) => {
      const value = await original(method, params)
      if (method === "Input.dispatchKeyEvent") {
        entered.resolve()
        await held.promise
      }
      return value
    }
    const request: WriteRequest = { op: "press_key", tabID: tab.id, key: "Enter", modifiers: [] }
    try {
      const prepared = await route({ op: "prepare_write", request })
      if (!prepared.ok || !prepared.result.context) throw new Error("Preparation failed")
      const pending = routeBrowserRequest(
        {
          type: "browser_request",
          id: "held",
          sessionID: tab.sessionID,
          request: { ...request, context: prepared.result.context },
        },
        () => true,
        {
          signal: controller.signal,
          deadline: Date.now() + (reason === "deadline" ? 50 : 15000),
          onSettled: (operation) => {
            void operation.finally(() => settled.resolve())
          },
        },
      )
      await entered.promise
      if (reason === "cancel") controller.abort()
      expect(await pending).toMatchObject({ code: reason === "cancel" ? "cancelled" : "timeout" })
      expect(tab.contents.backgroundThrottling).toBe(false)
      expect(tab.navigationAllowed).toBeDefined()
      expect(await route({ op: "read_state", tabID: tab.id })).toMatchObject({ code: "unavailable" })
      held.resolve()
      await settled.promise
      expect(calls.filter((method) => method === "Input.dispatchKeyEvent")).toHaveLength(1)
      expect(tab.contents.backgroundThrottling).toBe(true)
      expect(tab.navigationAllowed).toBeUndefined()
      tab.contents.debugger.sendCommand = original
      const count = calls.length
      expect(await route({ op: "read_state", tabID: tab.id })).toMatchObject({
        code: "unavailable",
        error: expect.stringContaining("Close this tab"),
      })
      // Regrant, snapshot invalidation, and document replacement cannot reset native input.
      setBrowserAgentEnabled(false)
      setBrowserAgentEnabled(true)
      tab.agentAccess = true
      await tab.contents.loadURL("http://localhost/reloaded")
      expect(await route({ op: "prepare_write", request })).toMatchObject({ code: "unavailable" })
      expect(await route({ op: "read_state", tabID: tab.id })).toMatchObject({ code: "unavailable" })
      expect(calls).toHaveLength(count)
      // Only a genuinely new native view is eligible again, even with the same tab identity.
      remove()
      const fresh = fixture()
      try {
        expect((await fresh.route({ op: "read_state", tabID: fresh.tab.id })).ok).toBe(true)
        expect((await fresh.write(request)).ok).toBe(true)
      } finally {
        fresh.remove()
      }
    } finally {
      held.resolve()
      controller.abort()
      remove()
    }
  },
)

test.each(["remove", "replace", "move"])("registration %s during await blocks follow-on commands", async (change) => {
  const { tab, calls, route, write, remove } = fixture()
  const original = tab.contents.debugger.sendCommand.bind(tab.contents.debugger)
  let removeReplacement = () => {}
  tab.contents.debugger.sendCommand = async (method, params) => {
    const value = await original(method, params)
    if (change === "move") tab.sessionID = "foreign"
    else {
      remove()
      if (change === "replace") removeReplacement = registerBrowserTab({ ...tab })
    }
    return value
  }
  try {
    expect(await write({ op: "press_key", tabID: tab.id, key: "Enter", modifiers: [] })).toMatchObject({ ok: false })
    expect(calls.some((method) => method.startsWith("Input."))).toBe(false)
    expect(tab.navigationAllowed).toBeUndefined()
    removeReplacement()
    remove()
    tab.sessionID = "route-session"
    tab.contents.debugger.sendCommand = original
    removeReplacement = registerBrowserTab(tab)
    expect((await route({ op: "read_state", tabID: tab.id })).ok).toBe(true)
  } finally {
    remove()
    removeReplacement()
  }
})

test("loading rejects preparation and dispatch, including loading begun during driver awaits", async () => {
  const { tab, calls, route, remove } = fixture()
  let loading = false
  Object.assign(tab.contents, { isLoadingMainFrame: () => loading })
  const request: WriteRequest = { op: "press_key", tabID: tab.id, key: "Enter", modifiers: [] }
  try {
    const prepared = await route({ op: "prepare_write", request })
    if (!prepared.ok || !prepared.result.context) throw new Error("Preparation failed")
    loading = true
    expect(await route({ op: "prepare_write", request })).toMatchObject({ code: "unavailable" })
    expect(await route({ ...request, context: prepared.result.context })).toMatchObject({ code: "unavailable" })
    expect(await route({ op: "read_state", tabID: tab.id })).toMatchObject({ code: "unavailable" })
    expect(calls).toEqual([])
    loading = false
    const original = tab.contents.debugger.sendCommand
    tab.contents.debugger.sendCommand = async (method, params) => {
      const result = await original(method, params)
      loading = true
      return result
    }
    expect(await route({ ...request, context: prepared.result.context })).toMatchObject({ code: "unavailable" })
    expect(calls.some((method) => method.startsWith("Input."))).toBe(false)
  } finally {
    remove()
  }
})

test("long source permits approved short navigation but rejects exact source mutation and A-B-A", async () => {
  const { tab, route, remove } = fixture()
  const source = "http://localhost/?history=" + "x".repeat(8000)
  const request: WriteRequest = { op: "navigate", tabID: tab.id, url: "http://127.0.0.1/" }
  try {
    await tab.contents.loadURL(source)
    const prepared = await route({ op: "prepare_write", request })
    expect(prepared.ok).toBe(true)
    if (!prepared.ok || !prepared.result.context) throw new Error("Preparation failed")
    expect(JSON.stringify(prepared.result.context).length).toBeLessThan(512)
    await tab.contents.loadURL(source + "b")
    const revision = tab.revision
    tab.revision = prepared.result.context.revision
    expect(await route({ ...request, context: prepared.result.context })).toMatchObject({ code: "access_denied" })
    tab.revision = revision
    await tab.contents.loadURL(source)
    expect(await route({ ...request, context: prepared.result.context })).toMatchObject({ code: "access_denied" })
    const asked: string[][] = []
    await browserTools({ send: (sessionID, request) => route(request, sessionID) }).browser_navigate.execute(
      { tabID: tab.id, url: request.url },
      {
        sessionID: tab.sessionID,
        messageID: "long",
        agent: "build",
        directory: ".",
        worktree: ".",
        abort: new AbortController().signal,
        metadata: () => {},
        ask: async (input) => {
          asked.push(input.patterns)
        },
      },
    )
    expect(asked).toEqual([["127.0.0.1"]])
    expect(tab.contents.getURL()).toBe(request.url)
  } finally {
    remove()
  }
})

test("agent routing enforces session, opt-in, allowlist, cross-tab refs and revocation", async () => {
  const { tab, calls, route, write, remove } = fixture()
  tab.agentAccess = false
  const second = { ...tab, id: "route-two", agentAccess: true }
  const removeSecond = registerBrowserTab(second)
  try {
    expect(await route({ op: "read_state", tabID: tab.id }, "other")).toMatchObject({ code: "no_target" })
    expect(await route({ op: "read_state", tabID: tab.id })).toMatchObject({ code: "access_denied" })
    expect(calls).toEqual([])
    const list = await route({ op: "list_tabs" })
    expect(list.ok && list.result.tabs?.map((tab) => tab.tabID)).toEqual([second.id])
    tab.agentAccess = true
    expect(await write({ op: "navigate", tabID: tab.id, url: "https://blocked.test/" })).toMatchObject({
      code: "blocked_host",
    })
    expect(tab.contents.getURL()).toBe("http://localhost/")
    expect((await write({ op: "navigate", tabID: tab.id, url: "http://localhost/next" })).ok).toBe(true)
    const snapshot = await route({ op: "read_state", tabID: tab.id })
    if (!snapshot.ok) throw new Error(snapshot.error)
    const ref = snapshot.result.elements[0].ref
    await route({ op: "read_state", tabID: second.id })
    expect(await write({ op: "click", tabID: second.id, ref })).toMatchObject({ code: "stale_ref" })
    const original = tab.contents.debugger.sendCommand
    tab.contents.debugger.sendCommand = async (method, params) => {
      const result = await original(method, params)
      if (method === "Input.dispatchMouseEvent") tab.agentAccess = false
      return result
    }
    expect(await write({ op: "fill", tabID: tab.id, ref, text: "private" })).toMatchObject({ ok: false })
    expect(calls.includes("Input.dispatchKeyEvent")).toBe(false)
  } finally {
    remove()
    removeSecond()
  }
})

test("global off/on and fresh tab consent cannot revive old refs", async () => {
  const { tab, calls, route, write, remove } = fixture()
  try {
    const snapshot = await route({ op: "read_state", tabID: tab.id })
    if (!snapshot.ok) throw new Error(snapshot.error)
    setBrowserAgentEnabled(false)
    expect(tab.agentAccess).toBe(false)
    expect(tab.transferGuarded).toBe(true)
    setBrowserAgentEnabled(true)
    tab.agentAccess = true
    const response = await write({ op: "click", tabID: tab.id, ref: snapshot.result.elements[0].ref })
    expect(response).toMatchObject({ ok: false, code: "stale_ref" })
    expect(calls.some((method) => method.startsWith("Input."))).toBe(false)
  } finally {
    remove()
    setBrowserAgentEnabled(true)
  }
})

test("main rejects unbound and altered write contexts before driver dispatch", async () => {
  const { tab, calls, route, remove } = fixture()
  try {
    const requests: WriteRequest[] = [
      { op: "press_key", tabID: tab.id, key: "Enter", modifiers: [] },
      { op: "click", tabID: tab.id, ref: "old:e0" },
      { op: "fill", tabID: tab.id, ref: "old:e0", text: "private" },
      { op: "navigate", tabID: tab.id, url: "http://127.0.0.1/" },
    ]
    for (const request of requests) {
      const prepared = await route({ op: "prepare_write", request })
      if (!prepared.ok || !prepared.result.context) throw new Error("Preparation failed")
      const context = prepared.result.context
      expect(await route(request as Request)).toMatchObject({ code: "bad_request" })
      expect(await route({ ...request, context }, "other")).toMatchObject({ code: "no_target" })
      for (const changed of [
        { ...context, tabID: "other" },
        { ...context, origin: "http://127.0.0.1" },
        { ...context, urlHash: "0".repeat(64) },
        { ...context, revision: context.revision + 1 },
        { ...context, accessRevision: context.accessRevision + 1 },
      ])
        expect(await route({ ...request, context: changed })).toMatchObject({ code: "access_denied" })
    }
    expect(calls).toEqual([])
    expect(tab.contents.getURL()).toBe("http://localhost/")
  } finally {
    remove()
  }
})

test("navigation binds its source but permits its own destination and page revision changes", async () => {
  const { tab, route, write, remove } = fixture()
  try {
    await tab.contents.loadURL("about:blank")
    const request: WriteRequest = { op: "navigate", tabID: tab.id, url: "http://127.0.0.1/" }
    const prepared = await route({ op: "prepare_write", request })
    if (!prepared.ok || !prepared.result.context) throw new Error("Preparation failed")
    expect(prepared.result.context.origin).toBe("about:blank")
    expect((await route({ ...request, context: prepared.result.context })).ok).toBe(true)
    expect(tab.contents.getURL()).toBe(request.url)
    expect((await write({ op: "press_key", tabID: tab.id, key: "Enter", modifiers: [] })).ok).toBe(true)
  } finally {
    remove()
  }
})

test.each(["source", "access", "destination"])(
  "recovery rechecks %s after waiting for the old load to stop",
  async (change) => {
    const hosts = new Set(["localhost", "127.0.0.1"])
    const { tab, route, remove } = fixture((url) => hosts.has(new URL(url).hostname))
    let loading = true
    let loads = 0
    let timer: ReturnType<typeof setTimeout> | undefined
    const load = tab.contents.loadURL
    tab.contents.loadURL = async (url) => {
      loads++
      await load(url)
    }
    tab.contents.isLoadingMainFrame = () => loading
    tab.contents.stop = () => {
      timer = setTimeout(() => {
        loading = false
        if (change === "source") tab.revision++
        if (change === "access") tab.accessRevision = (tab.accessRevision ?? 0) + 1
        if (change === "destination") hosts.delete("127.0.0.1")
      }, 10)
    }
    try {
      const request: WriteRequest = { op: "navigate", tabID: tab.id, url: "http://127.0.0.1/" }
      const prepared = await route({ op: "prepare_write", request })
      if (!prepared.ok || !prepared.result.context) throw new Error("Preparation failed")
      const response = await route({ ...request, context: prepared.result.context })
      expect(loads).toBe(0)
      expect(response).toMatchObject({ code: "unavailable" })
      expect(tab.contents.getURL()).toBe("http://localhost/")
      expect(hosts.has("localhost")).toBe(true)
    } finally {
      clearTimeout(timer)
      remove()
    }
  },
)

test("oversized tab listing fails bounded without truncating source identity or blocking recovery", async () => {
  const { tab, route, write, remove } = fixture()
  const source = "http://localhost/?history=" + "x".repeat(MAX_SNAPSHOT_BYTES)
  try {
    await tab.contents.loadURL(source)
    const response = await route({ op: "list_tabs" })
    expect(Buffer.byteLength(JSON.stringify(response))).toBeLessThanOrEqual(MAX_SNAPSHOT_BYTES)
    expect(response).toMatchObject({ ok: false, code: "unavailable" })
    expect(tab.contents.getURL()).toBe(source)
    const recovered = await write({ op: "navigate", tabID: tab.id, url: "http://127.0.0.1/" })
    expect(recovered.ok).toBe(true)
    expect(tab.contents.getURL()).toBe("http://127.0.0.1/")
    expect((await route({ op: "list_tabs" })).ok).toBe(true)
  } finally {
    remove()
  }
})

test("global revoke/regrant cannot recover interrupted input on the same view", async () => {
  const { tab, calls, write, remove } = fixture()
  const original = tab.contents.debugger.sendCommand
  try {
    tab.contents.debugger.sendCommand = async (method, params) => {
      const result = await original(method, params)
      if (method === "Input.dispatchKeyEvent") {
        setBrowserAgentEnabled(false)
        setBrowserAgentEnabled(true)
        tab.agentAccess = true
      }
      return result
    }
    const request: WriteRequest = { op: "press_key", tabID: tab.id, key: "Enter", modifiers: [] }
    expect(await write(request)).toMatchObject({ code: "unavailable" })
    expect(calls.filter((method) => method === "Input.dispatchKeyEvent")).toHaveLength(1)
    expect(tab.transferGuarded).toBe(true)
    tab.contents.debugger.sendCommand = original
    const count = calls.length
    expect(await write(request)).toMatchObject({
      code: "unavailable",
      error: expect.stringContaining("Close this tab"),
    })
    expect(calls).toHaveLength(count)
  } finally {
    remove()
    setBrowserAgentEnabled(true)
  }
})

test.each(["A to B", "A to B to A", "reload", "tab regrant", "global regrant"])(
  "press_key rejects approval after %s",
  async (change) => {
    const { tab, calls, route, remove } = fixture()
    const waiting = Promise.withResolvers<void>()
    const approval = Promise.withResolvers<void>()
    const context: ToolContext = {
      sessionID: tab.sessionID,
      messageID: "message",
      agent: "build",
      directory: ".",
      worktree: ".",
      abort: new AbortController().signal,
      metadata: () => {},
      ask: async (input) => {
        if (input.permission !== "browser_press_key") return
        expect(input.patterns).toEqual(["localhost"])
        waiting.resolve()
        await approval.promise
      },
    }
    try {
      const pending = browserTools({
        send: (sessionID, request) => route(request, sessionID),
      }).browser_press_key.execute({ tabID: tab.id, key: "Enter" }, context)
      await waiting.promise
      if (change.startsWith("A to B")) await tab.contents.loadURL("http://127.0.0.1/")
      if (change === "A to B to A" || change === "reload") await tab.contents.loadURL("http://localhost/")
      if (change === "tab regrant") {
        tab.agentAccess = false
        tab.accessRevision = (tab.accessRevision ?? 0) + 1
        tab.agentAccess = true
      }
      if (change === "global regrant") {
        setBrowserAgentEnabled(false)
        setBrowserAgentEnabled(true)
        tab.agentAccess = true
      }
      approval.resolve()
      await expect(pending).rejects.toThrow(/access_denied/)
      expect(calls).toEqual([])
    } finally {
      approval.resolve()
      remove()
      setBrowserAgentEnabled(true)
    }
  },
)
