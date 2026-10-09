import { describe, expect, test } from "bun:test"
import vm from "node:vm"
import {
  agentChatFrame,
  agentChatLaunchExpression,
  agentChatSelectedExpression,
  isAgentChatUrl,
  openAgentChat,
} from "./agent-chat"

describe("published WPP agent chat", () => {
  test("recognizes the agent chat, excluding the editor and assistant panel", () => {
    expect(isAgentChatUrl("https://open-web-agent-builder-cs.wpp.ai/chat/project/foundational?model=agent")).toBe(true)
    expect(isAgentChatUrl("https://open-web-agent-builder-cs.wpp.ai/agent/project/edit/agent")).toBe(false)
    expect(isAgentChatUrl("https://open-web-assistant-cs.wpp.ai/chat/project")).toBe(false)
  })

  test("opens only the exact agent's menu, then its Chat action", () => {
    const h = harness(["CM_Sol_High", "CM_Sol_XHigh"])
    expect(h.launch("CM_Sol_High")).toBe("waiting")
    expect(h.cards.map((card) => card.button.clicks)).toEqual([1, 0])
    expect(h.chat.clicks).toBe(0)
    h.state.menuVisible = true
    expect(h.launch("CM_Sol_High")).toBe("opened")
    expect(h.chat.clicks).toBe(1)
  })

  test("opens a hover-triggered agent menu before selecting Chat", () => {
    const h = harness(["CM_Sol_High", "CM_Astra"])
    expect(h.launch("CM_Astra")).toBe("waiting")
    expect(h.launch("CM_Astra")).toBe("opened")
    expect(h.cards.map((card) => card.button.clicks)).toEqual([0, 1])
    expect(h.chat.clicks).toBe(1)
  })

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
      executeJavaScript: async (source: string) => {
        const context = vm.createContext({
          document: { querySelectorAll: () => (selected ? [{ textContent: "CM_Astra" }] : []) },
        })
        return vm.runInContext(source, context)
      },
    }
    const roster = {
      url: "https://open-web-agent-builder-cs.wpp.ai/project/agents",
      executeJavaScript: async (_source: string) => {
        launches += 1
        const result = h.launch("CM_Astra")
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
        if (time >= 1000) selected = true
      },
      timeoutMs: 2000,
    })
    expect(launches).toBe(2)
    expect(h.chat.clicks).toBe(1)
    expect(time).toBe(1000)
    expect(agentChatFrame(contents)).toBe(chat)
  })

  test("reuses the exact agent chat when resultId changes", async () => {
    const chat = {
      url: "https://open-web-agent-builder-cs.wpp.ai/chat/project/foundational?resultId=first",
      executeJavaScript: async (source: string) =>
        vm.runInNewContext(source, {
          document: { querySelectorAll: () => [{ textContent: "CM_Astra" }] },
        }),
    }
    const contents = { mainFrame: { framesInSubtree: [chat] } }
    await openAgentChat(contents, "CM_Astra")
    chat.url = chat.url.replace("first", "second")
    expect(agentChatFrame(contents)).toBe(chat)
    await openAgentChat(contents, "CM_Astra")
  })

  test.each(["missing", "wrong-agent"])("times out without submitting when %s", async (mode) => {
    let time = 0
    const frame = {
      url:
        mode === "missing"
          ? "https://open-web-assistant-cs.wpp.ai/chat"
          : "https://open-web-agent-builder-cs.wpp.ai/chat/project/foundational",
      executeJavaScript: async () => false,
    }
    await expect(
      openAgentChat({ mainFrame: { framesInSubtree: [frame] } }, "CM_Astra", {
        now: () => time,
        sleep: async (ms) => {
          time += ms
        },
        timeoutMs: 1000,
      }),
    ).rejects.toMatchObject({ type: "o1_code_agent_chat_timeout", statusCode: 502 })
    expect(time).toBe(1000)
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
    h.state.menuVisible = true
    expect(h.launch("CM_Astra")).toBe("blocked")
    expect(h.cards[0].button.clicks).toBe(0)
    expect(h.chat.clicks).toBe(0)
  })
})

function harness(names: string[]) {
  const state = { menuVisible: false }
  const control = (textContent = "") => ({
    textContent,
    clicks: 0,
    dataset: {} as Record<string, string>,
    getAttribute: () => null,
    disabled: false,
    click() {
      this.clicks += 1
    },
    dispatchEvent(event: { type: string }) {
      if (event.type === "mouseover") state.menuVisible = true
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
  }))
  const chat = control("Chat")
  const context = vm.createContext({
    document: {
      querySelectorAll: (selector: string) => (selector === ".agent-card" ? cards : state.menuVisible ? [chat] : []),
    },
    getComputedStyle: () => ({ display: "block", visibility: "visible" }),
    MouseEvent: class {
      constructor(readonly type: string) {}
    },
  })
  return { state, cards, chat, launch: (agent: string) => vm.runInContext(agentChatLaunchExpression(agent), context) }
}
