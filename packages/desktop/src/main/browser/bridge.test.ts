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
