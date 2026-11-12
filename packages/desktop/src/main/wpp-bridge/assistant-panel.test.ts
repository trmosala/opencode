import { expect, test } from "bun:test"
import vm from "node:vm"
import {
  assistantFrame,
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
  expect(isAssistantChatUrl("https://open-web-assistant-cs.wpp.ai/chat/project/other")).toBe(true)
  for (const url of [
    builder.url,
    "invalid",
    "https://open-web-assistant-cs.wpp.ai.evil.test/chat/project/ai-assistant",
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
      querySelector: () => control,
      querySelectorAll: (selector: string) => (selector.includes("aria-busy") && busy ? [control] : []),
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

test("JS-clicks the popover control when hit-testing misses an overlay", async () => {
  let time = 0
  let opened = false
  const scripts: string[] = []
  await openAssistantPanel(
    {
      executeJavaScript: async (code) => {
        scripts.push(code)
        if (code.includes("assistant-popover-button-new") && code.includes(".click()")) {
          opened = true
          return true
        }
        return opened ? { open: true } : { open: false, click: false, jsClick: true }
      },
      sendInputEvent: () => {
        throw new Error("must not native-click")
      },
    },
    {
      now: () => time,
      sleep: async (ms) => {
        time += ms
      },
    },
  )
  expect(scripts.some((code) => code.includes(".click()"))).toBe(true)
  expect(time).toBe(250)
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
