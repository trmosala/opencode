import { expect, test } from "bun:test"
import vm from "node:vm"
import {
  assistantFrame,
  assistantPanelStateExpression,
  clickAssistantControlExpression,
  freshChatInShellExpression,
  prepareAssistantChat,
  isAssistantChatUrl,
  openAssistantPanel,
  projectPageStateExpression,
} from "./assistant-panel"

test("New Chat waits for a replacement panel and consecutive ready observations", async () => {
  let time = 0
  let resets = 0
  const original = {
    url: "https://open-web-assistant-cs.wpp.ai/chat/project/ai-assistant",
    executeJavaScript: async () => true,
  }
  const replacement = { ...original, url: "https://open-web-assistant-cs.wpp.ai/chat/project/foundational" }
  const contents = {
    mainFrame: { framesInSubtree: [original] },
    executeJavaScript: async () => {
      resets += 1
      contents.mainFrame.framesInSubtree = []
      return { ok: true, clicked: true }
    },
  }
  const observed: number[] = []
  await prepareAssistantChat(
    contents,
    async () => {
      observed.push(time)
      return { ready: time >= 1000 && time !== 1250 }
    },
    {
      now: () => time,
      sleep: async (ms) => {
        time += ms
        if (time >= 500) contents.mainFrame.framesInSubtree = [replacement]
      },
      timeoutMs: 2000,
    },
  )
  expect(resets).toBe(1)
  expect(time).toBe(1750)
  expect(observed).toEqual([500, 750, 1000, 1250, 1500, 1750])
  expect(assistantFrame(contents)).toBe(replacement)
})

test("routes only the Assistant panel, excluding contributor chats, editors and duplicate panels", () => {
  const frame = {
    url: "https://open-web-assistant-cs.wpp.ai/chat/project/ai-assistant",
    executeJavaScript: async () => true,
  }
  const builder = { ...frame, url: "https://open-web-agent-builder-cs.wpp.ai/chat/project/foundational" }
  expect(assistantFrame({ mainFrame: { framesInSubtree: [builder, frame] } })).toBe(frame)
  expect(isAssistantChatUrl("https://open-web-assistant-cs.wpp.ai/chat/project/foundational")).toBe(true)
  for (const url of [
    builder.url,
    "invalid",
    "https://open-web-assistant-cs.wpp.ai.evil.test/chat/project/ai-assistant",
    "https://open-web-assistant-cs.wpp.ai/chat/project/other",
    "https://open-web-assistant-cs.wpp.ai/chat/project",
  ]) {
    expect(isAssistantChatUrl(url)).toBe(false)
  }
  expect(() => assistantFrame({ mainFrame: { framesInSubtree: [frame, { ...frame }] } })).toThrow(
    "o1_code_thread_desync",
  )
})

test("a settled Viewer page needs Assistant access, not agent-card menu buttons", () => {
  let loaded = false
  let busy = false
  const control = {
    getBoundingClientRect: () => ({ width: 100, height: 40 }),
    matches: () => false,
    closest: () => null,
  }
  const context = vm.createContext({
    document: {
      get readyState() {
        return loaded ? "complete" : "interactive"
      },
      images: [{ complete: false }],
      querySelectorAll: (selector: string) => {
        if (selector.includes("aria-busy")) return busy ? [control] : []
        return selector === "[data-testid='assistant-popover-button-new']" ? [control] : []
      },
    },
    getComputedStyle: () => ({ display: "block", visibility: "visible" }),
  })
  expect(vm.runInContext(projectPageStateExpression(true), context).ready).toBe(false)
  loaded = true
  // Incomplete images and leftover spinners must not block once the assistant control is ready.
  expect(vm.runInContext(projectPageStateExpression(true), context).ready).toBe(true)
  busy = true
  expect(vm.runInContext(projectPageStateExpression(true), context).ready).toBe(true)
})

test("opens the panel once and waits for its iframe without clicking agent cards", async () => {
  let time = 0
  let opened = false
  const events: string[] = []
  await openAssistantPanel(
    {
      executeJavaScript: async () => (opened ? { open: true } : { open: false, click: true, x: 400, y: 100 }),
      sendInputEvent: (event) => events.push(event.type),
    },
    {
      now: () => time,
      sleep: async (ms) => {
        time += ms
        opened = time >= 1000
      },
    },
  )
  expect(events).toEqual(["mouseMove", "mouseDown", "mouseUp"])
  expect(time).toBe(1000)
})

test("bounds a stuck panel observation and aborts before an input event", async () => {
  await expect(
    openAssistantPanel(
      {
        executeJavaScript: () => new Promise(() => {}),
        sendInputEvent: () => {
          throw new Error("must not click")
        },
      },
      { timeoutMs: 10 },
    ),
  ).rejects.toMatchObject({ type: "o1_code_assistant_popover_timeout" })
  const signal = AbortSignal.abort()
  await expect(
    openAssistantPanel(
      {
        executeJavaScript: async () => {
          throw new Error("must not observe")
        },
        sendInputEvent: () => {
          throw new Error("must not click")
        },
      },
      { signal },
    ),
  ).rejects.toMatchObject({ type: "o1_code_client_aborted" })
})

test("selects the visible unobscured Assistant control when duplicate header items exist", () => {
  const hiddenFirst = {
    getBoundingClientRect: () => ({ left: 0, top: 0, width: 0, height: 0 }),
    getAttribute: () => null,
    matches: () => false,
    closest: () => null,
    contains: () => false,
  }
  const activeSecond = {
    getBoundingClientRect: () => ({ left: 800, top: 20, width: 40, height: 40 }),
    getAttribute: () => null,
    matches: () => false,
    closest: () => null,
    contains: () => false,
  }
  const context = vm.createContext({
    URL,
    document: {
      readyState: "complete",
      querySelectorAll: (selector: string) =>
        selector.includes("assistant-popover-button") ? [hiddenFirst, activeSecond] : [],
      elementFromPoint: (x: number, y: number) => (x === 820 && y === 40 ? activeSecond : null),
    },
    getComputedStyle: (el: unknown) => ({
      display: el === hiddenFirst ? "none" : "block",
      visibility: "visible",
    }),
  })
  const state = vm.runInContext(assistantPanelStateExpression(), context)
  expect(state).toMatchObject({
    open: false,
    click: true,
    domClick: false,
    buttonFound: true,
    unobscured: true,
    x: 820,
    y: 40,
  })
})

test("falls back to a DOM click on the shadow button when the native target is obscured", async () => {
  let time = 0
  let shadowClicks = 0
  const innerButton = {
    click: () => {
      shadowClicks += 1
    },
    matches: () => false,
    getAttribute: () => null,
  }
  const hostControl = {
    shadowRoot: {
      querySelector: () => innerButton,
      contains: () => false,
    },
    getBoundingClientRect: () => ({ left: 500, top: 10, width: 40, height: 40 }),
    getAttribute: () => null,
    matches: () => false,
    closest: () => null,
    contains: () => false,
  }
  const frame = {
    src: "https://open-web-assistant-cs.wpp.ai/chat/project/ai-assistant",
    getBoundingClientRect: () => ({ width: 400, height: 600 }),
  }
  const context = vm.createContext({
    URL,
    document: {
      readyState: "complete",
      querySelectorAll: (selector: string) =>
        selector.includes("assistant-popover-button")
          ? [hostControl]
          : selector.includes("open-web-assistant-cs.wpp.ai") && time >= 11000
            ? [frame]
            : [],
      elementFromPoint: () => ({}),
    },
    getComputedStyle: () => ({ display: "block", visibility: "visible" }),
  })
  const events: string[] = []
  await openAssistantPanel(
    {
      executeJavaScript: async (code: string) => vm.runInContext(code, context),
      sendInputEvent: (event) => events.push(event.type),
    },
    {
      now: () => time,
      sleep: async (ms) => {
        time += ms
      },
    },
  )
  expect(events).toEqual([])
  expect(shadowClicks).toBe(1)
  expect(time).toBe(11000)
})

test("prefers the WPP button over an earlier aria-labelled control and clicks that same button", () => {
  const clicks: string[] = []
  const control = (name: string, left: number) => ({
    click: () => clicks.push(name),
    getBoundingClientRect: () => ({ left, top: 10, width: 40, height: 40 }),
    getAttribute: () => null,
    matches: () => false,
    closest: () => null,
    contains: () => false,
  })
  const labelled = control("labelled", 100)
  const real = control("real", 500)
  const context = vm.createContext({
    URL,
    document: {
      readyState: "complete",
      // The labelled control comes first in document order; selector priority must still pick the real button.
      querySelectorAll: (selector: string) =>
        selector.includes("aria-label='AI Assistant'")
          ? [labelled]
          : selector.includes("assistant-popover-button")
            ? [real]
            : [],
      elementFromPoint: (x: number) => (x === 120 ? labelled : x === 520 ? real : null),
    },
    getComputedStyle: () => ({ display: "block", visibility: "visible" }),
  })
  expect(vm.runInContext(assistantPanelStateExpression(), context)).toMatchObject({ click: true, x: 520, y: 30 })
  expect(vm.runInContext(clickAssistantControlExpression(), context)).toMatchObject({ clicked: true })
  expect(clicks).toEqual(["real"])
})

test("does not click again while a slow popover is expanded but its frame has not mounted", async () => {
  let time = 0
  let clicks = 0
  const button = {
    click: () => {
      clicks += 1
    },
    getBoundingClientRect: () => ({ left: 500, top: 10, width: 40, height: 40 }),
    getAttribute: (name: string) => (name === "aria-expanded" && clicks > 0 ? "true" : null),
    matches: () => false,
    closest: () => null,
    contains: () => false,
  }
  const frame = {
    src: "https://open-web-assistant-cs.wpp.ai/chat/project/ai-assistant",
    getBoundingClientRect: () => ({ width: 400, height: 600 }),
  }
  const context = vm.createContext({
    URL,
    document: {
      readyState: "complete",
      querySelectorAll: (selector: string) =>
        selector.includes("open-web-assistant-cs.wpp.ai")
          ? time >= 60000
            ? [frame]
            : []
          : selector.includes("assistant-popover-button")
            ? [button]
            : [],
      // Obscured, so the DOM click path runs and clicks land on the button itself.
      elementFromPoint: () => null,
    },
    getComputedStyle: () => ({ display: "block", visibility: "visible" }),
  })
  await openAssistantPanel(
    {
      executeJavaScript: async (code: string) => vm.runInContext(code, context),
      sendInputEvent: () => {
        throw new Error("must not send native input")
      },
    },
    {
      now: () => time,
      sleep: async (ms) => {
        time += ms
      },
    },
  )
  expect(clicks).toBe(1)
  expect(time).toBe(60000)
})

test("trusts the frame tree only when it can be read and no hidden assistant iframe is mounted", async () => {
  let time = 0
  let detached = true
  const chat = { url: "https://open-web-assistant-cs.wpp.ai/chat/project/ai-assistant" }
  const mainFrame = {
    get framesInSubtree() {
      if (detached) throw new Error("Render frame was disposed before WebFrameMain could be accessed")
      return [chat]
    },
  }
  await openAssistantPanel(
    { mainFrame, executeJavaScript: async () => ({ open: false }), sendInputEvent: () => {} },
    {
      now: () => time,
      sleep: async (ms) => {
        time += ms
        detached = time < 500
      },
    },
  )
  expect(time).toBe(500)
  await expect(
    openAssistantPanel(
      {
        mainFrame: { framesInSubtree: [chat] },
        executeJavaScript: async () => ({ open: false, iframePresent: true }),
        sendInputEvent: () => {},
      },
      {
        now: () => time,
        sleep: async (ms) => {
          time += ms
        },
        timeoutMs: 1000,
      },
    ),
  ).rejects.toMatchObject({ type: "o1_code_assistant_popover_timeout", diagnostics: { iframePresent: true } })
})

test("fails fast when the Assistant button never mounts on a settled page and attaches panelState", async () => {
  let time = 0
  const absent = { open: false, buttonFound: false, iframePresent: false, ready: true }
  const error = await openAssistantPanel(
    {
      executeJavaScript: async () => absent,
      sendInputEvent: () => {
        throw new Error("must not click")
      },
    },
    {
      now: () => time,
      sleep: async (ms) => {
        time += ms
      },
      timeoutMs: 60000,
      absentControlMs: 1000,
    },
  ).catch((caught) => caught)
  expect(error).toMatchObject({
    type: "o1_code_assistant_popover_timeout",
    panelState: absent,
    diagnostics: { buttonFound: false, iframePresent: false },
  })
  expect(time).toBe(1000)
})

test("keeps the full deadline while the button is present, the page is loading or a frame is mounting", async () => {
  for (const state of [
    { open: false, buttonFound: true, ready: true },
    { open: false, buttonFound: false, ready: false },
    { open: false, buttonFound: false, iframePresent: true, ready: true },
  ]) {
    let time = 0
    await expect(
      openAssistantPanel(
        {
          executeJavaScript: async () => state,
          sendInputEvent: () => {
            throw new Error("must not click")
          },
        },
        {
          now: () => time,
          sleep: async (ms) => {
            time += ms
          },
          timeoutMs: 2000,
          absentControlMs: 500,
        },
      ),
    ).rejects.toMatchObject({ type: "o1_code_assistant_popover_timeout" })
    expect(time).toBe(2000)
  }
})

test("New Chat clicks whatever wpp-action-button version hosts the more icon", async () => {
  let opened = false
  const item = {
    textContent: "New Chat",
    getAttribute: () => null,
    getBoundingClientRect: () => ({ width: 80, height: 24, top: 40, bottom: 64, left: 10, right: 90 }),
    click() {},
  }
  const button = {
    getBoundingClientRect: () => ({ width: 28, height: 28, top: 4, bottom: 32, left: 12, right: 40 }),
    click() {
      opened = true
    },
  }
  const host = {
    tagName: "WPP-ACTION-BUTTON-V4-9-0",
    parentElement: null,
    shadowRoot: { querySelector: (selector: string) => (selector === "button" ? button : null) },
  }
  const frame = {
    getBoundingClientRect: () => ({ width: 320, height: 400, top: 36, bottom: 436, left: 0, right: 320 }),
  }
  const result = await vm.runInContext(
    freshChatInShellExpression(),
    vm.createContext({
      document: {
        querySelector: (selector: string) => (selector.includes("iframe") ? frame : null),
        querySelectorAll: (selector: string) => {
          if (selector === "[data-testid='wpp-icon-more']") return [{ tagName: "SPAN", parentElement: host }]
          if (selector === "[role='menuitem']") return opened ? [item] : []
          return []
        },
      },
      getComputedStyle: () => ({ visibility: "visible", display: "block" }),
      setTimeout,
      clearTimeout,
    }),
  )
  expect(result).toEqual({ ok: true, clicked: true })
})
