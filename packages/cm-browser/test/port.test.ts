import { expect, test } from "bun:test"
import { EventEmitter, getEventListeners } from "node:events"
import { ipcPort } from "../src/port"
import {
  OPERATION_TIMEOUT_MS,
  MAX_BROWSER_PENDING,
  MAX_BROWSER_CONTROL_PENDING,
  MAX_BROWSER_REQUEST_BYTES,
  failure,
  success,
  type BrowserIpcRequest,
  type BrowserIpcCancel,
  type BrowserState,
} from "../src/protocol"

function fixture() {
  const parent = new EventEmitter()
  const sent: { type: string; id: string; sessionID: string }[] = []
  const port = ipcPort(
    Object.assign(parent, {
      postMessage: (message: BrowserIpcRequest | BrowserIpcCancel) => {
        sent.push(message)
      },
    }),
  )
  const reply = (id: string) =>
    parent.emit("message", { data: { type: "browser_result", id, response: failure("no_target", "late") } })
  return { parent, sent, port, reply }
}

test("completed requests remove abort listeners and never cancel after a reply", async () => {
  const { port, parent, sent, reply } = fixture()
  const controller = new AbortController()
  const pending = port.send("session", { op: "list_tabs" }, controller.signal)
  reply(sent[0].id)
  expect(await pending).toMatchObject({ code: "no_target" })
  controller.abort()
  expect(sent).toHaveLength(1)
  expect(parent.listenerCount("message")).toBe(0)
  expect(getEventListeners(controller.signal, "abort")).toHaveLength(0)
})

test("post failure cleans pending state even when cancellation cannot be delivered", async () => {
  const parent = new EventEmitter()
  const controller = new AbortController()
  const port = ipcPort(
    Object.assign(parent, {
      postMessage: () => {
        throw new Error("closed")
      },
    }),
  )
  expect(await port.send("session", { op: "list_tabs" }, controller.signal)).toMatchObject({ code: "unavailable" })
  expect(parent.listenerCount("message")).toBe(0)
  expect(getEventListeners(controller.signal, "abort")).toHaveLength(0)
})

test("pre-abort never dispatches or subscribes", async () => {
  const { port, parent, sent, reply } = fixture()
  const controller = new AbortController()
  controller.abort()
  const pending = port.send("session", { op: "list_tabs" }, controller.signal)
  if (sent[0]) reply(sent[0].id)
  expect(await pending).toMatchObject({ code: "cancelled" })
  expect(sent).toEqual([])
  expect(parent.listenerCount("message")).toBe(0)
  expect(getEventListeners(controller.signal, "abort")).toHaveLength(0)
})

test("pending abort waits for the bridge outcome so dispatch status is preserved", async () => {
  const { port, parent, sent, reply } = fixture()
  const controller = new AbortController()
  const pending = port.send("session", { op: "list_tabs" }, controller.signal)
  expect(parent.listenerCount("message")).toBe(1)
  controller.abort()
  parent.emit("message", {
    data: {
      type: "browser_result",
      id: sent[0].id,
      response: {
        ok: false,
        code: "cancelled",
        error: "Browser operation cancelled.",
        actionStatus: "dispatched_uncertain",
      },
    },
  })
  expect(await pending).toMatchObject({ code: "cancelled", actionStatus: "dispatched_uncertain" })
  expect(sent).toEqual([
    expect.objectContaining({ type: "browser_request", sessionID: "session" }),
    { type: "browser_cancel", sessionID: "session", id: sent[0].id },
  ])
  expect(parent.listenerCount("message")).toBe(0)
  expect(getEventListeners(controller.signal, "abort")).toHaveLength(0)
  const next = port.send("session", { op: "list_tabs" })
  reply(sent[2].id)
  expect(await next).toMatchObject({ code: "no_target" })
  expect(parent.listenerCount("message")).toBe(0)
})

test(
  "transport timeout cancels dispatched work and removes timer/listeners",
  async () => {
    const { port, parent, sent, reply } = fixture()
    const controller = new AbortController()
    expect(await port.send("session", { op: "list_tabs" }, controller.signal)).toMatchObject({ code: "timeout" })
    expect(sent).toHaveLength(2)
    expect(sent[1]).toEqual({ type: "browser_cancel", id: sent[0].id, sessionID: "session" })
    controller.abort()
    reply(sent[0].id)
    expect(sent).toHaveLength(2)
    expect(parent.listenerCount("message")).toBe(0)
    expect(getEventListeners(controller.signal, "abort")).toHaveLength(0)
  },
  OPERATION_TIMEOUT_MS + 5000,
)

test("correlates out-of-order utility-process results", async () => {
  const sent: { type: string; id: string; sessionID: string }[] = []
  let receive: ((event: { data: unknown }) => void) | undefined
  const port = ipcPort({
    postMessage: (message) => sent.push(message),
    on: (_event, listener) => {
      receive = listener
    },
    off: () => {
      receive = undefined
    },
  })
  const first = port.send("ses_1", { op: "read_state", tabID: "one" })
  const second = port.send("ses_2", { op: "read_state", tabID: "one" })
  const state = (url: string): BrowserState => ({ tabID: "one", url, title: "", visibleText: "", elements: [] })
  receive?.({ data: { type: "browser_result", id: sent[1].id, response: success(state("https://two.test")) } })
  receive?.({ data: { type: "browser_result", id: sent[0].id, response: success(state("https://one.test")) } })
  const firstResult = await first
  const secondResult = await second
  expect(firstResult.ok ? firstResult.result.url : "").toBe("https://one.test")
  expect(secondResult.ok ? secondResult.result.url : "").toBe("https://two.test")
})

test("request capacity rejects immediately and completion and disconnect restore capacity", async () => {
  const f = fixture()
  const pending = Array.from({ length: MAX_BROWSER_PENDING }, () => f.port.send("session", { op: "list_tabs" }))
  expect(await f.port.send("session", { op: "list_tabs" })).toMatchObject({ code: "unavailable" })
  expect(f.sent).toHaveLength(MAX_BROWSER_PENDING)
  f.reply(f.sent[0].id)
  const next = f.port.send("session", { op: "list_tabs" })
  expect(f.sent).toHaveLength(MAX_BROWSER_PENDING + 1)
  f.port.disconnect()
  await Promise.all([...pending, next])
  expect(f.parent.listenerCount("message")).toBe(0)
  const reopened = f.port.send("session", { op: "list_tabs" })
  f.reply(f.sent.at(-1)!.id)
  expect(await reopened).toMatchObject({ code: "no_target" })
})

test("oversized envelopes never dispatch or retain a listener", async () => {
  const f = fixture()
  expect(await f.port.send("x".repeat(MAX_BROWSER_REQUEST_BYTES), { op: "list_tabs" })).toMatchObject({
    code: "bad_request",
  })
  expect(f.sent).toHaveLength(0)
  expect(f.parent.listenerCount("message")).toBe(0)
})

test("revocations have bounded reserved capacity and cancellation still dispatches", async () => {
  const f = fixture()
  const controller = new AbortController()
  const pending = Array.from({ length: MAX_BROWSER_PENDING }, () =>
    f.port.send("session", { op: "list_tabs" }, controller.signal),
  )
  const revocations = Array.from({ length: MAX_BROWSER_CONTROL_PENDING }, (_, id) =>
    f.port.send("session", { op: "revoke_tabs", executionID: String(id) }),
  )
  expect(f.sent).toHaveLength(MAX_BROWSER_PENDING + MAX_BROWSER_CONTROL_PENDING)
  expect(await f.port.send("session", { op: "revoke_tabs", executionID: "overflow" })).toMatchObject({
    code: "unavailable",
  })
  controller.abort()
  expect(f.sent.filter((message) => message.type === "browser_cancel")).toHaveLength(MAX_BROWSER_PENDING)
  f.port.disconnect()
  await Promise.all([...pending, ...revocations])
})
