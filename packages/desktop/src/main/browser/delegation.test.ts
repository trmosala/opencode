import { expect, test } from "bun:test"
import { EventEmitter } from "node:events"
import { randomUUID } from "node:crypto"
import type { BrowserIpcResult, Request, WriteRequest } from "@cookiemonster/cm-browser/protocol"
import { attachBrowserBridge } from "./bridge"
import { resolveBrowserOwnerScope, setBrowserOwnerScopeResolver } from "./session-resolver"
import { createBrowserDelegations } from "./delegation"
import { routeBrowserRequest } from "./router"
import {
  browserOperationBusy,
  browserTabReserved,
  registerBrowserTab,
  revokeBrowserAccess,
  invalidateBrowserDocument,
  setBrowserTabHandler,
  setBrowserHistoryHandler,
  type BrowserRegistration,
} from "./registry"
import type { BrowserSession, BrowserSessionResolver } from "./session-resolver"

const tick = () => new Promise((resolve) => setImmediate(resolve))

function fixture() {
  let url = "https://example.test/private"
  let owner = "owner-1"
  let scope = {
    projectID: "project",
    directory: process.cwd(),
    workspaceID: "work",
    serverURL: "http://127.0.0.1:4096",
    generation: 0,
  }
  const clearScopeResolver = setBrowserOwnerScopeResolver(async () => ({
    projectID: "project",
    directory: process.cwd(),
    workspaceID: "work",
    serverURL: "http://127.0.0.1:4096",
  }))
  const commands: string[] = []
  const frame = { detached: false }
  const contents = Object.assign(new EventEmitter(), {
    mainFrame: frame,
    focusedFrame: frame,
    getURL: () => url,
    isDestroyed: () => false,
    isLoadingMainFrame: () => false,
    stop() {},
    async loadURL(next: string) {
      url = next
      tab.revision++
    },
    debugger: {
      isAttached: () => true,
      attach() {},
      async sendCommand(method: string): Promise<unknown> {
        commands.push(method)
        if (method === "Page.getFrameTree")
          return {
            frameTree: { frame: { id: "main", loaderId: "one", url, securityOrigin: new URL(url).origin } },
          }
        if (method === "Page.createIsolatedWorld") return { executionContextId: 1 }
        return {
          result: { value: { generation: "one", url, title: "Private", visibleText: "private data", elements: [] } },
        }
      },
    },
  })
  const tab: BrowserRegistration = {
    id: randomUUID(),
    sessionID: "parent",
    ownerID: 1,
    agentAccess: true,
    revision: 0,
    accessRevision: 0,
    contents,
    ownerContext: () => owner,
    ownerScope: () => scope,
    async resolveOwnerScope(signal) {
      scope = await resolveBrowserOwnerScope(tab.sessionID, signal)
      return scope
    },
  }
  const remove = registerBrowserTab(tab)
  const resolve: BrowserSessionResolver = async (id) => ({
    id,
    ...(id === "parent" ? {} : { parentID: "parent" }),
    projectID: "project",
    workspaceID: "work",
    directory: process.cwd(),
  })
  const manager = createBrowserDelegations(resolve)
  const grant = (
    executionID = "exec",
    childSessionID = "child",
    tabIDs = [tab.id],
    signal = new AbortController().signal,
  ) => manager.run("parent", { op: "grant_tabs", executionID, childSessionID, tabIDs }, signal, () => {})
  const revoke = (executionID = "exec") =>
    manager.run("parent", { op: "revoke_tabs", executionID }, new AbortController().signal, () => {})
  const route = (request: Request, sessionID = "child") =>
    routeBrowserRequest({ type: "browser_request", id: randomUUID(), sessionID, request }, undefined, {
      authority: manager.authority(sessionID),
    })
  return {
    tab,
    contents,
    commands,
    resolve,
    manager,
    grant,
    revoke,
    route,
    move(next: string) {
      url = next
      invalidateBrowserDocument(tab)
    },
    reowner() {
      owner = "owner-2"
    },
    close() {
      manager.stop()
      clearScopeResolver()
      remove()
    },
  }
}

test.each([false, true])("exact native tabs delegate with user/agent ownership: %s", async (agent) => {
  const f = fixture()
  const other = { ...f.tab, id: randomUUID() }
  const removeOther = registerBrowserTab(other)
  if (agent) f.tab.agentOwnerSessionID = "parent"
  try {
    expect(await f.grant()).toMatchObject({ ok: true, result: { delegation: { executionID: "exec", active: true } } })
    expect(f.tab.sessionID).toBe("parent")
    expect(f.tab.agentOwnerSessionID).toBe(agent ? "parent" : undefined)
    expect(await f.route({ op: "list_tabs" })).toMatchObject({ ok: true, result: { tabs: [{ tabID: f.tab.id }] } })
    expect(await f.route({ op: "read_state", tabID: f.tab.id })).toMatchObject({ ok: true })
    expect(await f.route({ op: "read_state", tabID: other.id })).toMatchObject({ ok: false })
    expect(await f.route({ op: "read_state", tabID: f.tab.id }, "sibling")).toMatchObject({ ok: false })
    expect(await f.route({ op: "read_state", tabID: f.tab.id }, "grandchild")).toMatchObject({ ok: false })
    expect(await f.route({ op: "read_state", tabID: f.tab.id }, "parent")).toMatchObject({ ok: false })
    const next: WriteRequest = { op: "navigate", tabID: f.tab.id, url: "https://other.test/next" }
    const prepared = await f.route({ op: "prepare_write", request: next })
    if (!prepared.ok || !prepared.result.context) throw new Error("Missing write context")
    expect(await f.route({ ...next, context: prepared.result.context })).toMatchObject({ ok: true })
    expect(f.manager.authority("child").resolve(f.tab.id)).toBe(f.tab)
    expect(await f.revoke()).toMatchObject({ ok: true, result: { delegation: { active: false } } })
    expect(await f.route({ op: "read_state", tabID: f.tab.id })).toMatchObject({ ok: false })
    expect(await f.route({ ...next, context: prepared.result.context }, "parent")).toMatchObject({ ok: false })
    expect(await f.route({ op: "read_state", tabID: f.tab.id }, "parent")).toMatchObject({ ok: true })
  } finally {
    removeOther()
    f.close()
  }
})

test.each([
  { id: "wrong" },
  { parentID: "sibling" },
  { parentID: "child" },
  { parentID: undefined },
  { projectID: "other" },
  { workspaceID: "other" },
  { directory: "other" },
] satisfies Partial<BrowserSession>[])("independent child verification rejects %j", async (change) => {
  const f = fixture()
  const manager = createBrowserDelegations(async (id, scope, signal) => ({
    ...(await f.resolve(id, scope, signal)),
    ...(id === "child" ? change : {}),
  }))
  try {
    await expect(
      manager.run(
        "parent",
        {
          op: "grant_tabs",
          executionID: "exec",
          childSessionID: "child",
          tabIDs: [f.tab.id],
        },
        new AbortController().signal,
        () => {},
      ),
    ).rejects.toThrow()
    expect(manager.authority("child").resolve(f.tab.id)).toBeUndefined()
    expect(browserTabReserved(f.tab)).toBe(false)
  } finally {
    manager.stop()
    f.close()
  }
})

test.each(["consent", "scope", "owner", "foreign", "busy", "parent-id"] as const)(
  "grant rejects missing native authority: %s",
  async (mode) => {
    const f = fixture()
    if (mode === "consent") f.tab.agentAccess = false
    if (mode === "scope") f.tab.ownerScope = undefined
    if (mode === "owner") f.tab.ownerContext = undefined
    if (mode === "foreign") f.tab.sessionID = "other"
    if (mode === "busy") browserOperationBusy.add(f.tab.id)
    const manager =
      mode === "parent-id"
        ? createBrowserDelegations(async (id, scope, signal) => ({
            ...(await f.resolve(id, scope, signal)),
            id: "wrong",
          }))
        : f.manager
    try {
      await expect(
        manager.run(
          "parent",
          {
            op: "grant_tabs",
            executionID: "exec",
            childSessionID: "child",
            tabIDs: [f.tab.id],
          },
          new AbortController().signal,
          () => {},
        ),
      ).rejects.toThrow()
      expect(browserTabReserved(f.tab)).toBe(false)
    } finally {
      browserOperationBusy.delete(f.tab.id)
      manager.stop()
      f.close()
    }
  },
)

test("no onward grants, competing child/tab leases, or cross-sidecar exposure", async () => {
  const f = fixture()
  const other = createBrowserDelegations(f.resolve)
  try {
    await f.grant()
    expect(other.authority("child").resolve(f.tab.id)).toBeUndefined()
    expect(other.authority("parent").resolve(f.tab.id)).toBeUndefined()
    await expect(f.grant("second")).rejects.toThrow()
    await expect(f.grant("third", "sibling")).rejects.toThrow()
    await expect(
      f.manager.run(
        "child",
        {
          op: "grant_tabs",
          executionID: "onward",
          childSessionID: "grandchild",
          tabIDs: [f.tab.id],
        },
        new AbortController().signal,
        () => {},
      ),
    ).rejects.toThrow()
    await expect(
      other.run(
        "parent",
        {
          op: "grant_tabs",
          executionID: "exec",
          childSessionID: "other-child",
          tabIDs: [f.tab.id],
        },
        new AbortController().signal,
        () => {},
      ),
    ).rejects.toThrow()
    expect(f.manager.authority("child").resolve(f.tab.id)).toBe(f.tab)
  } finally {
    other.stop()
    f.close()
  }
})

test("delegation never sends child history/lifecycle requests to the parent's native group", async () => {
  const f = fixture()
  const sessions: string[] = []
  setBrowserTabHandler(async (id) => {
    sessions.push(id)
    return { ok: false, code: "no_target", error: "" }
  })
  setBrowserHistoryHandler(async (id) => {
    sessions.push(id)
    return { ok: false, code: "no_target", error: "" }
  })
  try {
    await f.grant()
    for (const request of [
      { op: "prepare_tab", request: { op: "create_tab" } },
      { op: "prepare_tab", request: { op: "close_tab", tabID: f.tab.id } },
      { op: "search_history", query: "", limit: 1 },
    ] satisfies Request[])
      await f.route(request)
    expect(sessions).toEqual(["child", "child", "child"])
    expect(await f.route({ op: "prepare_tab", request: { op: "close_tab", tabID: f.tab.id } }, "parent")).toMatchObject(
      { ok: false },
    )
    expect(sessions).toHaveLength(3)
  } finally {
    setBrowserTabHandler(undefined)
    setBrowserHistoryHandler(async () => ({ ok: false, code: "no_target", error: "" }))
    f.close()
  }
})

test.each(["revoke-first", "revoke-pending", "abort-pending", "stop-pending"] as const)(
  "execution admission never resurrects: %s",
  async (mode) => {
    const f = fixture()
    const wait = Promise.withResolvers<void>()
    const controller = new AbortController()
    const manager = createBrowserDelegations(async (id, scope, signal) => {
      await wait.promise
      return f.resolve(id, scope, signal)
    })
    const request = { op: "grant_tabs", executionID: "exec", childSessionID: "child", tabIDs: [f.tab.id] } as const
    const revoke = () =>
      manager.run("parent", { op: "revoke_tabs", executionID: "exec" }, new AbortController().signal, () => {})
    try {
      if (mode === "revoke-first") await revoke()
      const granted = manager
        .run("parent", request, controller.signal, () => {})
        .then(
          () => true,
          () => false,
        )
      if (mode === "revoke-pending") await revoke()
      if (mode === "abort-pending") controller.abort()
      if (mode === "stop-pending") manager.stop()
      wait.resolve()
      expect(await granted).toBe(false)
      await expect(manager.run("parent", request, new AbortController().signal, () => {})).rejects.toThrow()
      expect(browserTabReserved(f.tab)).toBe(false)
    } finally {
      wait.resolve()
      manager.stop()
      f.close()
    }
  },
)

test.each(["consent", "owner", "agent-owner", "session", "scope", "deadline"] as const)(
  "captured authority revokes permanently: %s",
  async (mode) => {
    const f = fixture()
    const manager =
      mode === "deadline" ? createBrowserDelegations(f.resolve, { executions: 8, duration: 25 }) : f.manager
    try {
      await manager.run(
        "parent",
        { op: "grant_tabs", executionID: "exec", childSessionID: "child", tabIDs: [f.tab.id] },
        new AbortController().signal,
        () => {},
      )
      const authority = manager.authority("child")
      if (mode === "consent") revokeBrowserAccess(f.tab)
      if (mode === "owner") f.reowner()
      if (mode === "agent-owner") f.tab.agentOwnerSessionID = "other"
      if (mode === "session") f.tab.sessionID = "other"
      if (mode === "scope")
        f.tab.ownerScope = () => ({
          ...f.tab.ownerScope!()!,
          directory: "other",
        })
      if (mode === "deadline") await new Promise((resolve) => setTimeout(resolve, 40))
      expect(() => authority.check()).toThrow()
      expect(authority.signal?.aborted).toBe(true)
      f.tab.agentAccess = true
      expect(() => authority.check()).toThrow()
      expect(manager.authority("child").resolve(f.tab.id)).toBeUndefined()
    } finally {
      manager.stop()
      f.close()
    }
  },
)

test("bounded tombstone table preserves live leases and rejects all future admission when saturated", async () => {
  const f = fixture()
  const manager = createBrowserDelegations(f.resolve, { executions: 1, duration: 10_000 })
  try {
    await manager.run(
      "parent",
      { op: "grant_tabs", executionID: "live", childSessionID: "child", tabIDs: [f.tab.id] },
      new AbortController().signal,
      () => {},
    )
    await manager.run("parent", { op: "revoke_tabs", executionID: "unknown" }, new AbortController().signal, () => {})
    expect(manager.authority("child").resolve(f.tab.id)).toBe(f.tab)
    await manager.run("parent", { op: "revoke_tabs", executionID: "live" }, new AbortController().signal, () => {})
    await expect(
      manager.run(
        "parent",
        {
          op: "grant_tabs",
          executionID: "unknown",
          childSessionID: "child",
          tabIDs: [f.tab.id],
        },
        new AbortController().signal,
        () => {},
      ),
    ).rejects.toThrow()
  } finally {
    manager.stop()
    f.close()
  }
})

test.each(["list_tabs", "prepare_write"] as const)("revoke between routing and delivery suppresses %s", async (op) => {
  const f = fixture()
  const replies: BrowserIpcResult[] = []
  const child = Object.assign(new EventEmitter(), { postMessage: (reply: BrowserIpcResult) => replies.push(reply) })
  const stop = attachBrowserBridge(
    child,
    async (message, policy, control) => {
      const result = await routeBrowserRequest(message, policy, control)
      child.emit("message", {
        type: "browser_request",
        id: "revoke",
        sessionID: "parent",
        request: { op: "revoke_tabs", executionID: "exec" },
      })
      return result
    },
    f.resolve,
  )
  try {
    child.emit("message", {
      type: "browser_request",
      id: "grant",
      sessionID: "parent",
      request: { op: "grant_tabs", executionID: "exec", childSessionID: "child", tabIDs: [f.tab.id] },
    })
    await tick()
    expect(replies[0].response.ok).toBe(true)
    child.emit("message", {
      type: "browser_request",
      id: "page",
      sessionID: "child",
      request:
        op === "list_tabs"
          ? { op }
          : { op, request: { op: "navigate", tabID: f.tab.id, url: "https://example.test/next" } },
    })
    await tick()
    const response = replies.find((reply) => reply.id === "page")?.response
    expect(response).toMatchObject({ ok: false })
    expect(JSON.stringify(response)).not.toContain("private")
    expect(JSON.stringify(response)).not.toContain("ownerContext")
  } finally {
    stop()
    f.close()
  }
})

test.each(["revoke", "exit"] as const)("held native call keeps busy after delegated %s", async (mode) => {
  const f = fixture()
  const wait = Promise.withResolvers<void>()
  const started = Promise.withResolvers<void>()
  const original = f.contents.loadURL
  f.contents.loadURL = async (url) => {
    started.resolve()
    await wait.promise
    await original(url)
  }
  const replies: BrowserIpcResult[] = []
  const child = Object.assign(new EventEmitter(), { postMessage: (reply: BrowserIpcResult) => replies.push(reply) })
  const stop = attachBrowserBridge(child, undefined, f.resolve)
  const send = (id: string, sessionID: string, request: Request) =>
    child.emit("message", { type: "browser_request", id, sessionID, request })
  try {
    send("grant", "parent", { op: "grant_tabs", executionID: "exec", childSessionID: "child", tabIDs: [f.tab.id] })
    await tick()
    const request = { op: "navigate", tabID: f.tab.id, url: "https://example.test/next" } as const
    send("prepare", "child", { op: "prepare_write", request })
    await tick()
    const prepared = replies.find((reply) => reply.id === "prepare")?.response
    if (!prepared?.ok || !prepared.result.context) throw new Error("Missing context")
    send("write", "child", { ...request, context: prepared.result.context })
    await started.promise
    if (mode === "exit") child.emit("exit", 0)
    if (mode === "revoke") send("revoke", "parent", { op: "revoke_tabs", executionID: "exec" })
    await tick()
    expect(browserOperationBusy.has(f.tab.id)).toBe(true)
    expect(browserTabReserved(f.tab)).toBe(true)
    expect(await f.route({ op: "read_state", tabID: f.tab.id }, "parent")).toMatchObject({ ok: false })
    wait.resolve()
    await tick()
    await tick()
    expect(browserOperationBusy.has(f.tab.id)).toBe(false)
    expect(browserTabReserved(f.tab)).toBe(false)
    const result = replies.find((reply) => reply.id === "write")?.response
    if (mode === "exit") expect(result).toBeUndefined()
    if (mode === "revoke") expect(result).toMatchObject({ ok: false })
  } finally {
    wait.resolve()
    stop()
    f.close()
  }
})

test("lost grant ACK is cleaned by executionID and cannot be retried after revoke", async () => {
  const f = fixture()
  const replies: BrowserIpcResult[] = []
  const child = Object.assign(new EventEmitter(), {
    postMessage: (reply: BrowserIpcResult) => {
      if (reply.id !== "grant") replies.push(reply)
    },
  })
  const stop = attachBrowserBridge(child, undefined, f.resolve)
  try {
    const grant = { op: "grant_tabs", executionID: "exec", childSessionID: "child", tabIDs: [f.tab.id] }
    child.emit("message", { type: "browser_request", id: "grant", sessionID: "parent", request: grant })
    await tick()
    expect(browserTabReserved(f.tab)).toBe(true)
    child.emit("message", {
      type: "browser_request",
      id: "cleanup",
      sessionID: "parent",
      request: { op: "revoke_tabs", executionID: "exec" },
    })
    await tick()
    expect(replies[0].response).toMatchObject({ ok: true, result: { delegation: { active: false } } })
    child.emit("message", { type: "browser_request", id: "retry", sessionID: "parent", request: grant })
    await tick()
    expect(replies.at(-1)?.response).toMatchObject({ ok: false })
    expect(browserTabReserved(f.tab)).toBe(false)
  } finally {
    stop()
    f.close()
  }
})
