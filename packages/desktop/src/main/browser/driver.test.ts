import { describe, expect, test } from "bun:test"
import { MAX_SNAPSHOT_BYTES } from "@cookiemonster/cm-browser/protocol"
import { execute, type DriverContents, type Target } from "./driver"
import { parseSnapshot, snapshotScript } from "./snapshot"

type Call = { method: string; params?: Record<string, unknown> }
const element = (fingerprint = "send") => ({
  tag: "button",
  role: "",
  label: "Send",
  text: "Send",
  fingerprint,
  rect: { x: 10, y: 20, width: 40, height: 10 },
})

function fake(options: { url?: string; destroyed?: boolean; snapshot?: unknown } = {}) {
  const calls: Call[] = []
  let attached = false
  let url = options.url ?? "http://localhost:5173/"
  let elements = [element()]
  const contents: DriverContents = {
    isDestroyed: () => options.destroyed === true,
    isLoadingMainFrame: () => false,
    stop: () => {},
    getURL: () => url,
    loadURL: async (next) => {
      url = next
    },
    debugger: {
      isAttached: () => attached,
      attach: () => {
        attached = true
      },
      sendCommand: async (method, params) => {
        calls.push({ method, params })
        if (method !== "Runtime.evaluate") return {}
        return (
          options.snapshot ?? {
            result: { value: { url, title: "Dev", visibleText: "Send", elements } },
          }
        )
      },
    },
  }
  return {
    target: { tabID: "one", contents } satisfies Target,
    calls,
    attached: () => attached,
    setElements: (next: typeof elements) => {
      elements = next
    },
  }
}

async function firstRef(view: ReturnType<typeof fake>) {
  const response = await execute(view.target, { tabID: "one", op: "read_state" })
  if (!response.ok) throw new Error(response.error)
  return response.result.elements[0].ref
}

describe("browser driver", () => {
  test("read_state attaches and returns bounded visible state with opaque refs", async () => {
    const view = fake()
    const response = await execute(view.target, { tabID: "one", op: "read_state" })
    expect(response.ok).toBe(true)
    expect(view.attached()).toBe(true)
    if (!response.ok) return
    expect(response.result).toMatchObject({ url: "http://localhost:5173/", title: "Dev", visibleText: "Send" })
    expect(response.result.elements[0].ref).toMatch(/^one\.[0-9a-f-]+:e[0-9a-z]+$/)
  })

  test("click validates the ref, dispatches trusted mouse events, and refreshes state", async () => {
    const view = fake()
    const response = await execute(view.target, { tabID: "one", op: "click", ref: await firstRef(view) })
    expect(response.ok).toBe(true)
    const mouse = view.calls.filter((call) => call.method === "Input.dispatchMouseEvent")
    expect(mouse.map((call) => call.params?.type)).toEqual(["mouseMoved", "mousePressed", "mouseReleased"])
    expect(mouse[0]?.params).toMatchObject({ x: 30, y: 25 })
    expect(view.calls.filter((call) => call.method === "Runtime.evaluate" && call.params?.returnByValue)).toHaveLength(
      3,
    )
  })

  test("stale refs never dispatch input", async () => {
    const view = fake()
    const ref = await firstRef(view)
    view.setElements([element("changed")])
    expect(await execute(view.target, { tabID: "one", op: "click", ref })).toMatchObject({
      ok: false,
      code: "stale_ref",
    })
    expect(view.calls.some((call) => call.method === "Input.dispatchMouseEvent")).toBe(false)
  })

  test("fill selects, clears, and types every character with trusted key events", async () => {
    const view = fake()
    await execute(view.target, { tabID: "one", op: "fill", ref: await firstRef(view), text: "hi" })
    expect(view.calls.some((call) => call.method === "Input.insertText")).toBe(false)
    const down = view.calls
      .filter((call) => call.method === "Input.dispatchKeyEvent" && call.params?.type === "keyDown")
      .map((call) => call.params)
    expect(down).toMatchObject([
      { key: "a", modifiers: process.platform === "darwin" ? 4 : 2 },
      { key: "Backspace", modifiers: 0 },
      { key: "h", text: "h" },
      { key: "i", text: "i" },
    ])
  })

  test("press_key supports modifiers including Ctrl+Enter", async () => {
    const view = fake()
    const response = await execute(view.target, { tabID: "one", op: "press_key", key: "Enter", modifiers: ["Ctrl"] })
    expect(response.ok).toBe(true)
    const keys = view.calls.filter((call) => call.method === "Input.dispatchKeyEvent")
    expect(keys.map((call) => call.params?.type)).toEqual(["keyDown", "keyUp"])
    expect(keys[0]?.params).toMatchObject({ key: "Enter", modifiers: 2 })
  })

  test("navigate loads the destination and returns its state", async () => {
    const view = fake()
    const response = await execute(view.target, { tabID: "one", op: "navigate", url: "https://teams.microsoft.com/" })
    expect(response.ok && response.result.url).toBe("https://teams.microsoft.com/")
  })

  test("loading guards dispatch and awaits while navigation waits for its destination", async () => {
    const view = fake()
    let loading = true
    view.target.contents.isLoadingMainFrame = () => loading
    await expect(execute(view.target, { tabID: "one", op: "press_key", key: "Enter", modifiers: [] })).rejects.toThrow(
      "loading",
    )
    expect(view.calls).toEqual([])
    loading = false
    const send = view.target.contents.debugger.sendCommand
    view.target.contents.debugger.sendCommand = async (method, params) => {
      const result = await send(method, params)
      loading = true
      return result
    }
    await expect(execute(view.target, { tabID: "one", op: "press_key", key: "Enter", modifiers: [] })).rejects.toThrow(
      "loading",
    )
    expect(view.calls.some((call) => call.method.startsWith("Input."))).toBe(false)
    view.target.contents.debugger.sendCommand = send
    const timer = setTimeout(() => {
      loading = false
    }, 20)
    try {
      const result = await execute(view.target, { tabID: "one", op: "navigate", url: "http://localhost/short" })
      expect(result.ok && result.result.url).toBe("http://localhost/short")
    } finally {
      clearTimeout(timer)
    }
  })

  test("oversized source returns a bounded failure without preventing short recovery navigation", async () => {
    const source = "http://localhost/?history=" + "x".repeat(MAX_SNAPSHOT_BYTES)
    const view = fake({ url: source })
    view.setElements([])
    const response = await execute(view.target, { tabID: "one", op: "read_state" })
    expect(Buffer.byteLength(JSON.stringify(response))).toBeLessThanOrEqual(MAX_SNAPSHOT_BYTES)
    expect(response).toMatchObject({ ok: false, code: "unavailable" })
    expect(view.target.contents.getURL()).toBe(source)
    const recovered = await execute(view.target, { tabID: "one", op: "navigate", url: "http://localhost/short" })
    expect(recovered.ok && recovered.result.url).toBe("http://localhost/short")
    expect(Buffer.byteLength(JSON.stringify(recovered))).toBeLessThanOrEqual(MAX_SNAPSHOT_BYTES)
  })

  test("destroyed and malformed pages fail safely", async () => {
    const destroyed = fake({ destroyed: true })
    expect(await execute(destroyed.target, { tabID: "one", op: "read_state" })).toMatchObject({
      ok: false,
      code: "detached",
    })
    const malformed = fake({ snapshot: {} })
    expect(await execute(malformed.target, { tabID: "one", op: "read_state" })).toMatchObject({
      ok: false,
      code: "unavailable",
    })
  })
})

describe("snapshot", () => {
  test("collects visible text and interactive elements without arbitrary agent script input", () => {
    const script = snapshotScript()
    expect(script).toContain("button:not([disabled])")
    expect(script).toContain("document.body?.innerText")
    expect(script).toContain("fingerprint")
  })

  test("drops malformed elements", () => {
    const state = parseSnapshot({
      result: {
        value: {
          url: "http://localhost/",
          title: "t",
          visibleText: "hello",
          elements: [element(), null],
        },
      },
    })
    expect(state?.elements).toHaveLength(1)
    expect(state?.visibleText).toBe("hello")
  })
})
