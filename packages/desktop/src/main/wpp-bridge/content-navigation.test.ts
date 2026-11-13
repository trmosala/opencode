import { describe, expect, test } from "bun:test"
import vm from "node:vm"
import { join } from "node:path"

describe("WPP Assistant side-panel navigation", () => {
  test("verifies an icon-only picker from its current-agent row and rejects a different agent", async () => {
    const h = await harness()
    h.state.iconOnly = true
    h.state.modeLabel = "CM_Astra"
    expect(h.hooks.requireAgentSelected("CM_Astra")).toEqual({ ok: true, label: "CM_Astra" })
    h.state.modeLabel = "CM_Other"
    expect(() => h.hooks.requireAgentSelected("CM_Astra")).toThrow("o1_code_wrong_agent")
  })
  test("retypes a replaced composer and dispatches exactly once on fresh controls", async () => {
    const h = await harness()
    h.state.users = []
    const oldInput = h.state.composer
    const replacement = { ...oldInput, value: "", isConnected: true }
    const send = element("Send")
    h.state.buttons = [send]
    h.state.onTick = () => {
      if (h.state.time >= 500) {
        oldInput.isConnected = false
        h.state.composer = replacement
      }
    }
    let admittedInput
    await h.hooks.submitPrompt(oldInput, "offline exact input", 3000, (input: unknown) => {
      admittedInput = input
    })
    expect(admittedInput).toBe(replacement)
    expect(replacement.value).toBe("offline exact input")
    expect(send.clicks).toBe(1)
  })

  test("fails closed without a labelled Send rather than dispatching through an unrelated icon", async () => {
    const h = await harness()
    h.state.users = []
    const unrelated = { ...element(""), querySelector: () => ({}) }
    h.state.buttons = [unrelated]
    await expect(h.hooks.submitPrompt(h.state.composer, "offline input", 2000)).rejects.toMatchObject({
      type: "o1_code_submission_unverified",
    })
    expect(unrelated.clicks).toBe(0)
  })
  test("uses the fresh connected Send control after greeting settlement", async () => {
    const h = await harness()
    h.state.users = []
    const oldSend = element("Send")
    const freshSend = element("Send")
    h.state.buttons = [oldSend]
    h.state.onTick = () => {
      if (h.state.time >= 500) {
        oldSend.isConnected = false
        h.state.buttons = [freshSend]
      }
    }
    await h.hooks.submitPrompt(h.state.composer, "offline test input", 2000)
    expect(oldSend.clicks).toBe(0)
    expect(freshSend.clicks).toBe(1)
  })

  test("does not reset a dedicated chat whose selected agent differs from the requested agent", async () => {
    const h = await harness("agent")
    h.state.agent = "CM_Other"
    await expect(h.hooks.startFreshChat({ expectedAgent: "CM_Astra" })).rejects.toMatchObject({
      type: "o1_code_wrong_agent",
    })
    expect(h.trigger.clicks).toBe(0)
    expect(h.item.clicks).toBe(0)
  })

  test("accepts verified history clearing when the connected composer is reused", async () => {
    const h = await harness()
    const before = h.state.composer
    h.state.reuseComposer = true
    expect(await h.hooks.startFreshChat({ timeoutMs: 2000 })).toEqual({ ok: true, clicked: true })
    expect(h.state.composer).toBe(before)
    expect(h.state.users).toEqual([])
    expect(h.state.time).toBeGreaterThanOrEqual(1000)
  })

  test.each(["assistant", "agent"] as const)(
    "accepts a proven %s reset with no greeting and reacquires the composer",
    async (mode) => {
      const h = await harness(mode)
      const before = h.state.composer
      expect(await h.hooks.startFreshChat()).toEqual({ ok: true, clicked: true })
      expect(h.state.composer).not.toBe(before)
      expect(h.state.users).toEqual([])
      expect(h.state.assistants).toEqual([])
      expect(h.trigger.clicks).toBe(1)
      expect(h.item.clicks).toBe(1)
      expect(h.state.time).toBeGreaterThanOrEqual(1000)
      expect(h.hooks.requireAgentSelected("CM_Astra")).toEqual({ ok: true, label: "CM_Astra" })
    },
  )

  test("waits for a new greeting body to finish before accepting reset", async () => {
    const h = await harness()
    h.state.greeting = true
    h.state.onTick = () => {
      if (h.state.time === 1500) {
        h.state.pending = 0
        h.state.changedAt = h.state.time
      }
    }
    await h.hooks.startFreshChat()
    expect(h.state.time).toBeGreaterThanOrEqual(2500)
    expect(h.state.assistants).toHaveLength(1)
  })

  test("accepts a settled reset when React reuses the greeting node", async () => {
    const h = await harness()
    const before = h.state.composer
    const greeting = h.state.assistants[0]
    h.state.reuseGreeting = true
    h.state.greeting = true
    h.state.onTick = () => {
      if (h.state.time === 1500) {
        h.state.pending = 0
        h.state.changedAt = h.state.time
      }
    }
    expect(await h.hooks.startFreshChat({ timeoutMs: 3000 })).toEqual({ ok: true, clicked: true })
    expect(h.state.composer).not.toBe(before)
    expect(h.state.users).toEqual([])
    expect(h.state.assistants).toEqual([greeting])
    expect(h.state.time).toBeGreaterThanOrEqual(2500)
  })

  test.each(["pending", "failure"])("fails closed on greeting %s", async (mode) => {
    const h = await harness()
    h.state.greeting = true
    if (mode === "failure") h.state.failure = "HTTP 500"
    await expect(h.hooks.startFreshChat({ timeoutMs: 2000 })).rejects.toMatchObject({
      type: "o1_code_greeting_not_settled",
    })
  })

  test("does not treat clicking the menu as proof of reset", async () => {
    const h = await harness()
    h.state.reset = false
    await expect(h.hooks.startFreshChat({ timeoutMs: 2000 })).rejects.toMatchObject({
      type: "o1_code_fresh_chat_failed",
    })
  })

  test("rejects missing exact controls even when generic New Chat text exists", async () => {
    const h = await harness()
    h.state.trigger = false
    await expect(h.hooks.startFreshChat()).rejects.toMatchObject({ type: "o1_code_fresh_chat_failed" })
    expect(h.item.clicks).toBe(0)
  })

  test.each(["assistant", "agent"] as const)(
    "%s continuation preserves populated history without clicking New Chat",
    async (mode) => {
      const h = await harness(mode)
      expect(await h.hooks.continueExistingChat()).toMatchObject({ reason: "continue-thread", clicked: false })
      expect(h.trigger.clicks).toBe(0)
      expect(h.state.users).toHaveLength(1)
      h.state.users = []
      await expect(h.hooks.continueExistingChat()).rejects.toMatchObject({ type: "o1_code_thread_desync" })
    },
  )

  test("revalidates exact locked agent and does not accept similar names", async () => {
    const h = await harness()
    expect(() => h.hooks.requireAgentSelected("CM_Astra_XHigh")).toThrow("o1_code_wrong_agent")
    h.state.agent = "CM_Astra_XHigh"
    expect(() => h.hooks.requireAgentSelected("CM_Astra")).toThrow("o1_code_wrong_agent")
  })

  test("keeps waiting while a greeting streams into an existing bubble", async () => {
    const h = await harness()
    h.state.users = []
    const greeting = element("Hel")
    h.state.assistants = [greeting]
    h.state.onTick = () => {
      if (h.state.time <= 1500) greeting.textContent += "l"
    }
    await h.hooks.waitForGreetingSettlement(h.state.composer, { timeoutMs: 5000 })
    expect(h.state.time).toBeGreaterThanOrEqual(2500)
  })

  test("arm rejects pending work introduced after settlement", async () => {
    const h = await harness()
    await h.hooks.startFreshChat()
    h.state.pending = 1
    expect(() => h.hooks.beginNetworkCapture()).toThrow("o1_code_greeting_not_settled")
    expect(h.state.armed).toBe(false)
  })
})

async function harness(mode: "assistant" | "agent" = "assistant") {
  const state = {
    time: 0,
    menu: false,
    trigger: true,
    reset: true,
    greeting: false,
    reuseGreeting: false,
    reuseComposer: false,
    pending: 0,
    failure: null as string | null,
    changedAt: 0,
    agent: "CM_Astra",
    iconOnly: false,
    modeLabel: "",
    armed: false,
    users: [element("old prompt")],
    assistants: [element("old answer")],
    buttons: [] as ReturnType<typeof element>[],
    composer: element(""),
    onTick: () => {},
  }
  const root = {
    get textContent() {
      return [...state.users, ...state.assistants].map((node) => node.textContent).join("\n")
    },
    contains: (node: unknown) => [...state.users, ...state.assistants].some((existing) => existing === node),
    querySelectorAll(selector: string) {
      if (selector.includes("chat-message--user")) return state.users
      if (selector.includes("chat-message--assistant")) return state.assistants
      if (selector === "button, [role='button']") return state.buttons
      return []
    },
  }
  const composer = () => ({ ...element(""), value: "", isConnected: true, closest: () => root })
  state.composer = composer()
  const trigger = element("")
  const item = element("")
  trigger.onClick = () => {
    state.menu = true
  }
  item.onClick = () => {
    if (!state.reset) return
    if (!state.reuseComposer) state.composer = composer()
    state.users = []
    state.assistants = state.reuseGreeting ? state.assistants : state.greeting ? [element("Hello")] : []
    state.pending = state.greeting ? 1 : 0
    state.menu = false
  }
  const document = {
    querySelector: () => root,
    querySelectorAll(selector: string) {
      if (selector === "[data-testid='chat-title-menu-trigger']") return state.trigger ? [trigger] : []
      if (selector === "[data-testid='chat-menu-item-new-chat']") return state.menu ? [item] : []
      if (selector === "[data-testid='chat-model-button']")
        return [{ ...element(state.iconOnly ? "" : state.agent), disabled: true }]
      if (selector === "[data-testid='model-select-mode-selected-model']")
        return state.modeLabel ? [element(state.modeLabel)] : []
      if (selector === "textarea[data-testid='chat-input']") return [state.composer]
      return []
    },
  }
  const window = {
    addEventListener() {},
    postMessage() {},
    HTMLTextAreaElement: { prototype: {} },
    __o1CodeRecorderState: () => ({
      pending: state.pending,
      failure: state.failure,
      version: 1,
      changedAt: state.changedAt,
    }),
    __o1CodeRecorderControl: (data: { requireIdle?: boolean; runId?: string }) => {
      if (data.requireIdle && (state.pending || state.failure)) throw new Error("busy")
      state.armed = Boolean(data.runId)
    },
  }
  const context = vm.createContext({
    __O1_CODE_BRIDGE_TEST_HOOKS__: true,
    process: { versions: { node: "test" } },
    document,
    window,
    location: {
      hostname: mode === "assistant" ? "open-web-assistant-cs.wpp.ai" : "open-web-agent-builder-cs.wpp.ai",
      pathname: mode === "assistant" ? "/chat/project/ai-assistant" : "/chat/project/foundational",
    },
    crypto,
    Date: { now: () => state.time },
    getComputedStyle: () => ({ visibility: "visible", display: "block" }),
    InputEvent: class extends Event {
      data: unknown
      constructor(type: string, options: object) {
        super(type, options)
        this.data = Reflect.get(options, "data")
      }
    },
    Event: class {
      constructor(readonly type: string) {}
    },
    setTimeout: (callback: () => void, ms: number) => {
      if (ms >= 1000) return -1
      state.time += ms
      state.onTick()
      callback()
      return 0
    },
    clearTimeout() {},
  })
  vm.runInContext(await Bun.file(join(import.meta.dir, "injected", "content.js")).text(), context)
  const hooks = vm.runInContext("__o1CodeBridgeContentTest", context)
  return {
    hooks: {
      ...hooks,
      startFreshChat: async (options = {}) => {
        if (mode === "assistant" && state.trigger) {
          trigger.click()
          item.click()
        }
        return hooks.startFreshChat({ ...options, shellReset: state.trigger })
      },
    },
    state,
    trigger,
    item,
  }
}

function element(textContent: string) {
  return {
    textContent,
    disabled: false,
    readOnly: false,
    isConnected: true,
    clicks: 0,
    getAttribute: () => null,
    getBoundingClientRect: () => ({ width: 24, height: 24 }),
    onClick: () => {},
    focus: () => {},
    dispatchEvent: () => {},
    querySelector: () => null,
    click() {
      this.clicks += 1
      this.onClick()
    },
  }
}
