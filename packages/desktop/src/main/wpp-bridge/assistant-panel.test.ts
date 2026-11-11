import { expect, test } from "bun:test"
import vm from "node:vm"
import {
  assistantFrame,
  assistantPanelStateExpression,
  clickAssistantControlExpression,
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
  for (const url of [
    builder.url,
    "invalid",
    "https://open-web-assistant-cs.wpp.ai.evil.test/chat/project/ai-assistant",
    "https://open-web-assistant-cs.wpp.ai/chat/project/other",
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
      images: [],
      querySelector: () => control,
      querySelectorAll: (selector: string) => (selector.includes("aria-busy") && busy ? [control] : []),
    },
    getComputedStyle: () => ({ display: "block", visibility: "visible" }),
  })
  expect(vm.runInContext(projectPageStateExpression(true), context).ready).toBe(false)
  loaded = true
  expect(vm.runInContext(projectPageStateExpression(true), context).ready).toBe(true)
  busy = true
  expect(vm.runInContext(projectPageStateExpression(true), context).ready).toBe(false)
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
      querySelector: (selector: string) =>
        selector === "[data-testid='assistant-popover-button-new']" ? hiddenFirst : null,
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

test("falls back to DOM shadow-button click when obscured and avoids 3s re-click toggle while loading", async () => {
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
  const context = vm.createContext({
    URL,
    document: {
      readyState: "complete",
      querySelector: (selector: string) =>
        selector === "[data-testid='assistant-popover-button-new']" ? hostControl : null,
      querySelectorAll: (selector: string) =>
        selector.includes("assistant-popover-button")
          ? [hostControl]
          : selector.includes("open-web-assistant-cs.wpp.ai") && time >= 11000
            ? [{ src: "https://open-web-assistant-cs.wpp.ai/chat/project/ai-assistant" }]
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
  expect(vm.runInContext(clickAssistantControlExpression(), context)).toBe(true)
  expect(shadowClicks).toBe(2)
})
