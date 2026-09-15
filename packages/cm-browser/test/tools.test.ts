import { describe, expect, test } from "bun:test"
import type { ToolContext } from "@opencode-ai/plugin"
import type { BrowserPort } from "../src/port"
import { browserTools } from "../src/tools"
import { failure, success, type BrowserState, type Request, type Response } from "../src/protocol"

const state: BrowserState = {
  tabID: "one",
  url: "https://teams.microsoft.com/",
  title: "Teams",
  visibleText: "Message Send",
  elements: [
    { ref: "s4:e0", tag: "button", role: "", label: "Send", text: "Send" },
    { ref: "s4:e1", tag: "textarea", role: "textbox", label: "Message", text: "" },
  ],
}

function fakePort(reply: Response<BrowserState> = success(state)) {
  const sent: { sessionID: string; request: Request }[] = []
  const port: BrowserPort = {
    send: async (sessionID, request) => {
      sent.push({ sessionID, request })
      return reply
    },
  }
  return { port, sent }
}

function fakeContext(sessionID = "ses_1") {
  const asked: { permission: string; patterns: string[] }[] = []
  const context = {
    sessionID,
    messageID: "msg_1",
    agent: "build",
    directory: ".",
    worktree: ".",
    abort: new AbortController().signal,
    metadata: () => undefined,
    ask: async (input) => {
      asked.push({ permission: input.permission, patterns: input.patterns })
    },
  } satisfies ToolContext
  return { context, asked }
}

describe("browser tools", () => {
  test("read state renders visible text and opaque refs", async () => {
    const browser = fakePort()
    const call = fakeContext("ses_read")
    const result = await browserTools(browser.port).browser_read_state.execute({ tabID: "one" }, call.context)
    const output = typeof result === "string" ? result : result.output
    expect(browser.sent).toEqual([{ sessionID: "ses_read", request: { tabID: "one", op: "read_state" } }])
    expect(call.asked[0]).toEqual({ permission: "browser_read_state", patterns: ["*"] })
    expect(output).toContain("Message Send")
    expect(output).toContain("[s4:e0] <button> Send")
  })

  test("writes use their tool IDs and hostname as the permission pattern", async () => {
    const browser = fakePort()
    const tools = browserTools(browser.port)
    const click = fakeContext("ses_click")
    await tools.browser_click.execute({ tabID: "one", ref: "s4:e0" }, click.context)
    expect(click.asked.at(-1)).toEqual({ permission: "browser_click", patterns: ["teams.microsoft.com"] })

    const key = fakeContext("ses_key")
    await tools.browser_press_key.execute({ tabID: "one", key: "Enter", ctrl: true }, key.context)
    expect(browser.sent.at(-1)?.request).toEqual({ tabID: "one", op: "press_key", key: "Enter", modifiers: ["Ctrl"] })
    expect(key.asked.at(-1)).toEqual({ permission: "browser_press_key", patterns: ["teams.microsoft.com"] })
  })

  test("fill forwards its opaque ref and text", async () => {
    const browser = fakePort()
    await browserTools(browser.port).browser_fill.execute(
      { tabID: "one", ref: "s4:e1", text: "hi" },
      fakeContext("ses_fill").context,
    )
    expect(browser.sent.at(-1)?.request).toEqual({ tabID: "one", op: "fill", ref: "s4:e1", text: "hi" })
  })

  test("history tools expose bounded result refs and never imply page access", async () => {
    const browser = fakePort(
      success({ ...state, history: [{ ref: "history-ref", url: state.url, title: "Teams", time: 100 }] }),
    )
    const call = fakeContext()
    const reply = await browserTools(browser.port).browser_search_history.execute(
      { query: "Teams", from: 0, to: 200 },
      call.context,
    )
    expect(browser.sent[0].request).toEqual({ op: "search_history", query: "Teams", from: 0, to: 200, limit: 10 })
    expect(call.asked[0].permission).toBe("browser_search_history")
    expect(typeof reply === "string" ? reply : reply.output).toContain("history-ref")
    const opened = fakePort(success({ ...state, opened: true }))
    const result = await browserTools(opened.port).browser_open_history.execute({ ref: "history-ref" }, call.context)
    expect(opened.sent[0].request).toEqual({ op: "open_history", ref: "history-ref" })
    expect(call.asked.at(-1)?.permission).toBe("browser_open_history")
    expect(typeof result === "string" ? result : result.output).toContain("Agent access is off")
  })

  test("failures surface their typed code", async () => {
    const browser = fakePort(failure("stale_ref", "read again"))
    await expect(
      browserTools(browser.port).browser_click.execute(
        { tabID: "one", ref: "s1:e0" },
        fakeContext("ses_stale").context,
      ),
    ).rejects.toThrow(/stale_ref/)
  })
})
