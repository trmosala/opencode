import { describe, expect, test } from "bun:test"
import { MAX_SNAPSHOT_BYTES } from "@cookiemonster/cm-browser/protocol"
import { execute, shouldShowBrowserContextMenu, screenshotDecoder, type DriverContents, type Target } from "./driver"
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
    mainFrame: { detached: false },
    get focusedFrame() {
      return this.mainFrame
    },
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
        if (method === "DOM.getNodeForLocation") return { frameId: "main", backendNodeId: 1 }
        if (method === "DOM.describeNode") return { node: { nodeName: "BUTTON" } }
        if (method === "Page.createIsolatedWorld")
          return { executionContextId: params?.worldName === "cm-browser-wait" ? 7 : 8 }
        if (method !== "Runtime.evaluate") return {}
        if (params?.contextId !== 8) return { result: { value: undefined } }
        expect(params.timeout).toBeGreaterThan(0)
        const references = [...String(params.expression).matchAll(/reference = (\{[^\n]+\}|null);/g)].flatMap(
          (match) => (match[1] === "null" ? [] : [JSON.parse(match[1]) as { token: string }]),
        )
        const current = references.length
          ? references.flatMap((ref) => elements.filter((element) => element.token === ref.token))
          : elements
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
  test("screenshot bounds preflight and decoded raster, rejects malformed capture, never retries or reads DOM", async () => {
    const decoder = screenshotDecoder.size
    try {
      for (const reason of [
        "success",
        "edge",
        "pixels",
        "empty",
        "base64",
        "jpeg",
        "decode",
        "raster",
        "bytes",
        "url",
      ]) {
        const view = fake({ url: reason === "url" ? "http://localhost/" + "x".repeat(65536) : undefined })
        let captures = 0
        screenshotDecoder.size = async () =>
          reason === "decode" ? undefined : { width: reason === "raster" ? 4097 : 1, height: 1 }
        view.target.contents.debugger.sendCommand = async (method, params) => {
          if (method === "Page.getLayoutMetrics")
            return {
              visualViewport: {
                clientWidth: reason === "edge" ? 4097 : reason === "pixels" ? 4096 : 1,
                clientHeight: reason === "pixels" ? 1025 : 1,
              },
            }
          expect(method).toBe("Page.captureScreenshot")
          expect(params).toEqual({ format: "jpeg", quality: 60, fromSurface: true, captureBeyondViewport: false })
          captures++
          return {
            data:
              reason === "empty"
                ? ""
                : reason === "base64"
                  ? "bad!"
                  : reason === "jpeg"
                    ? "YWJjZA=="
                    : reason === "bytes"
                      ? "a".repeat(61444)
                      : "/9j/2Q==",
          }
        }
        const response = await execute(view.target, { op: "screenshot", tabID: "one" })
        expect(response.ok).toBe(reason === "success")
        expect(captures).toBe(reason === "edge" || reason === "pixels" ? 0 : 1)
        if (response.ok)
          expect(response.result).toMatchObject({
            title: "",
            visibleText: "",
            elements: [],
            screenshot: { width: 1, height: 1, data: "/9j/2Q==" },
          })
      }
    } finally {
      screenshotDecoder.size = decoder
    }
  })

  test("drag jointly validates endpoints, sends four fixed moves and releases once", async () => {
    const view = fake()
    view.setElements([element(), { ...element("drop"), rect: { x: 210, y: 20, width: 40, height: 10 } }])
    const sourceRef = await firstRef(view)
    const targetRef = sourceRef.replace(":send", ":drop")
    view.calls.length = 0
    expect(await execute(view.target, { op: "drag", tabID: "one", sourceRef, targetRef })).toMatchObject({ ok: true })
    const input = view.calls.filter((call) => call.method.startsWith("Input."))
    expect(input.map((call) => call.params?.type)).toEqual([
      "mouseMoved",
      "mousePressed",
      "mouseMoved",
      "mouseMoved",
      "mouseMoved",
      "mouseMoved",
      "mouseReleased",
    ])
    expect(input.map((call) => [call.params?.x, call.params?.y, call.params?.buttons])).toEqual([
      [30, 25, 0],
      [30, 25, 1],
      [80, 25, 1],
      [130, 25, 1],
      [180, 25, 1],
      [230, 25, 1],
      [230, 25, 0],
    ])
    const hover = view.calls.indexOf(input[0]),
      down = view.calls.indexOf(input[1])
    for (const calls of [view.calls.slice(0, hover), view.calls.slice(hover + 1, down)]) {
      const evaluations = calls.filter((call) => call.params?.contextId === 8)
      expect(evaluations).toHaveLength(1)
      expect(String(evaluations[0].params?.expression)).toContain('"token":"send"')
      expect(String(evaluations[0].params?.expression)).toContain('"token":"drop"')
      expect(evaluations[0].params?.awaitPromise).not.toBe(true)
    }
  })

  test("drag rejects same endpoint, cross-tab, cross-snapshot and stale pairs without input", async () => {
    for (const kind of ["same", "tab", "snapshot", "source", "target"] as const) {
      const view = fake()
      view.setElements([element(), element("drop")])
      const sourceRef = await firstRef(view)
      let targetRef = sourceRef.replace(":send", ":drop")
      if (kind === "same") targetRef = sourceRef
      if (kind === "tab") targetRef = "other." + targetRef
      if (kind === "snapshot") targetRef = (await firstRef(view)).replace(":send", ":drop")
      if (kind === "source") view.setElements([element("replacement"), element("drop")])
      if (kind === "target") view.setElements([element(), element("replacement")])
      expect(await execute(view.target, { op: "drag", tabID: "one", sourceRef, targetRef })).toMatchObject({
        code: "stale_ref",
      })
      expect(view.calls.some((call) => call.method.startsWith("Input."))).toBe(false)
    }
  })

  test("drag never chases post-hover endpoints or releases a stale held destination", async () => {
    for (const boundary of [0, 1, 2, 3, 4]) {
      for (const mutation of ["replace", "move", "disabled"] as const) {
        const view = fake()
        const destination = { ...element("drop"), rect: { x: 210, y: 20, width: 40, height: 10 } }
        view.setElements([element(), destination])
        const sourceRef = await firstRef(view),
          targetRef = sourceRef.replace(":send", ":drop")
        const send = view.target.contents.debugger.sendCommand.bind(view.target.contents.debugger)
        let moves = -1
        view.target.contents.debugger.sendCommand = async (method, params) => {
          const value = await send(method, params)
          if (params?.type === "mouseMoved" && ++moves === boundary)
            view.setElements([
              element(),
              mutation === "replace"
                ? element("replacement")
                : mutation === "move"
                  ? { ...destination, rect: { ...destination.rect, x: 211 } }
                  : { ...destination, disabled: true },
            ])
          return value
        }
        expect(await execute(view.target, { op: "drag", tabID: "one", sourceRef, targetRef })).toMatchObject({
          code: "stale_ref",
        })
        const input = view.calls.filter((call) => call.method.startsWith("Input."))
        expect(input.some((call) => call.params?.type === "mouseReleased")).toBe(false)
        expect(input.filter((call) => call.params?.type === "mousePressed")).toHaveLength(boundary ? 1 : 0)
        expect((await execute(view.target, { op: "read_state", tabID: "one" })).ok).toBe(boundary === 0)
      }
    }
  })

  test("drag allows source movement after press but rejects it before press", async () => {
    for (const afterDown of [false, true]) {
      const view = fake()
      const destination = { ...element("drop"), rect: { x: 210, y: 20, width: 40, height: 10 } }
      view.setElements([element(), destination])
      const sourceRef = await firstRef(view),
        targetRef = sourceRef.replace(":send", ":drop")
      const send = view.target.contents.debugger.sendCommand.bind(view.target.contents.debugger)
      view.target.contents.debugger.sendCommand = async (method, params) => {
        const value = await send(method, params)
        if (params?.type === (afterDown ? "mousePressed" : "mouseMoved"))
          view.setElements([{ ...element(), rect: { ...element().rect, x: 11 } }, destination])
        return value
      }
      expect((await execute(view.target, { op: "drag", tabID: "one", sourceRef, targetRef })).ok).toBe(afterDown)
      expect(view.calls.filter((call) => call.params?.type === "mousePressed")).toHaveLength(afterDown ? 1 : 0)
    }
  })

  test("select uses one isolated mutation, respects final capture deadline and never retries failures", async () => {
    for (const failure of ["none", "ack", "snapshot", "deadline"] as const) {
      const view = fake()
      const send = view.target.contents.debugger.sendCommand.bind(view.target.contents.debugger)
      let mutations = 0
      const target = { ...view.target, deadline: Date.now() + 2000 }
      view.target.contents.debugger.sendCommand = async (method, params) => {
        const response = await send(method, params)
        if (String(params?.expression).includes("const validated =")) {
          mutations++
          if (failure === "ack") throw new Error("Missing acknowledgement")
          return { result: { value: true } }
        }
        if (params?.contextId !== 8) return response
        if (mutations && failure === "deadline") {
          target.deadline = Date.now() - 1
          return {}
        }
        if (mutations && failure === "snapshot") return {}
        return {
          result: {
            value: {
              generation: "one",
              url: view.target.contents.getURL(),
              title: "",
              elements: [
                {
                  ...element("select"),
                  tag: "select",
                  options: [{ token: "option", label: "Same", selected: false, disabled: false }],
                },
              ],
            },
          },
        }
      }
      const state = await execute(view.target, { op: "read_state", tabID: "one" })
      if (!state.ok) throw new Error("No select snapshot")
      const select = state.result.elements[0]
      const pending = execute(
        {
          ...target,
          check: () => {
            if (Date.now() >= target.deadline) throw new Error("deadline")
          },
        },
        { op: "select_option", tabID: "one", ref: select.ref, optionRef: select.options![0].ref },
      )
      if (failure === "ack" || failure === "deadline") await expect(pending).rejects.toThrow()
      else expect((await pending).ok).toBe(failure === "none")
      expect(mutations).toBe(1)
      expect(view.calls.some((call) => call.method.startsWith("Input."))).toBe(false)
    }
  })

  test.each(["read_state", "select_option"] as const)("%s preserves isolated setup failures and guards", async (op) => {
    for (const boundary of ["Page.getFrameTree", "Page.createIsolatedWorld"]) {
      for (const outcome of ["invalid", "reject", "cancel"] as const) {
        const view = fake({
          snapshot: {
            result: {
              value: {
                generation: "one",
                url: "http://localhost:5173/",
                elements: [
                  {
                    ...element("select"),
                    tag: "select",
                    options: [{ token: "option", label: "Same", selected: false, disabled: false }],
                  },
                ],
              },
            },
          },
        })
        const ref = await firstRef(view)
        view.calls.length = 0
        const controller = new AbortController()
        const send = view.target.contents.debugger.sendCommand.bind(view.target.contents.debugger)
        view.target.contents.debugger.sendCommand = async (method, params) => {
          const value = await send(method, params)
          if (method !== boundary) return value
          if (outcome === "reject") throw new Error("setup failure")
          if (outcome === "cancel") controller.abort()
          return { executionContextId: 1.5 }
        }
        const pending = execute(
          { ...view.target, signal: controller.signal },
          op === "read_state"
            ? { op, tabID: "one" }
            : { op, tabID: "one", ref, optionRef: ref.replace(":select", ":option") },
        )
        if (outcome !== "invalid") await expect(pending).rejects.toThrow()
        else
          expect(await pending).toEqual({
            ok: false,
            code: "unavailable",
            error:
              op === "read_state"
                ? "The page did not return a usable snapshot."
                : boundary === "Page.getFrameTree"
                  ? "Browser frame unavailable."
                  : "Browser context unavailable.",
          })
        expect(view.calls.at(-1)?.method).toBe(boundary)
        if (boundary === "Page.createIsolatedWorld")
          expect(view.calls.at(-1)?.params).toEqual({ frameId: "main", worldName: "cm-browser-snapshot" })
      }
    }
  })

  test.each(["left", "double", "right", "fill"] as const)(
    "%s revalidates after move without chasing a changed target",
    async (mode) => {
      for (const mutation of ["replace", "move"] as const) {
        const view = fake()
        const ref = await firstRef(view)
        const send = view.target.contents.debugger.sendCommand.bind(view.target.contents.debugger)
        view.target.contents.debugger.sendCommand = async (method, params) => {
          const value = await send(method, params)
          if (params?.type === "mouseMoved")
            view.setElements([
              mutation === "replace" ? element("replacement") : { ...element(), rect: { ...element().rect, x: 11 } },
            ])
          return value
        }
        const response = await execute(
          view.target,
          mode === "fill"
            ? { op: "fill", tabID: "one", ref, text: "never typed" }
            : { op: "click", tabID: "one", ref, mode },
        )
        expect(response).toMatchObject({
          code: "stale_ref",
          error: `Element ref ${ref} is stale. Read browser state again.`,
        })
        expect(view.calls.filter((call) => call.method.startsWith("Input.")).map((call) => call.params?.type)).toEqual([
          "mouseMoved",
        ])
      }
    },
  )

  test("hover sends only one button-free move and refreshes", async () => {
    const view = fake()
    const ref = await firstRef(view)
    const send = view.target.contents.debugger.sendCommand.bind(view.target.contents.debugger)
    view.target.contents.debugger.sendCommand = async (method, params) => {
      expect(shouldShowBrowserContextMenu(view.target.contents)).toBe(true)
      return send(method, params)
    }
    const response = await execute(view.target, { op: "hover", tabID: "one", ref })
    expect(response.ok).toBe(true)
    expect(response.ok && response.result.elements[0].ref).not.toBe(ref)
    expect(view.calls.filter((call) => call.method.startsWith("Input."))).toEqual([
      { method: "Input.dispatchMouseEvent", params: { type: "mouseMoved", x: 30, y: 25, button: "none", buttons: 0 } },
    ])
  })

  test.each(["left", "double", "right"] as const)("%s sends exact native pairs", async (mode) => {
    const view = fake()
    const send = view.target.contents.debugger.sendCommand.bind(view.target.contents.debugger)
    view.target.contents.debugger.sendCommand = async (method, params) => {
      if (method.startsWith("Input.")) expect(shouldShowBrowserContextMenu(view.target.contents)).toBe(mode !== "right")
      return send(method, params)
    }
    expect(await execute(view.target, { op: "click", tabID: "one", ref: await firstRef(view), mode })).toMatchObject({
      ok: true,
    })
    const input = view.calls.filter((call) => call.method.startsWith("Input.")).map((call) => call.params)
    expect(input.map((params) => params?.type)).toEqual(
      mode === "double"
        ? ["mouseMoved", "mousePressed", "mouseReleased", "mousePressed", "mouseReleased"]
        : ["mouseMoved", "mousePressed", "mouseReleased"],
    )
    expect(input.filter((params) => params?.type === "mousePressed")).toMatchObject(
      mode === "double"
        ? [
            { button: "left", buttons: 1, clickCount: 1 },
            { button: "left", buttons: 1, clickCount: 2 },
          ]
        : [{ button: mode, buttons: mode === "right" ? 2 : 1, clickCount: 1 }],
    )
    expect(input.filter((params) => params?.type === "mouseReleased").every((params) => params?.buttons === 0)).toBe(
      true,
    )
  })

  test("double click revalidates the original ref before any second-pair input", async () => {
    const view = fake()
    const ref = await firstRef(view)
    const send = view.target.contents.debugger.sendCommand.bind(view.target.contents.debugger)
    view.target.contents.debugger.sendCommand = async (method, params) => {
      const value = await send(method, params)
      if (params?.type === "mouseReleased") view.setElements([element("replacement")])
      return value
    }
    expect(await execute(view.target, { op: "click", tabID: "one", ref, mode: "double" })).toMatchObject({
      code: "stale_ref",
      error: `Element ref ${ref} is stale. Read browser state again.`,
    })
    expect(view.calls.filter((call) => call.method.startsWith("Input."))).toHaveLength(3)
  })

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
      key === "desktop.browser.driver.staleRef"
        ? "fixture:stale {{ref}}"
        : key.startsWith("desktop.browser.driver.")
          ? `fixture:${key}`
          : DESKTOP_NATIVE_ENGLISH[key],
    )
    setNativeTranslations(messages)
    try {
      for (const boundary of ["initial", "mouseMoved", "mouseReleased"]) {
        const view = fake()
        const ref = await firstRef(view)
        const send = view.target.contents.debugger.sendCommand.bind(view.target.contents.debugger)
        if (boundary === "initial") view.setElements([element("changed")])
        view.target.contents.debugger.sendCommand = async (method, params) => {
          const value = await send(method, params)
          if (params?.type === boundary) view.setElements([element("changed")])
          return value
        }
        expect(await execute(view.target, { op: "click", tabID: "one", ref, mode: "double" })).toMatchObject({
          code: "stale_ref",
          error: `fixture:stale ${ref}`,
        })
      }
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
        { op: "select_option", tabID: "one", ref, optionRef: ref },
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
      4,
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
      error: `Element ref ${ref} is stale. Read browser state again.`,
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
  test("select metadata is field-bounded, select-owned and capped per select and snapshot", () => {
    const page = parseSnapshot({
      result: {
        value: {
          generation: "one",
          elements: Array.from({ length: 6 }, (_, i) => ({
            ...element("select-" + i),
            tag: "select",
            options: Array.from({ length: 80 }, (_, j) => ({
              token: "option-" + i + "-" + j,
              label: "x".repeat(200),
              selected: false,
              disabled: false,
              value: "secret",
            })),
          })),
        },
      },
    })
    expect(page?.elements[0].options).toHaveLength(50)
    expect(page?.elements.flatMap((el) => el.options ?? [])).toHaveLength(200)
    expect(page?.elements[0].options?.[0]).toEqual({
      token: "option-0-0",
      label: "x".repeat(160),
      selected: false,
      disabled: false,
    })
    expect(page?.elements[0].optionsTruncated).toBe(true)
    expect(page?.truncated).toBe(true)
  })

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
