import { expect, test } from "bun:test"
import { EventEmitter, getEventListeners } from "node:events"
import { failure, success, type BrowserIpcResult } from "@cookiemonster/cm-browser/protocol"
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
