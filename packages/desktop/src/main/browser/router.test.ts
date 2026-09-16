import { expect, test } from "bun:test"
import type { ToolContext } from "@opencode-ai/plugin"
import {
  MAX_SNAPSHOT_BYTES,
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

test("global revoke/regrant interrupts in-flight input and allows a fresh operation", async () => {
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
    expect((await write(request)).ok).toBe(true)
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
