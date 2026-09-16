import { describe, expect, test } from "bun:test"
import { MAX_SNAPSHOT_BYTES } from "@cookiemonster/cm-browser/protocol"
import { execute, type DriverContents, type Target } from "./driver"
import { parseSnapshot, snapshotScript } from "./snapshot"
import { DESKTOP_NATIVE_ENGLISH, createDesktopNativeBundle } from "@opencode-ai/app/i18n/desktop-native"
import { setNativeTranslations } from "../native-translations"

type Call = { method: string; params?: Record<string, unknown> }
const element = (token = "send") => ({
  tag: "button",
  role: "button",
  label: "Send",
  text: "Send",
  token,
  disabled: false,
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
        if (method === "Page.getFrameTree") return { frameTree: { frame: { id: "main" } } }
        if (method === "Page.createIsolatedWorld")
          return { executionContextId: params?.worldName === "cm-browser-wait" ? 7 : 8 }
        if (method !== "Runtime.evaluate") return {}
        if (params?.contextId !== 8) return { result: { value: undefined } }
        expect(params.timeout).toBeGreaterThan(0)
        const reference = /reference = (\{[^\n]+\}|null);/.exec(String(params.expression))
        const expected = reference?.[1] !== "null" && reference?.[1] ? JSON.parse(reference[1]) : undefined
        const current = expected ? elements.filter((element) => element.token === expected.token) : elements
        return (
          options.snapshot ?? {
            result: {
              value: { generation: "document-one", url, title: "Dev", visibleText: "Send", elements: current },
            },
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
  test("scroll sends one wheel over a current ref without down/up and refreshes", async () => {
    const view = fake()
    const ref = await firstRef(view)
    const response = await execute(view.target, {
      op: "scroll",
      tabID: "one",
      ref,
      deltaX: -100,
      deltaY: 200,
      timeoutMs: 1000,
    })
    expect(response.ok).toBe(true)
    expect(view.calls.filter((call) => call.method.startsWith("Input."))).toEqual([
      { method: "Input.dispatchMouseEvent", params: { type: "mouseWheel", x: 30, y: 25, deltaX: -100, deltaY: 200 } },
    ])
    expect(response.ok && response.result.elements[0].ref).not.toBe(ref)
    view.setElements([element("changed")])
    expect(await execute(view.target, { op: "scroll", tabID: "one", ref, deltaX: 0, deltaY: 1 })).toMatchObject({
      code: "stale_ref",
    })
    expect(view.calls.filter((call) => call.method.startsWith("Input."))).toHaveLength(1)
  })

  test("element wait rejects selectors outside its safe subset before any native query", async () => {
    for (const selector of [
      'input[value^="s"]',
      'input[value^="wrong"]',
      'body:has(input[value^="s"])',
      'input[value^="s"] + div',
      'body input[value^="s"]',
      '[name="password"]',
      ":is(#ready)",
      ":not(#ready)",
      "input:valid",
      "#ready:hover",
      "#\\\\72 eady",
      "#ready,body",
      "#ready > div",
      "#ready div",
      "*",
      "|input",
      "#ready\n",
      "#ready\r",
      "#ready\t",
      "#ready/*comment*/",
      "#",
      ".1ready",
      "x".repeat(513),
      "",
    ]) {
      const view = fake()
      expect(await execute(view.target, { op: "wait_for_element", tabID: "one", selector, timeoutMs: 1000 })).toEqual({
        ok: false,
        code: "bad_request",
        error: "Invalid CSS selector.",
      })
      expect(view.calls).toEqual([])
    }
  })

  test("new driver failures use the typed native bundle, including quarantine", async () => {
    const messages = createDesktopNativeBundle("en", (key) =>
      key.startsWith("desktop.browser.driver.") ? `fixture:${key}` : DESKTOP_NATIVE_ENGLISH[key],
    )
    setNativeTranslations(messages)
    try {
      const view = fake()
      const ref = await firstRef(view)
      view.setElements([element("changed")])
      expect(await execute(view.target, { op: "scroll", tabID: "one", ref, deltaX: 0, deltaY: 1 })).toMatchObject({
        error: "fixture:desktop.browser.driver.staleScrollRef",
      })
      expect(await execute(view.target, { op: "scroll", tabID: "one", deltaX: 0, deltaY: 1 })).toMatchObject({
        error: "fixture:desktop.browser.driver.viewportUnavailable",
      })
      const send = view.target.contents.debugger.sendCommand.bind(view.target.contents.debugger)
      view.target.contents.debugger.sendCommand = async (method, params) => {
        if (params?.type === "keyDown") throw new Error("Held input")
        return send(method, params)
      }
      await expect(execute(view.target, { op: "press_key", tabID: "one", key: "x", modifiers: [] })).rejects.toThrow()
      expect(await execute(view.target, { op: "read_state", tabID: "one" })).toMatchObject({
        error: "fixture:desktop.browser.driver.inputHeld",
      })
    } finally {
      setNativeTranslations(createDesktopNativeBundle("en", (key) => DESKTOP_NATIVE_ENGLISH[key]))
    }
  })

  test.each([true, false, "invalid"])("element wait probes a bounded visible result: %s", async (match) => {
    const view = fake()
    const send = view.target.contents.debugger.sendCommand.bind(view.target.contents.debugger)
    view.target.contents.debugger.sendCommand = async (method, params) => {
      if (method === "Page.getFrameTree") return { frameTree: { frame: { id: "main" } } }
      if (method === "Page.createIsolatedWorld")
        return { executionContextId: params?.worldName === "cm-browser-wait" ? 7 : 8 }
      if (params?.contextId === 7) return { result: { value: match } }
      return send(method, params)
    }
    const pending = execute(view.target, { op: "wait_for_element", tabID: "one", selector: "#ready", timeoutMs: 30 })
    if (match === false) await expect(pending).rejects.toThrow(/timed out/)
    else expect(await pending).toMatchObject(match === true ? { ok: true } : { code: "bad_request" })
    expect(view.calls.some((call) => call.method.startsWith("Input."))).toBe(false)
  })

  test("navigation wait observes an already finished exact URL without loading or stopping", async () => {
    const view = fake()
    view.target.contents.loadURL = async () => {
      throw new Error("Must not navigate")
    }
    view.target.contents.stop = () => {
      throw new Error("Must not stop")
    }
    expect(
      await execute(view.target, {
        op: "wait_for_navigation",
        tabID: "one",
        url: view.target.contents.getURL(),
        timeoutMs: 1000,
      }),
    ).toMatchObject({ ok: true })
    await expect(
      execute(view.target, { op: "wait_for_navigation", tabID: "one", url: "http://localhost/other", timeoutMs: 20 }),
    ).rejects.toThrow(/timed out/)
  })

  test.each(["pre-abort", "held command", "poll"])("cancellation at %s prevents follow-on commands", async (stage) => {
    const view = fake()
    const controller = new AbortController()
    const entered = Promise.withResolvers<void>()
    const held = Promise.withResolvers<void>()
    let stops = 0
    view.target.contents.stop = () => {
      stops++
    }
    const send = view.target.contents.debugger.sendCommand.bind(view.target.contents.debugger)
    view.target.contents.debugger.sendCommand = async (method, params) => {
      const value = await send(method, params)
      entered.resolve()
      await held.promise
      return value
    }
    if (stage === "pre-abort") controller.abort()
    if (stage === "poll") {
      view.target.contents.loadURL = async () => {
        entered.resolve()
      }
      view.target.contents.isLoadingMainFrame = () => true
    }
    const pending = execute(
      { ...view.target, signal: controller.signal, deadline: Date.now() + 1000 },
      stage === "poll"
        ? { tabID: "one", op: "navigate", url: "http://localhost/next" }
        : { tabID: "one", op: "press_key", key: "Enter", modifiers: [] },
    )
    const outcome = pending.catch((error: unknown) => error)
    try {
      if (stage !== "pre-abort" && stage !== "poll") await entered.promise
      controller.abort()
      held.resolve()
      expect(await outcome).toBeInstanceOf(Error)
      expect(view.calls.filter((call) => call.method.startsWith("Input."))).toEqual([])
      if (stage === "pre-abort") expect(view.attached()).toBe(false)
      expect(stops).toBe(stage === "poll" ? 1 : 0)
    } finally {
      held.resolve()
      controller.abort()
    }
  })

  test.each([
    ["keyDown", "cancel", true],
    ["mousePressed", "cancel", true],
    ["keyDown", "reject", true],
    ["mousePressed", "reject", true],
    ["keyUp", "reject", true],
    ["mouseReleased", "reject", true],
    ["keyUp", "cancel", false],
    ["mouseReleased", "cancel", false],
  ] as const)("interrupted %s (%s) quarantines only unacknowledged pairs", async (type, reason, blocked) => {
    const view = fake()
    const ref = await firstRef(view)
    const controller = new AbortController()
    const send = view.target.contents.debugger.sendCommand.bind(view.target.contents.debugger)
    view.target.contents.debugger.sendCommand = async (method, params) => {
      const result = await send(method, params)
      if (params?.type === type) {
        if (reason === "reject") throw new Error("Uncertain native completion")
        controller.abort()
      }
      return result
    }
    await expect(
      execute(
        { ...view.target, signal: controller.signal },
        type.startsWith("key")
          ? { op: "press_key", tabID: "one", key: "x", modifiers: [] }
          : { op: "fill", tabID: "one", ref, text: "must not type" },
      ),
    ).rejects.toThrow()
    const input = view.calls.filter((call) => call.method.startsWith("Input."))
    expect(input.at(-1)?.params?.type).toBe(type)
    view.target.contents.debugger.sendCommand = send
    const count = view.calls.length
    const result = await execute(view.target, { op: "read_state", tabID: "one" })
    expect(result.ok).toBe(!blocked)
    if (blocked) {
      expect(result).toMatchObject({ code: "unavailable", error: expect.stringContaining("Close this tab") })
      expect(await execute(view.target, { op: "navigate", tabID: "one", url: "http://localhost/new" })).toMatchObject({
        code: "unavailable",
      })
      for (const request of [
        { op: "scroll", tabID: "one", deltaX: 0, deltaY: 1 },
        { op: "wait_for_element", tabID: "one", selector: "#ready", timeoutMs: 1000 },
        { op: "wait_for_navigation", tabID: "one", url: view.target.contents.getURL(), timeoutMs: 1000 },
      ] as const)
        expect(await execute(view.target, request)).toMatchObject({ code: "unavailable" })
      expect(view.calls).toHaveLength(count)
    }
  })

  test("read_state attaches and returns bounded visible state with opaque refs", async () => {
    const view = fake()
    const response = await execute(view.target, { tabID: "one", op: "read_state" })
    expect(response.ok).toBe(true)
    expect(view.attached()).toBe(true)
    if (!response.ok) return
    expect(response.result).toMatchObject({ url: "http://localhost:5173/", title: "Dev", visibleText: "Send" })
    expect(response.result.elements[0].ref).toMatch(/^one\.[0-9a-f-]+:send$/)
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

  test("each isolated capture await retains cancellation guards", async () => {
    for (const boundary of ["Page.getFrameTree", "Page.createIsolatedWorld", "Runtime.evaluate"]) {
      const view = fake()
      const ref = await firstRef(view)
      const controller = new AbortController()
      const send = view.target.contents.debugger.sendCommand.bind(view.target.contents.debugger)
      let reached = false
      view.target.contents.debugger.sendCommand = async (method, params) => {
        const value = await send(method, params)
        if (method === boundary && (method !== "Runtime.evaluate" || params?.contextId === 8)) {
          reached = true
          controller.abort()
        }
        return value
      }
      await expect(
        execute({ ...view.target, signal: controller.signal }, { op: "click", tabID: "one", ref }),
      ).rejects.toThrow()
      expect(reached).toBe(true)
      expect(view.calls.some((call) => call.method.startsWith("Input."))).toBe(false)
    }
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
    expect(
      view.calls.some((call) => call.params?.contextId === 8 && String(call.params.expression).includes('"fill":true')),
    ).toBe(true)
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
  test("parser reenforces bounds and normalizes only applicable states", () => {
    const page = parseSnapshot({
      result: {
        value: {
          generation: "document-one",
          url: "http://localhost/" + "x".repeat(70000),
          title: "t".repeat(1000),
          visibleText: "x".repeat(20000),
          elements: Array.from({ length: 250 }, () => ({
            ...element(),
            token: "node-one",
            role: "checkbox",
            label: "x".repeat(1000),
            checked: "mixed",
            selected: "true",
            expanded: false,
            disabled: true,
          })),
        },
      },
    })
    expect(page?.elements).toHaveLength(200)
    expect(page?.elements[0]).toMatchObject({ checked: "mixed", expanded: false, disabled: true })
    expect(page?.elements[0]).not.toHaveProperty("selected", "true")
    expect(page?.elements[0].label).toHaveLength(160)
    expect(page?.visibleText).toHaveLength(12000)
    expect(page?.title).toHaveLength(256)
    expect(page?.url).toHaveLength(70017)
    expect(page).toMatchObject({ truncated: true })
  })

  test("missing generation and evaluation exceptions cannot create actionable snapshots", () => {
    for (const response of [
      { result: { value: { elements: [element()] } } },
      { exceptionDetails: {}, result: { value: { generation: "one", elements: [element()] } } },
    ])
      expect(parseSnapshot(response)).toBeUndefined()
    expect(snapshotScript('"; throw Error("injected")')).toContain(JSON.stringify('"; throw Error("injected")'))
  })

  test("drops malformed elements", () => {
    const state = parseSnapshot({
      result: {
        value: {
          url: "http://localhost/",
          title: "t",
          visibleText: "hello",
          generation: "document-one",
          elements: [element(), null],
        },
      },
    })
    expect(state?.elements).toHaveLength(1)
    expect(state?.visibleText).toBe("hello")
  })
})
