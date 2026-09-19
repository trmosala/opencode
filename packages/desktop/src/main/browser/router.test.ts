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
import {
  registerBrowserTab,
  setBrowserAgentEnabled,
  setBrowserTabHandler,
  browserOperationBusy,
  type BrowserRegistration,
} from "./registry"
import { createTabHandler, type NativeTabAction } from "./agent-tabs"
import { routeBrowserRequest } from "./router"
import { browserInputFailure, shouldShowBrowserContextMenu, screenshotDecoder } from "./driver"
import { parseSnapshot } from "./snapshot"
import { DESKTOP_NATIVE_ENGLISH } from "@opencode-ai/app/i18n/desktop-native"
import { setNativeTranslations } from "../native-translations"

function fixture(isAllowed = (url: string) => ["localhost", "127.0.0.1"].includes(new URL(url).hostname)) {
  const calls: string[] = []
  let url = "http://localhost/"
  const debuggerFixture = Object.assign(new EventEmitter(), {
    isAttached: () => true,
    attach: () => {},
    async sendCommand(method: string, params?: Record<string, unknown>) {
      calls.push(method)
      if (method === "WebMCP.enable") {
        queueMicrotask(() =>
          debuggerFixture.emit("message", {}, "WebMCP.toolsAdded", {
            tools: [
              {
                name: "search",
                description: "Search this site",
                frameId: "main",
                inputSchema: { type: "object", properties: { query: { type: "string" } } },
                annotations: { readOnly: true, untrustedContent: true, consequential: false },
              },
            ],
          }),
        )
        await Promise.resolve()
        return {}
      }
      if (method === "WebMCP.invokeTool") {
        setTimeout(() =>
          debuggerFixture.emit("message", {}, "WebMCP.toolResponded", {
            invocationId: "route-invocation",
            status: "Completed",
            output: { echoed: params?.input },
          }),
        )
        return { invocationId: "route-invocation" }
      }
      if (method === "WebMCP.cancelInvocation") return {}
      if (method === "Page.getFrameTree")
        return {
          frameTree: { frame: { id: "main", url, securityOrigin: new URL(url).origin } },
        }
      if (method === "DOM.getNodeForLocation") return { frameId: "main", backendNodeId: 1 }
      if (method === "DOM.describeNode") return { node: { nodeName: "BUTTON" } }
      if (method === "Page.createIsolatedWorld") return { executionContextId: 8 }
      return {
        result: {
          value: {
            generation: "document-one",
            url,
            title: "",
            visibleText: "hello",
            elements: [
              {
                tag: "button",
                role: "",
                label: "Send",
                text: "Send",
                token: "send",
                disabled: false,
                rect: { x: 0, y: 0, width: 10, height: 10 },
              },
            ],
          },
        },
      }
    },
  })
  const tab: BrowserRegistration = {
    id: "route-one",
    sessionID: "route-session",
    ownerID: 1,
    revision: 0,
    agentAccess: true,
    transferGuarded: true,
    contents: Object.assign(new EventEmitter(), {
      mainFrame: { detached: false },
      get focusedFrame() {
        return this.mainFrame
      },
      isDestroyed: () => false,
      isLoadingMainFrame: () => false,
      stop: () => {},
      getURL: () => url,
      loadURL: async (next) => {
        url = next
        tab.revision++
      },
      debugger: debuggerFixture,
    }),
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
  return { tab, calls, debuggerFixture, remove, route, write }
}

test("tab lifecycle tokens bind exact task, action, target and source without private metadata", async () => {
  const { tab, route, remove, calls } = fixture()
  tab.agentAccess = false
  let mutations = 0
  let ownerEpoch = 0
  let consent: () => boolean = () => true
  setBrowserTabHandler(
    createTabHandler((sessionID, request) => {
      if (sessionID !== tab.sessionID || (request.op !== "create_tab" && request.tabID !== tab.id)) return
      const epoch = ownerEpoch
      return {
        owner: tab,
        target: request.op === "create_tab" ? undefined : tab,
        source: tab,
        check() {
          if (epoch !== ownerEpoch) throw new Error("Owner changed")
        },
        confirm: async () => consent(),
        run(check) {
          check()
          mutations++
          return request.op === "create_tab" ? "created-id" : tab.id
        },
      }
    }),
  )
  const request = { op: "select_tab", tabID: tab.id } as const
  const prepare = async () => {
    const prepared = await route({ op: "prepare_tab", request })
    if (!prepared.ok || !prepared.result.tabToken) throw new Error("Missing token")
    expect(prepared.result).toEqual({
      tabID: "",
      url: "",
      title: "",
      visibleText: "",
      elements: [],
      tabToken: prepared.result.tabToken,
    })
    return prepared.result.tabToken
  }
  try {
    expect(await route({ op: "prepare_tab", request }, "foreign")).toMatchObject({ code: "no_target" })
    expect(await route({ op: "prepare_tab", request: { ...request, tabID: "missing" } })).toMatchObject({
      code: "no_target",
    })
    expect(await route({ ...request, token: "missing" })).toMatchObject({ code: "access_denied" })
    for (const reason of [
      "foreign",
      "op",
      "target",
      "source",
      "access",
      "owner",
      "global",
      "consent",
      "post-consent",
    ]) {
      const token = await prepare()
      if (reason === "source") tab.revision += 2
      if (reason === "access") tab.accessRevision = (tab.accessRevision ?? 0) + 2
      if (reason === "owner") ownerEpoch += 2
      if (reason === "global") {
        setBrowserAgentEnabled(false)
        setBrowserAgentEnabled(true)
      }
      if (reason === "consent") consent = () => false
      if (reason === "post-consent")
        consent = () => {
          ownerEpoch++
          return true
        }
      expect(
        await route(
          {
            ...request,
            token,
            ...(reason === "op" ? { op: "close_tab" as const } : {}),
            ...(reason === "target" ? { tabID: "other" } : {}),
          },
          reason === "foreign" ? "foreign" : tab.sessionID,
        ),
      ).toMatchObject({ ok: false })
      expect(await route({ ...request, token })).toMatchObject({ code: "access_denied" })
      consent = () => true
    }
    expect(mutations).toBe(0)
    const token = await prepare()
    expect(await route({ ...request, token })).toEqual({
      ok: true,
      result: {
        tabID: "",
        url: "",
        title: "",
        visibleText: "",
        elements: [],
        tabResult: { op: "select_tab", tabID: tab.id },
      },
    })
    expect(await route({ ...request, token })).toMatchObject({ code: "access_denied" })
    expect(mutations).toBe(1)
    expect(tab.agentAccess).toBe(false)
    expect(calls).toEqual([])
  } finally {
    setBrowserTabHandler(undefined)
    setBrowserAgentEnabled(true)
    remove()
  }
})

test("blank creation tokens observe global epochs even with no registered tabs", async () => {
  const owner = {}
  let mutations = 0
  setBrowserTabHandler(
    createTabHandler(() => ({
      owner,
      check() {},
      confirm: async () => true,
      run(check) {
        check()
        mutations++
        return "created-blank"
      },
    })),
  )
  const route = (request: Request) =>
    routeBrowserRequest({
      type: "browser_request",
      id: "blank",
      sessionID: "empty-task",
      request,
    })
  try {
    const prepared = await route({ op: "prepare_tab", request: { op: "create_tab" } })
    if (!prepared.ok || !prepared.result.tabToken) throw new Error("Missing token")
    setBrowserAgentEnabled(false)
    setBrowserAgentEnabled(true)
    expect(await route({ op: "create_tab", token: prepared.result.tabToken })).toMatchObject({ ok: false })
    expect(mutations).toBe(0)
    const fresh = await route({ op: "prepare_tab", request: { op: "create_tab" } })
    if (!fresh.ok || !fresh.result.tabToken) throw new Error("Missing token")
    expect(await route({ op: "create_tab", token: fresh.result.tabToken })).toEqual({
      ok: true,
      result: {
        tabID: "",
        url: "",
        title: "",
        visibleText: "",
        elements: [],
        tabResult: { op: "create_tab", tabID: "created-blank" },
      },
    })
    expect(mutations).toBe(1)
  } finally {
    setBrowserTabHandler(undefined)
    setBrowserAgentEnabled(true)
  }
})

test.each(["create_tab", "select_tab", "close_tab"] as const)(
  "tab lifecycle %s rejects busy distinct source at preparation and admission",
  async (op) => {
    const { tab, route, remove, calls } = fixture()
    const source = { ...tab, id: "distinct-source" }
    const removeSource = registerBrowserTab(source)
    let prompts = 0
    setBrowserTabHandler(
      createTabHandler(() => ({
        owner: tab,
        source,
        target: op === "create_tab" ? undefined : tab,
        check() {},
        async confirm() {
          prompts++
          return true
        },
        run: () => tab.id,
      })),
    )
    const request = op === "create_tab" ? { op } : { op, tabID: tab.id }
    try {
      const prepared = await route({ op: "prepare_tab", request })
      if (!prepared.ok || !prepared.result.tabToken) throw new Error("Missing token")
      expect(browserOperationBusy.has(source.id)).toBe(false)
      browserOperationBusy.add(source.id)
      expect(await route({ op: "prepare_tab", request })).toMatchObject({ code: "unavailable" })
      expect(await route({ ...request, token: prepared.result.tabToken })).toMatchObject({ code: "unavailable" })
      expect(prompts).toBe(0)
      expect(browserOperationBusy.has(source.id)).toBe(true)
      expect(browserOperationBusy.has(tab.id)).toBe(false)
      expect(calls).toEqual([])
    } finally {
      browserOperationBusy.delete(source.id)
      removeSource()
      remove()
      setBrowserTabHandler(undefined)
    }
  },
)

test.each(["consent", "close"] as const)(
  "cancelled tab %s holds busy, rendering and bridge correlation until settlement",
  async (phase) => {
    const { tab, route, remove } = fixture()
    tab.contents.backgroundThrottling = true
    const source = { ...tab, id: "cancel-source" }
    const removeSource = registerBrowserTab(source)
    const held = Promise.withResolvers<string | undefined>()
    const entered = Promise.withResolvers<void>()
    let mutations = 0
    const action: NativeTabAction = {
      owner: tab,
      target: tab,
      source,
      check() {},
      async confirm() {
        if (phase === "consent") {
          entered.resolve()
          await held.promise
        }
        return true
      },
      run(check) {
        check()
        mutations++
        entered.resolve()
        return held.promise
      },
    }
    setBrowserTabHandler(createTabHandler(() => action))
    const replies: BrowserIpcResult[] = []
    const child = Object.assign(new EventEmitter(), { postMessage: (reply: BrowserIpcResult) => replies.push(reply) })
    let settlement: Promise<unknown> | undefined
    let routed = 0
    const stop = attachBrowserBridge(child, (message, allowed, control) => {
      routed++
      return routeBrowserRequest(message, allowed, {
        ...control,
        onSettled(pending) {
          settlement = pending
          control?.onSettled?.(pending)
        },
      })
    })
    const request = { op: "close_tab", tabID: tab.id } as const
    try {
      const prepared = await route({ op: "prepare_tab", request })
      if (!prepared.ok || !prepared.result.tabToken) throw new Error("Missing token")
      const message = {
        type: "browser_request",
        id: "held-close",
        sessionID: tab.sessionID,
        request: { ...request, token: prepared.result.tabToken },
      }
      child.emit("message", message)
      await entered.promise
      expect(browserOperationBusy.has(source.id)).toBe(true)
      expect(await route({ op: "read_state", tabID: source.id })).toMatchObject({ code: "unavailable" })
      expect(await route({ op: "prepare_write", request: { op: "screenshot", tabID: source.id } })).toMatchObject({
        code: "unavailable",
      })
      child.emit("message", { type: "browser_cancel", id: message.id, sessionID: tab.sessionID })
      await new Promise((resolve) => setImmediate(resolve))
      expect(replies).toHaveLength(1)
      expect(replies[0].response).toMatchObject({ code: "cancelled" })
      expect(browserOperationBusy.has(tab.id)).toBe(true)
      expect(browserOperationBusy.has(source.id)).toBe(true)
      expect(tab.contents.backgroundThrottling).toBe(false)
      expect(await route({ op: "read_state", tabID: tab.id })).toMatchObject({ code: "unavailable" })
      expect(
        await route({ op: "prepare_write", request: { op: "navigate", tabID: tab.id, url: "http://localhost/" } }),
      ).toMatchObject({ code: "unavailable" })
      child.emit("message", message)
      expect(routed).toBe(1)
      held.resolve(undefined)
      await settlement
      await new Promise((resolve) => setImmediate(resolve))
      expect(browserOperationBusy.has(tab.id)).toBe(false)
      expect(browserOperationBusy.has(source.id)).toBe(false)
      expect(tab.contents.backgroundThrottling).toBe(true)
      expect(mutations).toBe(phase === "close" ? 1 : 0)
      expect(replies).toHaveLength(1)
    } finally {
      held.resolve(undefined)
      await settlement
      stop()
      setBrowserTabHandler(undefined)
      removeSource()
      remove()
    }
  },
)

test.each(["success", "missing", "regrant", "aba", "replace", "allowlist", "global", "cancel", "deadline"] as const)(
  "screenshot real-route response-to-post race is fail closed: %s",
  async (reason) => {
    const { tab, route, remove } = fixture()
    const decode = screenshotDecoder.size
    screenshotDecoder.size = async () => ({ width: 1, height: 1 })
    tab.confirmScreenshot = async () => () => {}
    tab.contents.debugger.sendCommand = async (method) =>
      method === "Page.getLayoutMetrics"
        ? { visualViewport: { clientWidth: 1, clientHeight: 1 } }
        : { data: "/9j/2Q==" }
    const posted = Promise.withResolvers<BrowserIpcResult>()
    const child = Object.assign(new EventEmitter(), {
      postMessage: (result: BrowserIpcResult) => posted.resolve(result),
    })
    let allowed = true
    const stop = attachBrowserBridge(child, async (message, _allowed, control) => {
      const response = await routeBrowserRequest(message, () => allowed, {
        ...control,
        deadline: reason === "deadline" ? Date.now() + 30 : control.deadline,
        onScreenshotDelivery: reason === "missing" ? undefined : control.onScreenshotDelivery,
      })
      expect(response.ok).toBe(true)
      if (reason === "regrant") {
        tab.accessRevision = 1
        tab.agentAccess = false
        tab.agentAccess = true
      }
      if (reason === "aba") {
        await tab.contents.loadURL("http://localhost/b")
        await tab.contents.loadURL("http://localhost/")
      }
      if (reason === "replace") {
        remove()
        registerBrowserTab({ ...tab })
      }
      if (reason === "allowlist") allowed = false
      if (reason === "global") {
        setBrowserAgentEnabled(false)
        setBrowserAgentEnabled(true)
        tab.agentAccess = true
      }
      if (reason === "cancel")
        child.emit("message", { type: "browser_cancel", id: message.id, sessionID: message.sessionID })
      if (reason === "deadline") await Bun.sleep(40)
      return response
    })
    try {
      const request = { op: "screenshot", tabID: tab.id } as const
      const prepared = await route({ op: "prepare_write", request })
      if (!prepared.ok || !prepared.result.context) throw new Error("No context")
      child.emit("message", {
        type: "browser_request",
        id: "post",
        sessionID: tab.sessionID,
        request: { ...request, context: prepared.result.context },
      })
      const reply = await posted.promise
      expect(reply.response.ok).toBe(reason === "success")
      if (!reply.response.ok) expect(JSON.stringify(reply)).not.toContain("/9j/")
      await new Promise((resolve) => setImmediate(resolve))
    } finally {
      stop()
      remove()
      setBrowserAgentEnabled(true)
      screenshotDecoder.size = decode
    }
  },
)

test.each(["route", "post"] as const)("screenshot %s delivery error uses native i18n", async (phase) => {
  const { tab, route, remove } = fixture()
  const decode = screenshotDecoder.size.bind(screenshotDecoder)
  const key = "desktop.browser.screenshotDeliveryUnavailable"
  expect(DESKTOP_NATIVE_ENGLISH[key]).toBe("Browser screenshot delivery unavailable.")
  setNativeTranslations({ locale: "en", messages: { ...DESKTOP_NATIVE_ENGLISH, [key]: "test delivery sentinel" } })
  let invalidated = false
  tab.confirmScreenshot = async () => () => {
    if (invalidated) throw new Error("Owner changed")
  }
  screenshotDecoder.size = async () => ({ width: 1, height: 1 })
  tab.contents.debugger.sendCommand = async (method) =>
    method === "Page.getLayoutMetrics" ? { visualViewport: { clientWidth: 1, clientHeight: 1 } } : { data: "/9j/2Q==" }
  const posted = Promise.withResolvers<BrowserIpcResult>()
  const child = Object.assign(new EventEmitter(), {
    postMessage: (result: BrowserIpcResult) => posted.resolve(result),
  })
  const stop = attachBrowserBridge(child, async (message, _allowed, control) => {
    const response = await routeBrowserRequest(message, () => true, {
      ...control,
      onSettled(operation) {
        control.onSettled?.(operation)
        if (phase === "route")
          void operation.then(() => {
            invalidated = true
          })
      },
    })
    expect(response.ok).toBe(phase === "post")
    invalidated = true
    return response
  })
  try {
    const request = { op: "screenshot", tabID: tab.id } as const
    const prepared = await route({ op: "prepare_write", request })
    if (!prepared.ok || !prepared.result.context) throw new Error("No context")
    child.emit("message", {
      type: "browser_request",
      id: "i18n",
      sessionID: tab.sessionID,
      request: { ...request, context: prepared.result.context },
    })
    expect((await posted.promise).response).toEqual({
      ok: false,
      code: "unavailable",
      error: "test delivery sentinel",
    })
    await new Promise((resolve) => setImmediate(resolve))
  } finally {
    stop()
    remove()
    screenshotDecoder.size = decode
    setNativeTranslations({ locale: "en", messages: { ...DESKTOP_NATIVE_ENGLISH } })
  }
})

test("screenshot rejects private, foreign, missing consent and stale native approval before capture", async () => {
  const { tab, route, write, calls, remove } = fixture()
  try {
    const request = { op: "screenshot", tabID: tab.id } as const
    expect(await write(request)).toMatchObject({ code: "access_denied" })
    tab.agentAccess = false
    expect(await write(request)).toMatchObject({ code: "access_denied" })
    expect(await route({ op: "prepare_write", request }, "other")).toMatchObject({ code: "no_target" })
    tab.agentAccess = true
    tab.confirmScreenshot = async () => {
      tab.revision++
      return () => {}
    }
    expect(await write(request)).toMatchObject({ ok: false })
    expect(calls).toEqual([])
    expect(tab.screenshotConsent).toBeUndefined()
  } finally {
    remove()
  }
})

test("network collector failures use native i18n without exposing raw errors", async () => {
  const { tab, write, remove } = fixture()
  const key = "desktop.browser.operationUnavailable"
  expect(DESKTOP_NATIVE_ENGLISH[key]).toBe("Browser operation interrupted or unavailable.")
  setNativeTranslations({ locale: "en", messages: { ...DESKTOP_NATIVE_ENGLISH, [key]: "test unavailable sentinel" } })
  tab.confirmDiagnostics = async () => () => {}
  tab.observeNetwork = async () => {
    throw new Error("https://example.test/?credential=secret")
  }
  try {
    expect(await write({ op: "observe_network", tabID: tab.id, durationMs: 250 })).toEqual({
      ok: false,
      code: "unavailable",
      error: "test unavailable sentinel",
    })
    expect(tab.diagnosticConsent).toBeUndefined()
    expect(browserOperationBusy.has(tab.id)).toBe(false)
  } finally {
    remove()
    setNativeTranslations({ locale: "en", messages: { ...DESKTOP_NATIVE_ENGLISH } })
  }
})

test("console diagnostics bind owner approval and return counts without message payloads", async () => {
  const { tab, route, remove } = fixture()
  let owner = "owner-task-1"
  tab.ownerContext = () => owner
  tab.confirmDiagnostics = async (_url, durationMs) => {
    expect(durationMs).toBe(250)
    return () => {
      if (owner !== "owner-task-1") throw new Error("Owner changed")
    }
  }
  try {
    const request = { op: "observe_console", tabID: tab.id, durationMs: 250 } as const
    const prepared = await route({ op: "prepare_write", request })
    if (!prepared.ok || !prepared.result.context) throw new Error("No context")
    expect(prepared.result.context.ownerContext).toBe(owner)
    const pending = route({ ...request, context: prepared.result.context })
    await Bun.sleep(10)
    const contents = tab.contents as unknown as EventEmitter
    contents.emit("console-message", {
      params: { level: "error", message: "password=secret", sourceId: "https://user:pass@example.test/private" },
    })
    contents.emit("console-message", {
      params: { level: "warning", message: "token=secret", sourceId: "https://example.test/?token=secret" },
    })
    const response = await pending
    expect(response).toMatchObject({
      ok: true,
      result: {
        diagnostics: {
          console: { durationMs: 250, error: 1, warning: 1, info: 0, debug: 0, other: 0, total: 2 },
        },
      },
    })
    expect(JSON.stringify(response)).not.toContain("secret")
    expect(getEventListeners(contents, "console-message")).toHaveLength(0)

    const stale = await route({ op: "prepare_write", request })
    if (!stale.ok || !stale.result.context) throw new Error("No context")
    owner = "owner-task-2"
    expect(await route({ ...request, context: stale.result.context })).toMatchObject({
      ok: false,
      code: "access_denied",
    })
  } finally {
    remove()
  }
})

test("console diagnostics clean up and fail closed when source authority changes", async () => {
  const { tab, route, remove } = fixture()
  let valid = true
  tab.confirmDiagnostics = async () => () => {
    if (!valid) throw new Error("Owner changed")
  }
  try {
    const request = { op: "observe_console", tabID: tab.id, durationMs: 250 } as const
    const prepared = await route({ op: "prepare_write", request })
    if (!prepared.ok || !prepared.result.context) throw new Error("No context")
    const pending = route({ ...request, context: prepared.result.context })
    await Bun.sleep(10)
    valid = false
    const contents = tab.contents as unknown as EventEmitter
    contents.emit("console-message", {
      params: { level: "error", message: "never retained", sourceId: "https://example.test/" },
    })
    expect(await pending).toMatchObject({ ok: false, code: "unavailable" })
    expect(getEventListeners(contents, "console-message")).toHaveLength(0)
    expect(tab.diagnosticConsent).toBeUndefined()
  } finally {
    remove()
  }
})

test.each([
  "success",
  "denied",
  "consent-source",
  "source",
  "access",
  "owner",
  "task",
  "policy",
  "native-revoke",
  "cancel",
] as const)("network diagnostics preserve native consent, authority and cancellation: %s", async (reason) => {
  let permitted = true
  const { tab, route, calls, remove } = fixture(() => permitted)
  const controller = new AbortController()
  let observed = false
  let task = "task-epoch-1"
  tab.ownerContext = () => task
  const network = {
    durationMs: 250,
    http1xx: 0,
    http2xx: 1,
    http3xx: 0,
    http4xx: 0,
    http5xx: 0,
    other: 0,
    failed: 0,
    total: 1,
  }
  tab.confirmDiagnostics = async (_url, duration, signal, kind) => {
    expect(duration).toBe(250)
    expect(kind).toBe("network")
    expect(signal).toBe(tab.diagnosticConsent?.signal)
    expect(observed).toBe(false)
    if (reason === "consent-source") tab.revision++
    return reason === "denied" ? false : () => {}
  }
  tab.observeNetwork = async (duration, check, signal) => {
    observed = true
    expect(duration).toBe(250)
    expect(signal).toBe(tab.diagnosticConsent?.signal)
    expect(tab.navigationAllowed).toBeUndefined()
    check()
    if (reason === "source") tab.revision++
    if (reason === "access") tab.accessRevision = 1
    if (reason === "owner") tab.ownerID++
    if (reason === "task") task = "task-epoch-2"
    if (reason === "policy") permitted = false
    if (reason === "native-revoke") tab.diagnosticConsent?.abort()
    if (reason === "cancel") controller.abort()
    if (reason === "cancel" || reason === "native-revoke") expect(signal.aborted).toBe(true)
    await Promise.resolve()
    check()
    return network
  }
  try {
    const request = { op: "observe_network", tabID: tab.id, durationMs: 250 } as const
    const prepared = await route({ op: "prepare_write", request })
    if (!prepared.ok || !prepared.result.context) throw new Error("No context")
    const response = await routeBrowserRequest(
      {
        type: "browser_request",
        id: "network",
        sessionID: tab.sessionID,
        request: { ...request, context: prepared.result.context },
      },
      () => permitted,
      { signal: controller.signal },
    )
    expect(response.ok).toBe(reason === "success")
    expect(observed).toBe(reason !== "denied" && reason !== "consent-source")
    if (response.ok)
      expect(response.result).toEqual({
        tabID: tab.id,
        url: "http://localhost",
        title: "",
        visibleText: "",
        elements: [],
        diagnostics: { network },
      })
    else expect(JSON.stringify(response)).not.toContain("http2xx")
    await new Promise((resolve) => setImmediate(resolve))
    expect(tab.diagnosticConsent).toBeUndefined()
    expect(browserOperationBusy.has(tab.id)).toBe(false)
    expect(calls).toEqual([])
  } finally {
    controller.abort()
    remove()
  }
})

test.each(["route", "post"] as const)(
  "network real-route %s delivery drops counts after authority changes",
  async (phase) => {
    const { tab, route, remove } = fixture()
    tab.confirmDiagnostics = async () => () => {}
    tab.observeNetwork = async (_duration, check) => {
      check()
      return {
        durationMs: 250,
        http1xx: 0,
        http2xx: 1,
        http3xx: 0,
        http4xx: 0,
        http5xx: 0,
        other: 0,
        failed: 0,
        total: 1,
      }
    }
    const posted = Promise.withResolvers<BrowserIpcResult>()
    const child = Object.assign(new EventEmitter(), { postMessage: (reply: BrowserIpcResult) => posted.resolve(reply) })
    const stop = attachBrowserBridge(child, async (message, _allowed, control) => {
      const response = await routeBrowserRequest(message, () => true, {
        ...control,
        onSettled(operation) {
          control.onSettled?.(operation)
          if (phase === "route")
            void operation.then(() => {
              tab.revision++
            })
        },
      })
      expect(response.ok).toBe(phase === "post")
      if (phase === "post") tab.revision++
      return response
    })
    try {
      const request = { op: "observe_network", tabID: tab.id, durationMs: 250 } as const
      const prepared = await route({ op: "prepare_write", request })
      if (!prepared.ok || !prepared.result.context) throw new Error("No context")
      child.emit("message", {
        type: "browser_request",
        id: "network-race",
        sessionID: tab.sessionID,
        request: { ...request, context: prepared.result.context },
      })
      const reply = await posted.promise
      expect(reply.response).toMatchObject({
        ok: false,
        code: "unavailable",
        error: "Browser diagnostics delivery unavailable.",
      })
      expect(JSON.stringify(reply)).not.toContain("http2xx")
      await new Promise((resolve) => setImmediate(resolve))
    } finally {
      stop()
      remove()
    }
  },
)

test("network diagnostics reject private/foreign/stale approval and missing native capability", async () => {
  const { tab, route, write, remove, calls } = fixture()
  const request = { op: "observe_network", tabID: tab.id, durationMs: 250 } as const
  try {
    expect(await write(request)).toMatchObject({ code: "access_denied" })
    tab.confirmDiagnostics = async () => () => {}
    expect(await write(request)).toMatchObject({ code: "unavailable" })
    expect(await route({ op: "prepare_write", request }, "foreign")).toMatchObject({ code: "no_target" })
    const prepared = await route({ op: "prepare_write", request })
    if (!prepared.ok || !prepared.result.context) throw new Error("No context")
    tab.revision++
    expect(await route({ ...request, context: prepared.result.context })).toMatchObject({ code: "access_denied" })
    tab.agentAccess = false
    expect(await write(request)).toMatchObject({ code: "access_denied" })
    expect(calls).toEqual([])
  } finally {
    remove()
  }
})

test("site tools bind discovery, named approval, native consent and invocation to one source", async () => {
  const { tab, route, remove } = fixture()
  let confirmations = 0
  tab.confirmSiteTool = async (url, tool, argumentsJSON) => {
    confirmations++
    expect(url).toBe("http://localhost/")
    expect(tool).toMatchObject({ name: "search", description: "Search this site", readOnly: true })
    expect(argumentsJSON).toBe('{"query":"cookies"}')
    return () => {}
  }
  try {
    const discovered = await route({ op: "list_site_tools", tabID: tab.id })
    if (!discovered.ok || !discovered.result.siteTools?.[0]) throw new Error("No site tool")
    const toolRef = discovered.result.siteTools[0].ref
    const request = { op: "prepare_site_tool", tabID: tab.id, toolRef, arguments: '{"query":"cookies"}' } as const
    const prepared = await route(request)
    if (!prepared.ok || !prepared.result.siteToolContext) throw new Error("No site tool context")
    expect(prepared.result.siteToolRequest).toEqual({
      name: "search",
      origin: "http://localhost",
      arguments: '{"query":"cookies"}',
    })
    expect(
      await route({
        op: "execute_site_tool",
        tabID: tab.id,
        toolRef,
        arguments: '{"query":"cookies"}',
        siteToolContext: prepared.result.siteToolContext,
      }),
    ).toMatchObject({
      ok: true,
      result: {
        siteToolResult: {
          name: "search",
          origin: "http://localhost",
          content: '{"echoed":{"query":"cookies"}}',
        },
      },
    })
    expect(confirmations).toBe(1)
    expect(tab.siteToolConsent).toBeUndefined()
  } finally {
    remove()
  }
})

test("site tool changes and access revocation fail before native dispatch", async () => {
  const { tab, route, debuggerFixture, remove } = fixture()
  let confirmations = 0
  tab.confirmSiteTool = async () => {
    confirmations++
    return () => {}
  }
  try {
    const discovered = await route({ op: "list_site_tools", tabID: tab.id })
    if (!discovered.ok || !discovered.result.siteTools?.[0]) throw new Error("No site tool")
    const toolRef = discovered.result.siteTools[0].ref
    const request = { op: "prepare_site_tool", tabID: tab.id, toolRef, arguments: "{}" } as const
    const stale = await route(request)
    if (!stale.ok || !stale.result.siteToolContext) throw new Error("No site tool context")
    debuggerFixture.emit("message", {}, "WebMCP.toolsRemoved", {
      tools: [{ name: "search", frameId: "main" }],
    })
    expect(
      await route({
        op: "execute_site_tool",
        tabID: tab.id,
        toolRef,
        arguments: "{}",
        siteToolContext: stale.result.siteToolContext,
      }),
    ).toMatchObject({ ok: false, code: "unavailable" })
    expect(confirmations).toBe(0)

    tab.agentAccess = false
    expect(await route(request)).toMatchObject({ ok: false, code: "access_denied" })
    expect(confirmations).toBe(0)
  } finally {
    remove()
  }
})

test.each(["success", "cancel", "timeout", "regrant", "aba", "replace", "global", "allowlist", "owner"] as const)(
  "screenshot held capture drops stale pixels and retains lease: %s",
  async (reason) => {
    const { tab, route, remove } = fixture()
    const decode = screenshotDecoder.size
    const entered = Promise.withResolvers<void>(),
      held = Promise.withResolvers<void>(),
      settled = Promise.withResolvers<void>()
    const controller = new AbortController()
    let allowed = true
    tab.contents.backgroundThrottling = true
    tab.confirmScreenshot = async () => () => {}
    screenshotDecoder.size = async () => ({ width: 1, height: 1 })
    tab.contents.debugger.sendCommand = async (method, params) => {
      if (method === "Page.getLayoutMetrics") return { visualViewport: { clientWidth: 1, clientHeight: 1 } }
      expect(method).toBe("Page.captureScreenshot")
      expect(params).toEqual({ format: "jpeg", quality: 60, fromSurface: true, captureBeyondViewport: false })
      entered.resolve()
      await held.promise
      return { data: "/9j/2Q==" }
    }
    try {
      const request = { op: "screenshot", tabID: tab.id } as const
      const prepared = await route({ op: "prepare_write", request })
      if (!prepared.ok || !prepared.result.context) throw new Error("No context")
      const pending = routeBrowserRequest(
        {
          type: "browser_request",
          id: "pixels",
          sessionID: tab.sessionID,
          request: { ...request, context: prepared.result.context },
        },
        () => allowed,
        {
          signal: controller.signal,
          deadline: Date.now() + (reason === "timeout" ? 30 : 1000),
          onSettled: (operation) => {
            void operation.finally(() => settled.resolve())
          },
        },
      )
      await entered.promise
      expect(tab.navigationAllowed).toBeUndefined()
      if (reason === "cancel") controller.abort()
      if (reason === "regrant") {
        tab.agentAccess = false
        tab.accessRevision = 1
        tab.agentAccess = true
      }
      if (reason === "aba") {
        await tab.contents.loadURL("http://localhost/b")
        await tab.contents.loadURL("http://localhost/")
      }
      if (reason === "replace") {
        remove()
        registerBrowserTab({ ...tab })
      }
      if (reason === "global") {
        setBrowserAgentEnabled(false)
        setBrowserAgentEnabled(true)
        tab.agentAccess = true
      }
      if (reason === "allowlist") allowed = false
      if (reason === "owner") tab.ownerID++
      if (reason === "cancel" || reason === "timeout") {
        expect(await pending).toMatchObject({ code: reason === "cancel" ? "cancelled" : "timeout" })
        expect(tab.screenshotConsent?.signal.aborted).toBe(true)
      }
      expect(tab.contents.backgroundThrottling).toBe(false)
      expect(await route({ op: "read_state", tabID: tab.id })).toMatchObject({ code: "unavailable" })
      held.resolve()
      const response = await pending
      await settled.promise
      expect(response.ok).toBe(reason === "success")
      if (!response.ok) expect(JSON.stringify(response)).not.toContain("/9j/")
      expect(tab.contents.backgroundThrottling).toBe(true)
      expect(tab.screenshotConsent).toBeUndefined()
    } finally {
      held.resolve()
      controller.abort()
      await settled.promise
      screenshotDecoder.size = decode
      remove()
      setBrowserAgentEnabled(true)
    }
  },
)

test.each(["success", "cancel", "revoke", "timeout", "owner", "source", "registration", "policy", "reject"] as const)(
  "drag held movement retains ownership and quarantine through %s settlement",
  async (reason) => {
    const { tab, route, remove } = fixture()
    const controller = new AbortController()
    const entered = Promise.withResolvers<void>(),
      held = Promise.withResolvers<void>(),
      settled = Promise.withResolvers<void>()
    const input: Record<string, unknown>[] = []
    let permitted = true
    const send = tab.contents.debugger.sendCommand.bind(tab.contents.debugger)
    tab.contents.backgroundThrottling = true
    tab.contents.debugger.sendCommand = async (method, params) => {
      const response = await send(method, params)
      if (method.startsWith("Input.") && params) {
        input.push(params)
        if (params.type === "mouseMoved" && params.buttons === 1 && input.length === 3) {
          entered.resolve()
          await held.promise
          if (reason === "reject") throw new Error("Native movement failed")
        }
      }
      if (params?.contextId !== 8) return response
      const page = parseSnapshot(response)
      if (!page) throw new Error("No fake snapshot")
      const elements = [
        page.elements[0],
        { ...page.elements[0], token: "drop", rect: { x: 200, y: 0, width: 10, height: 10 } },
      ]
      const refs = [...String(params.expression).matchAll(/reference = (\{[^\n]+\}|null);/g)].flatMap((match) =>
        match[1] === "null" ? [] : [JSON.parse(match[1]) as { token: string }],
      )
      return {
        result: {
          value: {
            ...page,
            elements: refs.length ? refs.flatMap((ref) => elements.filter((el) => el.token === ref.token)) : elements,
          },
        },
      }
    }
    try {
      const state = await route({ op: "read_state", tabID: tab.id })
      if (!state.ok) throw new Error("No drag snapshot")
      const request = {
        op: "drag",
        tabID: tab.id,
        sourceRef: state.result.elements[0].ref,
        targetRef: state.result.elements[1].ref,
      } as const
      const prepared = await route({ op: "prepare_write", request })
      if (!prepared.ok || !prepared.result.context) throw new Error("No drag context")
      const pending = routeBrowserRequest(
        {
          type: "browser_request",
          id: "held-drag",
          sessionID: tab.sessionID,
          request: { ...request, context: prepared.result.context },
        },
        () => permitted,
        {
          signal: controller.signal,
          deadline: Date.now() + (reason === "timeout" ? 100 : 5000),
          onSettled: (operation) => {
            void operation.finally(() => settled.resolve())
          },
        },
      )
      await entered.promise
      expect(browserInputFailure(tab.contents)).toBeDefined()
      if (reason === "cancel") controller.abort()
      if (reason === "revoke") {
        tab.agentAccess = false
        tab.accessRevision = (tab.accessRevision ?? 0) + 1
        tab.agentAccess = true
      }
      if (reason === "owner") tab.ownerID++
      if (reason === "source") tab.revision++
      if (reason === "registration") {
        remove()
        registerBrowserTab({ ...tab })
      }
      if (reason === "policy") permitted = false
      if (reason === "cancel" || reason === "timeout")
        expect(await pending).toMatchObject({ code: reason === "cancel" ? "cancelled" : "timeout" })
      expect(tab.contents.backgroundThrottling).toBe(false)
      expect(tab.navigationAllowed).toBeDefined()
      expect(await route({ op: "read_state", tabID: tab.id })).toMatchObject({
        error: expect.stringContaining("Another operation"),
      })
      held.resolve()
      expect(await pending).toMatchObject(
        reason === "success"
          ? { ok: true }
          : { code: reason === "cancel" ? "cancelled" : reason === "timeout" ? "timeout" : "unavailable" },
      )
      await settled.promise
      expect(input).toHaveLength(reason === "success" ? 7 : 3)
      expect(input.filter((event) => event.type === "mouseReleased")).toHaveLength(reason === "success" ? 1 : 0)
      expect(Boolean(browserInputFailure(tab.contents))).toBe(reason !== "success")
      expect(tab.contents.backgroundThrottling).toBe(true)
      expect(tab.navigationAllowed).toBeUndefined()
      expect(getEventListeners(controller.signal, "abort")).toHaveLength(0)
    } finally {
      held.resolve()
      controller.abort()
      remove()
    }
  },
)

test.each(["success", "cancel", "reject"] as const)(
  "right-click menu suppression lasts through %s native settlement",
  async (reason) => {
    const { tab, route, remove } = fixture()
    const controller = new AbortController()
    const entered = Promise.withResolvers<void>()
    const held = Promise.withResolvers<void>()
    const settled = Promise.withResolvers<void>()
    const state = await route({ op: "read_state", tabID: tab.id })
    if (!state.ok) throw new Error("No snapshot")
    const request = { op: "click", tabID: tab.id, ref: state.result.elements[0].ref, mode: "right" } as const
    const prepared = await route({ op: "prepare_write", request })
    if (!prepared.ok || !prepared.result.context) throw new Error("No context")
    const send = tab.contents.debugger.sendCommand.bind(tab.contents.debugger)
    tab.contents.debugger.sendCommand = async (method, params) => {
      const value = await send(method, params)
      if (params?.type === "mouseReleased") {
        entered.resolve()
        await held.promise
        if (reason === "reject") throw new Error("Native failure")
      }
      return value
    }
    const pending = routeBrowserRequest(
      {
        type: "browser_request",
        id: "menus",
        sessionID: tab.sessionID,
        request: { ...request, context: prepared.result.context },
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
      // Repeated queries must not consume the guard; another WebContents stays independent.
      for (let i = 0; i < 3; i++) expect(shouldShowBrowserContextMenu(tab.contents)).toBe(false)
      expect(shouldShowBrowserContextMenu({ ...tab.contents })).toBe(true)
      if (reason === "cancel") {
        controller.abort()
        expect(await pending).toMatchObject({ code: "cancelled" })
        expect(shouldShowBrowserContextMenu(tab.contents)).toBe(false)
      }
      held.resolve()
      expect(await pending).toMatchObject(
        reason === "success" ? { ok: true } : { code: reason === "cancel" ? "cancelled" : "unavailable" },
      )
      await settled.promise
      expect(shouldShowBrowserContextMenu(tab.contents)).toBe(true)
    } finally {
      held.resolve()
      controller.abort()
      await settled.promise
      remove()
    }
  },
)

test.each(["hover", "double", "right"] as const)(
  "%s cancellation retains native ownership without follow-on input",
  async (mode) => {
    const { tab, route, remove } = fixture()
    const controller = new AbortController()
    const entered = Promise.withResolvers<void>()
    const held = Promise.withResolvers<void>()
    const settled = Promise.withResolvers<void>()
    const input: Record<string, unknown>[] = []
    const state = await route({ op: "read_state", tabID: tab.id })
    if (!state.ok) throw new Error("No snapshot")
    const request: WriteRequest =
      mode === "hover"
        ? { op: "hover", tabID: tab.id, ref: state.result.elements[0].ref }
        : { op: "click", tabID: tab.id, ref: state.result.elements[0].ref, mode }
    const prepared = await route({ op: "prepare_write", request })
    if (!prepared.ok || !prepared.result.context) throw new Error("No approval context")
    const send = tab.contents.debugger.sendCommand.bind(tab.contents.debugger)
    tab.contents.backgroundThrottling = true
    tab.contents.debugger.sendCommand = async (method, params) => {
      const value = await send(method, params)
      if (method.startsWith("Input.") && params) input.push(params)
      if (
        params?.type === (mode === "hover" ? "mouseMoved" : "mousePressed") &&
        (mode !== "double" || params?.clickCount === 2)
      ) {
        entered.resolve()
        await held.promise
      }
      return value
    }
    const pending = routeBrowserRequest(
      {
        type: "browser_request",
        id: "interactions",
        sessionID: tab.sessionID,
        request: { ...request, context: prepared.result.context },
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
      controller.abort()
      expect(await pending).toMatchObject({ code: "cancelled" })
      expect(tab.contents.backgroundThrottling).toBe(false)
      expect(tab.navigationAllowed).toBeDefined()
      expect(await route({ op: "read_state", tabID: tab.id })).toMatchObject({
        error: expect.stringContaining("Another operation"),
      })
      const count = input.length
      held.resolve()
      await settled.promise
      expect(input).toHaveLength(count)
      expect(tab.contents.backgroundThrottling).toBe(true)
      expect(tab.navigationAllowed).toBeUndefined()
      tab.contents.debugger.sendCommand = send
      expect((await route({ op: "read_state", tabID: tab.id })).ok).toBe(mode === "hover")
      expect(getEventListeners(controller.signal, "abort")).toHaveLength(0)
    } finally {
      held.resolve()
      controller.abort()
      await settled.promise
      remove()
    }
  },
)

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
        if (method === "Page.createIsolatedWorld")
          return { executionContextId: params?.worldName === "cm-browser-wait" ? 7 : 8 }
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
      if (method === "Page.createIsolatedWorld")
        return { executionContextId: params?.worldName === "cm-browser-wait" ? 7 : 8 }
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
    expect(asked).toEqual([["*"], ["127.0.0.1"]])
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
      { op: "drag", tabID: tab.id, sourceRef: "old:e0", targetRef: "old:e1" },
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
