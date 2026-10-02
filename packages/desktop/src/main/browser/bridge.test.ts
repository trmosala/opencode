import { expect, test } from "bun:test"
import { EventEmitter, getEventListeners } from "node:events"
import { failure, success, type BrowserIpcRequest, type BrowserIpcResult } from "@cookiemonster/cm-browser/protocol"
import { attachBrowserBridge } from "./bridge"

test("sidecar owns ID/session cancellation, rejects duplicates, and cleans up on exit", async () => {
  const calls: {
    signal: AbortSignal
    deadline: number
    done: ReturnType<typeof Promise.withResolvers<ReturnType<typeof failure>>>
  }[] = []
  const replies: BrowserIpcResult[] = []
  const child = Object.assign(new EventEmitter(), {
    postMessage: (reply: BrowserIpcResult) => {
      replies.push(reply)
    },
  })
  const other = Object.assign(new EventEmitter(), { postMessage: () => {} })
  const route = async (_request: unknown, _allowed: unknown, control: { signal: AbortSignal; deadline: number }) => {
    const done = Promise.withResolvers<ReturnType<typeof failure>>()
    calls.push({ ...control, done })
    return done.promise
  }
  const stop = attachBrowserBridge(child, route)
  const stopOther = attachBrowserBridge(other, route)
  const request = { type: "browser_request", id: "id", sessionID: "one", request: { op: "list_tabs" } }
  const cancel = { type: "browser_cancel", id: "id", sessionID: "one" }
  try {
    child.emit("message", request)
    expect(calls).toHaveLength(1)
    expect(calls[0].deadline - Date.now()).toBeLessThanOrEqual(15000)
    child.emit("message", { ...cancel, sessionID: "other" })
    child.emit("message", { ...cancel, id: "unknown" })
    other.emit("message", cancel)
    expect(calls[0].signal.aborted).toBe(false)
    child.emit("message", { ...request, sessionID: "other" })
    expect(replies).toEqual([])
    expect(calls).toHaveLength(1)
    expect(calls[0].signal.aborted).toBe(false)
    child.emit("message", cancel)
    expect(calls[0].signal.aborted).toBe(true)
    expect(replies.at(-1)?.response).toMatchObject({ code: "cancelled" })
    const count = replies.length
    child.emit("message", cancel)
    expect(replies).toHaveLength(count)
    child.emit("message", request)
    expect(calls).toHaveLength(1)
    expect(getEventListeners(calls[0].signal, "abort")).toHaveLength(0)
    calls[0].done.resolve(failure("no_target", "late"))
    await calls[0].done.promise
    await new Promise((resolve) => setImmediate(resolve))
    expect(replies).toHaveLength(count)
    child.emit("message", request)
    expect(calls).toHaveLength(2)
    child.emit("exit", 1)
    expect(calls[1].signal.aborted).toBe(true)
    expect(child.listenerCount("message")).toBe(0)
    expect(child.listenerCount("exit")).toBe(0)
    child.emit("message", request)
    expect(calls).toHaveLength(2)
  } finally {
    stop()
    stopOther()
    calls.forEach(({ done }) => done.resolve(failure("no_target", "cleanup")))
  }
})

test("explicit sidecar stop aborts outstanding work and suppresses late replies", async () => {
  const child = new EventEmitter()
  const replies: BrowserIpcResult[] = []
  const done = Promise.withResolvers<ReturnType<typeof failure>>()
  let signal: AbortSignal | undefined
  const stop = attachBrowserBridge(
    Object.assign(child, {
      postMessage: (reply: BrowserIpcResult) => {
        replies.push(reply)
      },
    }),
    async (_request, _allowed, control) => {
      signal = control.signal
      return done.promise
    },
  )
  child.emit("message", { type: "browser_request", id: "stop", sessionID: "one", request: { op: "list_tabs" } })
  stop()
  stop()
  expect(signal?.aborted).toBe(true)
  expect(child.listenerCount("message")).toBe(0)
  done.resolve(failure("no_target", "late"))
  await done.promise
  await new Promise((resolve) => setImmediate(resolve))
  expect(replies).toEqual([])
})

test.each(["valid", "stale", "missing"] as const)(
  "network delivery requires final-post authority: %s",
  async (mode) => {
    const replies: BrowserIpcResult[] = []
    const child = Object.assign(new EventEmitter(), {
      postMessage: (reply: BrowserIpcResult) => {
        replies.push(reply)
      },
    })
    let checked = false
    const stop = attachBrowserBridge(child, async (_request, _allowed, control) => {
      if (mode !== "missing")
        control.onScreenshotDelivery?.(() => {
          checked = true
          if (mode === "stale") throw new Error("Source changed")
        })
      return success({
        tabID: "tab",
        url: "https://example.test",
        title: "",
        visibleText: "",
        elements: [],
        diagnostics: {
          network: {
            durationMs: 250,
            http1xx: 0,
            http2xx: 1,
            http3xx: 0,
            http4xx: 0,
            http5xx: 0,
            other: 0,
            failed: 0,
            total: 1,
          },
        },
      })
    })
    try {
      child.emit("message", {
        type: "browser_request",
        id: "network",
        sessionID: "one",
        request: {
          op: "observe_network",
          tabID: "tab",
          durationMs: 250,
          context: {
            tabID: "tab",
            origin: "https://example.test",
            urlHash: "a".repeat(64),
            revision: 0,
            accessRevision: 0,
            ownerContext: "owner-task",
          },
        },
      })
      await new Promise((resolve) => setImmediate(resolve))
      expect(replies).toHaveLength(1)
      expect(replies[0].response.ok).toBe(mode === "valid")
      expect(checked).toBe(mode !== "missing")
      if (mode !== "valid") {
        expect(replies[0].response).toMatchObject({ code: "unavailable" })
        expect(JSON.stringify(replies[0])).not.toContain("http2xx")
      }
    } finally {
      stop()
    }
  },
)

test("site tool delivery rechecks authority immediately before sidecar post", async () => {
  const child = new EventEmitter()
  const replies: BrowserIpcResult[] = []
  let valid = true
  const stop = attachBrowserBridge(
    Object.assign(child, {
      postMessage: (reply: BrowserIpcResult) => {
        replies.push(reply)
      },
    }),
    async (_request, _allowed, control) => {
      control.onScreenshotDelivery?.(() => {
        if (!valid) throw new Error("Source changed")
      })
      valid = false
      return success({
        tabID: "tab",
        url: "https://example.com",
        title: "",
        visibleText: "",
        elements: [],
        siteTools: [],
      })
    },
  )
  try {
    child.emit("message", {
      type: "browser_request",
      id: "site-tools",
      sessionID: "one",
      request: { op: "list_site_tools", tabID: "tab" },
    })
    await new Promise((resolve) => setImmediate(resolve))
    expect(replies).toEqual([
      {
        type: "browser_result",
        id: "site-tools",
        response: { ok: false, code: "unavailable", error: "Website tool delivery unavailable." },
      },
    ])
  } finally {
    stop()
  }
})

test("delivery suppression keeps dispatched action status while withholding stale page state", async () => {
  const child = new EventEmitter()
  const replies: BrowserIpcResult[] = []
  const stop = attachBrowserBridge(
    Object.assign(child, { postMessage: (reply: BrowserIpcResult) => replies.push(reply) }),
    async (_request, _allowed, control) => {
      control.onActionDispatch?.()
      control.onScreenshotDelivery?.(() => {
        throw new Error("source changed")
      })
      return {
        ...success({ tabID: "tab", url: "https://example.test/", title: "", visibleText: "changed", elements: [] }),
        actionStatus: "dispatched_observed",
      }
    },
  )
  try {
    child.emit("message", {
      type: "browser_request",
      id: "click-delivery",
      sessionID: "one",
      request: {
        op: "click",
        tabID: "tab",
        ref: "snapshot:e0",
        context: {
          tabID: "tab",
          origin: "https://example.test",
          urlHash: "a".repeat(64),
          revision: 0,
          accessRevision: 0,
          ownerContext: "owner",
        },
      },
    })
    await new Promise((resolve) => setImmediate(resolve))
    expect(replies).toHaveLength(1)
    expect(replies[0].response).toMatchObject({ ok: false, code: "unavailable", actionStatus: "dispatched_uncertain" })
    expect(JSON.stringify(replies[0])).not.toContain("changed")
  } finally {
    stop()
  }
})

test("bridge cancellation after dispatch reports an uncertain action", async () => {
  const child = new EventEmitter()
  const replies: BrowserIpcResult[] = []
  const operation = Promise.withResolvers<BrowserIpcResult["response"]>()
  let control: { onActionDispatch?: () => void } | undefined
  const stop = attachBrowserBridge(
    Object.assign(child, { postMessage: (reply: BrowserIpcResult) => replies.push(reply) }),
    async (_request, _allowed, current) => {
      control = current
      return operation.promise
    },
  )
  try {
    child.emit("message", {
      type: "browser_request",
      id: "click-cancel",
      sessionID: "one",
      request: {
        op: "click",
        tabID: "tab",
        ref: "snapshot:e0",
        context: {
          tabID: "tab",
          origin: "https://example.test",
          urlHash: "a".repeat(64),
          revision: 0,
          accessRevision: 0,
          ownerContext: "owner",
        },
      },
    })
    control?.onActionDispatch?.()
    child.emit("message", { type: "browser_cancel", id: "click-cancel", sessionID: "one" })
    expect(replies[0].response).toMatchObject({
      code: "cancelled",
      actionStatus: "dispatched_uncertain",
      actionCause: "cancelled",
    })
    operation.resolve(failure("cancelled", "Browser operation cancelled."))
    await new Promise((resolve) => setImmediate(resolve))
  } finally {
    stop()
  }
})

const deliveryContext = {
  tabID: "tab",
  origin: "https://example.test",
  urlHash: "a".repeat(64),
  revision: 0,
  accessRevision: 0,
  ownerContext: "owner-task",
}

function pageStateRequest(op: string): BrowserIpcRequest["request"] {
  if (op === "read_state") return { op, tabID: "tab" }
  if (op === "navigate") return { op, tabID: "tab", url: "https://example.test/next", context: deliveryContext }
  if (op === "click") return { op, tabID: "tab", ref: "snapshot:button", context: deliveryContext }
  if (op === "hover") return { op, tabID: "tab", ref: "snapshot:button", context: deliveryContext }
  if (op === "drag")
    return { op, tabID: "tab", sourceRef: "snapshot:source", targetRef: "snapshot:target", context: deliveryContext }
  if (op === "select_option")
    return { op, tabID: "tab", ref: "snapshot:select", optionRef: "snapshot:option", context: deliveryContext }
  if (op === "fill") return { op, tabID: "tab", ref: "snapshot:input", text: "value", context: deliveryContext }
  if (op === "press_key") return { op, tabID: "tab", key: "Enter", modifiers: [], context: deliveryContext }
  if (op === "scroll") return { op, tabID: "tab", deltaX: 0, deltaY: 100, timeoutMs: 1000, context: deliveryContext }
  if (op === "wait_for_element") return { op, tabID: "tab", selector: "#ready", timeoutMs: 1000 }
  return { op: "wait_for_navigation", tabID: "tab", url: "https://example.test/next", timeoutMs: 1000 }
}

test.each([
  "read_state",
  "navigate",
  "click",
  "hover",
  "drag",
  "select_option",
  "fill",
  "press_key",
  "scroll",
  "wait_for_element",
  "wait_for_navigation",
] as const)("%s page-state delivery fails closed with missing or stale authority", async (op) => {
  for (const mode of ["valid", "stale", "missing"] as const) {
    const replies: BrowserIpcResult[] = []
    const child = Object.assign(new EventEmitter(), {
      postMessage: (reply: BrowserIpcResult) => {
        replies.push(reply)
      },
    })
    const stop = attachBrowserBridge(child, async (_request, _allowed, control) => {
      if (mode !== "missing")
        control.onScreenshotDelivery?.(() => {
          if (mode === "stale") throw new Error("Source changed")
        })
      return success({
        tabID: "tab",
        url: "https://example.test/private?token=secret",
        title: "Private title",
        visibleText: "private page text",
        elements: [{ ref: "snapshot:secret", tag: "button", role: "", label: "Private", text: "Private" }],
      })
    })
    try {
      child.emit("message", {
        type: "browser_request",
        id: `${op}-${mode}`,
        sessionID: "one",
        request: pageStateRequest(op),
      })
      await new Promise((resolve) => setImmediate(resolve))
      expect(replies).toHaveLength(1)
      expect(replies[0].response.ok).toBe(mode === "valid")
      if (mode !== "valid") {
        expect(replies[0].response).toMatchObject({ code: "unavailable" })
        expect(JSON.stringify(replies[0])).not.toContain("private")
        expect(JSON.stringify(replies[0])).not.toContain("secret")
      }
    } finally {
      stop()
    }
  }
})

test.each([
  {
    name: "screenshot",
    result: {
      tabID: "",
      url: "",
      title: "",
      visibleText: "",
      elements: [],
      screenshot: { data: "private-image", width: 1, height: 1 },
    },
  },
  {
    name: "diagnostics",
    result: {
      tabID: "",
      url: "",
      title: "",
      visibleText: "",
      elements: [],
      diagnostics: {
        console: { durationMs: 250, debug: 0, info: 0, warning: 0, error: 1, other: 0, total: 1 },
      },
    },
  },
] as const)("unexpected $name payload still requires a final-post guard", async ({ name, result }) => {
  const replies: BrowserIpcResult[] = []
  const child = Object.assign(new EventEmitter(), {
    postMessage: (reply: BrowserIpcResult) => {
      replies.push(reply)
    },
  })
  const stop = attachBrowserBridge(child, async () => success(result))
  try {
    child.emit("message", {
      type: "browser_request",
      id: `mismatch-${name}`,
      sessionID: "one",
      request: { op: "list_tabs" },
    } satisfies BrowserIpcRequest)
    await new Promise((resolve) => setImmediate(resolve))
    expect(replies).toHaveLength(1)
    expect(replies[0].response).toMatchObject({ code: "unavailable" })
    expect(JSON.stringify(replies[0])).not.toContain(name === "screenshot" ? "private-image" : "durationMs")
  } finally {
    stop()
  }
})
