import { describe, expect, test } from "bun:test"
import vm from "node:vm"
import {
  agentChatFrame,
  agentRosterStateExpression,
  agentChatProjectId,
  agentChatLaunchExpression,
  agentChatSelectedExpression,
  isAgentChatUrl,
  openAgentChat,
} from "./agent-chat"

describe("published WPP agent chat", () => {
  test("does not launch before the roster DOM is ready", () => {
    const h = harness(["CM_Astra"])
    h.state.readyState = "loading"
    h.launch("CM_Astra", "hover")
    h.launch("CM_Astra", "open")
    expect(h.cards[0].button.clicks).toBe(0)
    expect(h.chat.clicks).toBe(0)
    h.state.readyState = "complete"
    h.launch("CM_Astra", "hover")
    h.state.readyState = "loading"
    h.launch("CM_Astra", "chat")
    expect(h.chat.clicks).toBe(0)
    h.state.readyState = "complete"
    h.launch("CM_Astra", "chat")
    expect(h.chat.clicks).toBe(1)
  })

  test("does not open the roster while background resources are still loading", () => {
    const h = harness(["CM_Astra"])
    h.state.readyState = "interactive"
    h.launch("CM_Astra", "hover")
    expect(h.launch("CM_Astra", "chat")).toBe("loading")
    expect(h.chat.clicks).toBe(0)
  })

  test("roster readiness includes all cards, loading indicators and images", () => {
    const h = harness(["CM_Astra", "CM_Lazy"])
    h.cards[1].button.disabled = true
    expect(h.execute(agentRosterStateExpression()).ready).toBe(false)
    h.cards[1].button.disabled = false
    h.state.rosterBusy = true
    expect(h.execute(agentRosterStateExpression()).ready).toBe(false)
    h.state.rosterBusy = false
    h.state.imagesComplete = false
    expect(h.execute(agentRosterStateExpression()).ready).toBe(false)
    h.state.imagesComplete = true
    expect(h.execute(agentRosterStateExpression())).toEqual({ ready: true, signature: '["CM_Astra","CM_Lazy"]' })
  })

  test("recognizes the agent chat, excluding the editor and assistant panel", () => {
    expect(isAgentChatUrl("https://open-web-agent-builder-cs.wpp.ai/chat/project/foundational?model=agent")).toBe(true)
    expect(isAgentChatUrl("https://open-web-agent-builder-cs.wpp.ai/chat/project/next-leaf")).toBe(true)
    expect(isAgentChatUrl("https://open-web-agent-builder-cs.wpp.ai/chat/project")).toBe(false)
    expect(isAgentChatUrl("https://open-web-agent-builder-cs.wpp.ai/agent/project/edit/agent")).toBe(false)
    expect(isAgentChatUrl("https://open-web-assistant-cs.wpp.ai/chat/project")).toBe(false)
  })

  test("keeps the orchestration UUID separate from the builder project identity", () => {
    expect(agentChatProjectId("https://ogilvy.os.wpp.com/orchestration/project/096d5921/agents")).toBeUndefined()
    expect(agentChatProjectId("https://open-web-agent-builder-cs.wpp.ai/agent/OmGRFTpLYzjHbtMKigl1j?view=grid")).toBe(
      "OmGRFTpLYzjHbtMKigl1j",
    )
    expect(agentChatProjectId("https://open-web-agent-builder-cs.wpp.ai/chat/OmGRFTpLYzjHbtMKigl1j/foundational")).toBe(
      "OmGRFTpLYzjHbtMKigl1j",
    )
  })

  test("opens only the exact agent's menu, then its Chat action", () => {
    const h = harness(["CM_Sol_High", "CM_Sol_XHigh"])
    expect(h.launch("CM_Sol_High", "open")).toBe("waiting")
    expect(h.cards.map((card) => card.button.clicks)).toEqual([1, 0])
    expect(h.chat.clicks).toBe(0)
    h.state.menuVisible = true
    expect(h.launch("CM_Sol_High", "chat")).toBe("clicked")
    expect(h.chat.clicks).toBe(1)
  })

  test("opens a hover-triggered agent menu before selecting Chat", () => {
    const h = harness(["CM_Sol_High", "CM_Astra"])
    expect(h.launch("CM_Astra", "hover")).toBe("waiting")
    expect(h.launch("CM_Astra", "chat")).toBe("clicked")
    expect(h.cards.map((card) => card.button.clicks)).toEqual([0, 0])
    expect(h.chat.clicks).toBe(1)
  })

  test("recognizes WPP's unlabelled portal menu through its sole open Ant trigger", () => {
    const h = harness(["CM_Astra", "CM_Other"])
    h.state.portalMenu = true
    h.state.menuVisible = true
    h.cards[0].button.classes.add("ant-dropdown-open")
    expect(h.launch("CM_Astra")).toBe("menu-ready")
    expect(h.launch("CM_Astra", "chat")).toBe("clicked")
    expect(h.chat.clicks).toBe(1)
  })

  test.each(["missing", "other", "multiple", "multiple-menus"])(
    "rejects an unlabelled portal menu with %s ownership",
    (ownership) => {
      const h = harness(["CM_Astra", "CM_Other"])
      h.state.portalMenu = true
      h.state.menuVisible = true
      if (ownership !== "missing" && ownership !== "other") h.cards[0].button.classes.add("ant-dropdown-open")
      if (ownership === "other" || ownership === "multiple") h.cards[1].button.classes.add("ant-dropdown-open")
      if (ownership === "multiple-menus") h.state.otherMenuVisible = true
      expect(h.launch("CM_Astra", "chat")).toBe("blocked")
      expect(h.chat.clicks).toBe(0)
      expect(h.otherChat.clicks).toBe(0)
    },
  )

  test("does not open an unrelated menu when the agent is missing or duplicated", () => {
    const h = harness(["CM_Sol_High", "CM_Sol_High"])
    expect(h.launch("CM_Missing")).toBe("waiting")
    expect(h.launch("CM_Sol_High")).toBe("ambiguous")
    expect(h.cards.map((card) => card.button.clicks)).toEqual([0, 0])
    expect(h.chat.clicks).toBe(0)
  })

  test("proves the locked composer agent before reusing its window", () => {
    const context = vm.createContext({ document: { querySelectorAll: () => [{ textContent: "CM_Sol_High" }] } })
    expect(vm.runInContext(agentChatSelectedExpression("CM_Sol_High"), context)).toBe(true)
    expect(vm.runInContext(agentChatSelectedExpression("CM_Sol_XHigh"), context)).toBe(false)
  })
})

describe("dedicated chat startup lifecycle", () => {
  test.each(["slow", "missing"])("allows four minutes by default for a %s chat", async (mode) => {
    let time = 0
    const context = readyChatContext(() => mode === "slow" && time >= 180000)
    const frame = {
      url: "https://open-web-agent-builder-cs.wpp.ai/chat/project/foundational",
      executeJavaScript: async (source: string) => vm.runInContext(source, context),
    }
    const opening = openAgentChat({ mainFrame: { framesInSubtree: [frame] } }, "CM_Astra", {
      now: () => time,
      sleep: async (ms) => {
        time += ms
      },
    })
    if (mode === "slow") await opening
    if (mode === "missing") await expect(opening).rejects.toMatchObject({ type: "o1_code_agent_chat_timeout" })
    expect(time).toBe(mode === "slow" ? 180000 : 240000)
  })

  test.each(["builder-project", "other-project"])("pins Chat to the observed builder roster: %s", async (project) => {
    const h = harness(["CM_Astra"])
    const chat = {
      url: `https://open-web-agent-builder-cs.wpp.ai/chat/${project}/foundational`,
      executeJavaScript: async (source: string) =>
        vm.runInContext(
          source,
          readyChatContext(() => true),
        ),
    }
    const roster = {
      url: "https://open-web-agent-builder-cs.wpp.ai/agent/builder-project?view=grid",
      executeJavaScript: async (source: string) => {
        h.state.menuVisible = true
        return h.execute(source)
      },
    }
    const contents = { mainFrame: { framesInSubtree: [roster] } }
    const opening = openAgentChat(contents, "CM_Astra", {
      sleep: async () => {
        if (h.chat.clicks) contents.mainFrame.framesInSubtree = [chat]
      },
    })
    if (project === "builder-project") await opening
    if (project === "other-project") await expect(opening).rejects.toMatchObject({ type: "o1_code_wrong_project" })
    expect(h.chat.clicks).toBe(1)
  })

  test("rejects the right model in a chat belonging to a different project", async () => {
    const h = harness(["CM_Astra"])
    h.state.selected = "CM_Astra"
    const frame = {
      url: "https://open-web-agent-builder-cs.wpp.ai/chat/other/foundational",
      executeJavaScript: async (source: string) => h.execute(source),
    }
    await expect(
      openAgentChat({ mainFrame: { framesInSubtree: [frame] } }, "CM_Astra", { projectId: "expected" }),
    ).rejects.toMatchObject({ type: "o1_code_wrong_project" })
  })

  test("bounds an observation that never returns by the navigation deadline", async () => {
    const frame = {
      url: "https://open-web-agent-builder-cs.wpp.ai/project/agents",
      executeJavaScript: () => new Promise<unknown>(() => {}),
    }
    await expect(
      openAgentChat({ mainFrame: { framesInSubtree: [frame] } }, "CM_Astra", { timeoutMs: 10 }),
    ).rejects.toMatchObject({ type: "o1_code_agent_chat_timeout" })
  })
  test("cancels while page observation is pending without dispatching another action", async () => {
    const pending = Promise.withResolvers<unknown>()
    const observing = Promise.withResolvers<void>()
    const controller = new AbortController()
    let time = 0
    let commands = 0
    const roster = {
      url: "https://open-web-agent-builder-cs.wpp.ai/project/agents",
      executeJavaScript: async () => {
        commands += 1
        observing.resolve()
        return pending.promise
      },
    }
    const opening = openAgentChat({ mainFrame: { framesInSubtree: [roster] } }, "CM_Astra", {
      now: () => time,
      sleep: async (ms) => {
        time += ms
      },
      timeoutMs: 1000,
      signal: controller.signal,
    }).catch((error) => error)
    await observing.promise
    controller.abort()
    pending.resolve({ state: "waiting", acted: false })
    expect(await opening).toMatchObject({ type: "o1_code_client_aborted" })
    expect(commands).toBe(1)
  })

  test("waits for the connected composer after the expected chat and model appear", async () => {
    const h = harness(["CM_Astra"])
    h.state.readyState = "interactive"
    h.state.selected = "CM_Astra"
    h.state.composerReady = false
    let time = 0
    const chat = {
      url: "https://open-web-agent-builder-cs.wpp.ai/chat/project/foundational",
      executeJavaScript: async (source: string) => h.execute(source),
    }
    await openAgentChat({ mainFrame: { framesInSubtree: [chat] } }, "CM_Astra", {
      now: () => time,
      sleep: async (ms) => {
        time += ms
        if (time >= 750) {
          h.state.composerReady = true
          h.state.readyState = "complete"
        }
      },
      timeoutMs: 2000,
    })
    expect(time).toBeGreaterThanOrEqual(750)
  })

  test("recovers an unacknowledged menu opening before dispatching Chat once", async () => {
    const h = harness(["CM_Astra"])
    h.state.hoverOpensMenu = false
    const button = h.cards[0].button
    button.click = () => {
      button.clicks += 1
      if (button.clicks === 2) h.state.menuVisible = true
    }
    let time = 0
    const roster = {
      url: "https://open-web-agent-builder-cs.wpp.ai/project/agents",
      executeJavaScript: async (source: string) => h.execute(source),
    }
    await openAgentChat({ mainFrame: { framesInSubtree: [roster] } }, "CM_Astra", {
      now: () => time,
      sleep: async (ms) => {
        time += ms
        if (h.chat.clicks) {
          roster.url = "https://open-web-agent-builder-cs.wpp.ai/chat/project/foundational"
          h.state.selected = "CM_Astra"
        }
      },
      timeoutMs: 4000,
    })
    expect(h.chat.clicks).toBe(1)
  })

  test("waits for full roster load and asynchronous card/action readiness", async () => {
    const h = harness(["CM_Astra"])
    h.state.readyState = "loading"
    h.state.hoverOpensMenu = false
    h.cards[0].button.disabled = true
    h.chat.disabled = true
    let time = 0
    const roster = {
      url: "https://open-web-agent-builder-cs.wpp.ai/project/agents",
      executeJavaScript: async (source: string) => h.execute(source),
    }
    await openAgentChat({ mainFrame: { framesInSubtree: [roster] } }, "CM_Astra", {
      now: () => time,
      sleep: async (ms) => {
        time += ms
        if (time <= 1000) expect(h.cards[0].button.clicks).toBe(0)
        if (time <= 1500) expect(h.chat.clicks).toBe(0)
        if (time >= 500) h.state.readyState = "complete"
        if (time >= 1000) h.cards[0].button.disabled = false
        if (time >= 1250) h.state.menuVisible = true
        if (time >= 1500) h.chat.disabled = false
        if (h.chat.clicks) {
          roster.url = "https://open-web-agent-builder-cs.wpp.ai/chat/project/foundational"
          h.state.selected = "CM_Astra"
        }
      },
      timeoutMs: 3000,
    })
    expect(h.cards[0].button.clicks).toBe(0)
    expect(h.chat.clicks).toBe(1)
  })

  test("waits for accepted navigation delayed beyond six seconds without another Chat click", async () => {
    const h = harness(["CM_Astra"])
    let time = 0
    const roster = {
      url: "https://open-web-agent-builder-cs.wpp.ai/project/agents",
      executeJavaScript: async (source: string) => {
        const before = h.chat.clicks
        const result = h.execute(source)
        if (h.chat.clicks !== before) h.state.menuVisible = false
        return result
      },
    }
    await openAgentChat({ mainFrame: { framesInSubtree: [roster] } }, "CM_Astra", {
      now: () => time,
      sleep: async (ms) => {
        time += ms
        if (time >= 6500) {
          roster.url = "https://open-web-agent-builder-cs.wpp.ai/chat/project/foundational"
          h.state.selected = time >= 7000 ? "CM_Astra" : "CM_Other"
        }
      },
      timeoutMs: 10000,
    })
    expect(h.chat.clicks).toBe(1)
    expect(h.cards[0].button.clicks).toBe(0)
    expect(time).toBe(7000)
  })

  test.each(["unchanged", "temporary-disabled", "unrelated-menu"])(
    "dispatches a dropped Chat click once and waits the full deadline with %s controls",
    async (controls) => {
      const h = harness(["CM_Astra"])
      let time = 0
      const roster = {
        url: "https://open-web-agent-builder-cs.wpp.ai/project/agents?token=secret",
        executeJavaScript: async (source: string) => {
          const before = h.chat.clicks
          const result = h.execute(source)
          if (h.chat.clicks !== before) h.state.menuVisible = false
          return result
        },
      }
      const error = await openAgentChat({ mainFrame: { framesInSubtree: [roster] } }, "CM_Astra", {
        now: () => time,
        sleep: async (ms) => {
          time += ms
          if (controls === "temporary-disabled") h.cards[0].button.disabled = time >= 500 && time < 1000
          if (controls === "unrelated-menu" && time >= 500) h.state.otherMenuVisible = true
        },
        timeoutMs: 12000,
      }).catch((error: unknown) => error)
      expect(error).toMatchObject({
        type: "o1_code_agent_chat_timeout",
        statusCode: 502,
        diagnostics: { phase: "chat-navigation", chatClicks: 1 },
      })
      expect(h.chat.clicks).toBe(1)
      expect(h.cards[0].button.clicks).toBe(0)
      expect(h.otherChat.clicks).toBe(0)
      expect(time).toBe(12000)
      expect(JSON.stringify(error)).not.toContain("secret")
      expect(JSON.stringify(error)).not.toContain("https://")
    },
  )

  test("launches from the roster and waits for the exact published agent without touching the side panel", async () => {
    const h = harness(["CM_Astra"])
    let time = 0
    let launches = 0
    let selected = false
    const sidePanel = {
      url: "https://open-web-assistant-cs.wpp.ai/chat",
      executeJavaScript: async () => {
        throw new Error("side panel must not receive commands")
      },
    }
    const chat = {
      url: "https://open-web-agent-builder-cs.wpp.ai/chat/project/foundational?model=agent&resultId=turn",
      executeJavaScript: async (source: string) =>
        vm.runInContext(
          source,
          readyChatContext(() => selected),
        ),
    }
    const roster = {
      url: "https://open-web-agent-builder-cs.wpp.ai/project/agents",
      executeJavaScript: async (source: string) => {
        launches += 1
        const result = h.execute(source)
        h.state.menuVisible = true
        return result
      },
    }
    const contents = { mainFrame: { framesInSubtree: [sidePanel, roster] } }
    await openAgentChat(contents, "CM_Astra", {
      now: () => time,
      sleep: async (ms) => {
        time += ms
        if (h.chat.clicks) contents.mainFrame.framesInSubtree = [sidePanel, chat]
        if (time >= 3000) selected = true
      },
      timeoutMs: 4000,
    })
    expect(h.chat.clicks).toBe(1)
    expect(time).toBe(3000)
    expect(agentChatFrame(contents)).toBe(chat)
  })

  test("reuses the exact agent chat when resultId changes", async () => {
    const chat = {
      url: "https://open-web-agent-builder-cs.wpp.ai/chat/project/foundational?resultId=first",
      executeJavaScript: async (source: string) =>
        vm.runInContext(
          source,
          readyChatContext(() => true),
        ),
    }
    const contents = { mainFrame: { framesInSubtree: [chat] } }
    await openAgentChat(contents, "CM_Astra")
    chat.url = chat.url.replace("first", "second")
    expect(agentChatFrame(contents)).toBe(chat)
    await openAgentChat(contents, "CM_Astra")
  })

  test.each(["missing", "wrong-agent"])("times out without submitting when %s", async (mode) => {
    const h = harness(["CM_Astra"])
    h.state.selected = "CM_Other"
    let time = 0
    const frame = {
      url:
        mode === "missing"
          ? "https://open-web-assistant-cs.wpp.ai/chat"
          : "https://open-web-agent-builder-cs.wpp.ai/chat/project/foundational",
      executeJavaScript: async (source: string) => h.execute(source),
    }
    await expect(
      openAgentChat({ mainFrame: { framesInSubtree: [frame] } }, "CM_Astra", {
        now: () => time,
        sleep: async (ms) => {
          time += ms
        },
        timeoutMs: 1000,
      }),
    ).rejects.toMatchObject({
      type: "o1_code_agent_chat_timeout",
      statusCode: 502,
      diagnostics: { phase: mode === "missing" ? "waiting-roster" : "verifying-agent", chatClicks: 0 },
    })
    expect(time).toBe(1000)
    expect(h.chat.clicks).toBe(0)
    expect(h.cards[0].button.clicks).toBe(0)
  })

  test.each(["/chat/project/foundational", "/project/agents"])("rejects ambiguous frames at %s", async (path) => {
    const frame = {
      url: `https://open-web-agent-builder-cs.wpp.ai${path}`,
      executeJavaScript: async () => {
        throw new Error("ambiguous frames must not receive commands")
      },
    }
    await expect(
      openAgentChat({ mainFrame: { framesInSubtree: [frame, { ...frame }] } }, "CM_Astra"),
    ).rejects.toMatchObject({ type: "o1_code_wrong_agent" })
  })

  test("requires exactly one dedicated frame and excludes editors, malformed URLs and side panels", () => {
    const frame = {
      url: "https://open-web-agent-builder-cs.wpp.ai/chat/project/foundational",
      executeJavaScript: async () => true,
    }
    for (const url of [
      "invalid",
      "https://open-web-agent-builder-cs.wpp.ai/agent/project/edit/agent",
      "https://open-web-assistant-cs.wpp.ai/chat",
      "https://open-web-agent-builder-cs.wpp.ai.evil.test/chat/project/foundational",
    ]) {
      expect(() => agentChatFrame({ mainFrame: { framesInSubtree: [{ ...frame, url }] } })).toThrow(
        "o1_code_thread_desync",
      )
    }
    expect(() => agentChatFrame({ mainFrame: { framesInSubtree: [frame, { ...frame }] } })).toThrow(
      "o1_code_thread_desync",
    )
  })

  test("fails closed when another menu was already open", () => {
    const h = harness(["CM_Astra"])
    h.state.otherMenuVisible = true
    expect(h.launch("CM_Astra")).toBe("blocked")
    expect(h.cards[0].button.clicks).toBe(0)
    expect(h.chat.clicks).toBe(0)
  })
})

function readyChatContext(selected: () => boolean) {
  const element = {
    textContent: "CM_Astra",
    disabled: false,
    readOnly: false,
    isConnected: true,
    getBoundingClientRect: () => ({ width: 100, height: 40 }),
  }
  return vm.createContext({
    document: {
      readyState: "complete",
      querySelectorAll: (selector: string) => {
        if (selector === "[data-testid='chat-model-button']") return selected() ? [element] : []
        if (selector === "textarea[data-testid='chat-input']") return [element]
        return []
      },
    },
    getComputedStyle: () => ({ display: "block", visibility: "visible" }),
  })
}

function harness(names: string[]) {
  const state = {
    menuVisible: false,
    otherMenuVisible: false,
    portalMenu: false,
    hoverOpensMenu: true,
    readyState: "complete",
    selected: "",
    composerReady: true,
    rosterBusy: false,
    imagesComplete: true,
  }
  const control = (textContent = "") => ({
    textContent,
    classes: new Set<string>(),
    clicks: 0,
    dataset: {} as Record<string, string>,
    getAttribute: () => null,
    disabled: false,
    readOnly: false,
    isConnected: true,
    click() {
      this.clicks += 1
    },
    dispatchEvent(event: { type: string }) {
      if (event.type === "mouseover" && state.hoverOpensMenu) state.menuVisible = true
      return true
    },
    getBoundingClientRect: () => ({ width: 100, height: 40 }),
  })
  const cards = names.map((name) => ({
    ...control(),
    button: control(),
    querySelector(selector: string) {
      return selector === ".agent-card-title__name" ? { textContent: name } : this.button
    },
    contains(element: unknown) {
      return element === chat && !state.otherMenuVisible && !state.portalMenu
    },
  }))
  const chat = control("Chat")
  const otherChat = control("Chat")
  const menu = control()
  const otherMenu = control()
  Object.assign(menu, { getAttribute: (name: string) => (name === "data-menu-list" ? "true" : null) })
  Object.assign(otherMenu, { getAttribute: (name: string) => (name === "data-menu-list" ? "true" : null) })
  Object.assign(chat, { closest: () => (state.portalMenu ? menu : null) })
  Object.assign(otherChat, { closest: () => (state.portalMenu ? otherMenu : null) })
  const context = vm.createContext({
    document: {
      get readyState() {
        return state.readyState
      },
      get images() {
        return [{ complete: state.imagesComplete }]
      },
      querySelectorAll: (selector: string) => {
        if (selector.includes("aria-busy")) return state.rosterBusy ? [control()] : []
        if (selector === ".agent-card") return cards
        if (selector === "button.ant-dropdown-trigger.ant-dropdown-open") {
          return cards.map((card) => card.button).filter((button) => button.classes.has("ant-dropdown-open"))
        }
        if (selector === "[role='menu']") {
          return [state.menuVisible ? menu : null, state.otherMenuVisible ? otherMenu : null].filter(Boolean)
        }
        if (selector === "[data-testid='chat-model-button']") {
          return state.selected ? [control(state.selected)] : []
        }
        if (selector === "textarea[data-testid='chat-input']") return state.composerReady ? [control()] : []
        return state.otherMenuVisible ? [otherChat] : state.menuVisible ? [chat] : []
      },
    },
    getComputedStyle: () => ({ display: "block", visibility: "visible" }),
    MouseEvent: class {
      constructor(readonly type: string) {}
    },
  })
  return {
    state,
    cards,
    chat,
    otherChat,
    execute: (source: string) => vm.runInContext(source, context),
    launch: (agent: string, action: Parameters<typeof agentChatLaunchExpression>[1] = "inspect") =>
      vm.runInContext(agentChatLaunchExpression(agent, action), context).state,
  }
}
