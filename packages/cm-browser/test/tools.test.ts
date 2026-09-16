import { describe, expect, test } from "bun:test"
import type { ToolContext } from "@opencode-ai/plugin"
import type { BrowserPort } from "../src/port"
import { browserTools } from "../src/tools"
import { failure, success, type BrowserState, type Request, type Response } from "../src/protocol"

const state = {
  context: {
    tabID: "one",
    origin: "https://teams.microsoft.com",
    urlHash: "a".repeat(64),
    revision: 3,
    accessRevision: 2,
  },
  tabID: "one",
  url: "https://teams.microsoft.com/",
  title: "Teams",
  visibleText: "Message Send",
  elements: [
    { ref: "s4:e0", tag: "button", role: "", label: "Send", text: "Send" },
    { ref: "s4:e1", tag: "textarea", role: "textbox", label: "Message", text: "" },
  ],
} satisfies BrowserState

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
  test.each([
    ["browser_scroll", { deltaX: 0, deltaY: 200, timeoutMs: 1000 }],
    ["browser_wait_for_element", { selector: "#ready", timeoutMs: 1000 }],
    ["browser_wait_for_navigation", { url: state.url, timeoutMs: 1000 }],
  ] as const)("%s keeps read gating, task identity and abort", async (name, args) => {
    const browser = fakePort()
    const call = fakeContext()
    const controller = new AbortController()
    call.context.abort = controller.signal
    const send = browser.port.send
    const port: BrowserPort = {
      send: async (sessionID, request, signal) => {
        expect(signal).toBe(controller.signal)
        return send(sessionID, request, signal)
      },
    }
    const tools = browserTools(port)
    expect(tools[name]).toBeDefined()
    await tools[name].execute({ tabID: "one", ...args }, call.context)
    expect(call.asked[0]).toEqual({ permission: "browser_read_state", patterns: ["*"] })
    expect(browser.sent.at(-1)).toMatchObject({
      sessionID: call.context.sessionID,
      request: { op: name.slice(8), tabID: "one", ...args },
    })
    if (name === "browser_scroll") {
      expect(call.asked.at(-1)).toEqual({ permission: name, patterns: ["teams.microsoft.com"] })
      expect(browser.sent.at(-1)?.request).toMatchObject({ context: state.context })
    } else expect(call.asked).toHaveLength(1)
    controller.abort()
    const count = browser.sent.length
    await expect(tools[name].execute({ tabID: "one", ...args }, call.context)).rejects.toThrow()
    expect(browser.sent).toHaveLength(count)
  })

  test.each(["before", "read", "write", "prepare"])(
    "abort during %s prevents further approval or dispatch",
    async (stage) => {
      const browser = fakePort()
      const call = fakeContext()
      const controller = new AbortController()
      call.context.abort = controller.signal
      const send = browser.port.send
      const port: BrowserPort = {
        send: async (sessionID, request, signal) => {
          expect(signal).toBe(controller.signal)
          const reply = await send(sessionID, request, signal)
          if (stage === "prepare") controller.abort()
          return reply
        },
      }
      const ask = call.context.ask
      call.context.ask = async (input) => {
        await ask(input)
        if (input.permission === (stage === "read" ? "browser_read_state" : "browser_press_key")) controller.abort()
      }
      if (stage === "before") controller.abort()
      await expect(
        browserTools(port).browser_press_key.execute({ tabID: "one", key: "Enter" }, call.context),
      ).rejects.toThrow()
      expect(browser.sent.every(({ request }) => request.op === "prepare_write")).toBe(true)
      expect(browser.sent).toHaveLength(stage === "before" || stage === "read" ? 0 : 1)
      expect(call.asked).toHaveLength(stage === "before" ? 0 : stage === "write" ? 2 : 1)
    },
  )

  test.each(["browser_scroll", "browser_wait_for_element", "browser_wait_for_navigation"])(
    "%s cannot bypass read denial or abort during read approval",
    async (name) => {
      for (const reason of ["deny", "abort"]) {
        const browser = fakePort()
        const call = fakeContext()
        const controller = new AbortController()
        call.context.abort = controller.signal
        call.context.ask = async (input) => {
          expect(input.permission).toBe("browser_read_state")
          if (reason === "deny") throw new Error("Read denied")
          controller.abort()
        }
        await expect(
          browserTools(browser.port)[name].execute(
            { tabID: "one", deltaX: 0, deltaY: 1, selector: "#ready", url: state.url, timeoutMs: 1000 },
            call.context,
          ),
        ).rejects.toThrow()
        expect(browser.sent).toEqual([])
      }
    },
  )

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
    expect(browser.sent.at(-1)?.request).toEqual({
      tabID: "one",
      op: "press_key",
      key: "Enter",
      modifiers: ["Ctrl"],
      context: state.context,
    })
    expect(key.asked.at(-1)).toEqual({ permission: "browser_press_key", patterns: ["teams.microsoft.com"] })
  })

  test("fill forwards its opaque ref and text", async () => {
    const browser = fakePort()
    await browserTools(browser.port).browser_fill.execute(
      { tabID: "one", ref: "s4:e1", text: "hi" },
      fakeContext("ses_fill").context,
    )
    expect(browser.sent.at(-1)?.request).toEqual({
      tabID: "one",
      op: "fill",
      ref: "s4:e1",
      text: "hi",
      context: state.context,
    })
  })

  test.each([
    ["browser_press_key", { key: "Enter" }],
    ["browser_click", { ref: "s4:e0" }],
    ["browser_fill", { ref: "s4:e1", text: "hi" }],
    ["browser_navigate", { url: "http://localhost/destination" }],
    ["browser_scroll", { deltaX: 0, deltaY: 200 }],
  ] as const)("%s retains the context captured before deferred approval", async (name, args) => {
    const browser = fakePort()
    const call = fakeContext()
    const waiting = Promise.withResolvers<void>()
    const approval = Promise.withResolvers<void>()
    call.context.ask = async (input) => {
      call.asked.push({ permission: input.permission, patterns: input.patterns })
      if (input.permission !== name) return
      waiting.resolve()
      await approval.promise
    }
    const pending = browserTools(browser.port)[name].execute({ tabID: "one", ...args }, call.context)
    try {
      await waiting.promise
      expect(browser.sent).toHaveLength(1)
      expect(browser.sent[0].request.op).toBe("prepare_write")
      expect(call.asked.at(-1)).toEqual({
        permission: name,
        patterns: [name === "browser_navigate" ? "localhost" : "teams.microsoft.com"],
      })
      approval.resolve()
      await pending
      expect(browser.sent).toHaveLength(2)
      expect(browser.sent[1].request).toMatchObject({ tabID: "one", context: state.context })
    } finally {
      approval.resolve()
      await pending
    }
  })

  test.each([
    ["browser_press_key", { key: "Enter" }],
    ["browser_click", { ref: "s4:e0" }],
    ["browser_fill", { ref: "s4:e1", text: "hi" }],
    ["browser_navigate", { url: "http://localhost/destination" }],
    ["browser_scroll", { deltaX: 0, deltaY: 200 }],
  ] as const)("%s cannot dispatch after an aborted deferred approval answers late", async (name, args) => {
    const browser = fakePort()
    const call = fakeContext()
    const controller = new AbortController()
    const waiting = Promise.withResolvers<void>()
    const approval = Promise.withResolvers<void>()
    call.context.abort = controller.signal
    call.context.ask = async (input) => {
      if (input.permission !== name) return
      waiting.resolve()
      await approval.promise
    }
    const tools = browserTools(browser.port)
    const pending = tools[name].execute({ tabID: "one", ...args }, call.context).catch((error: unknown) => error)
    try {
      await waiting.promise
      controller.abort()
      approval.resolve()
      expect(await pending).toBeInstanceOf(Error)
      expect(browser.sent.map(({ request }) => request.op)).toEqual(["prepare_write"])
    } finally {
      approval.resolve()
      await pending
    }
  })

  test("missing or malformed main context fails before write approval", async () => {
    for (const context of [undefined, { ...state.context, revision: -1 }, { ...state.context, tabID: "other" }]) {
      const browser = fakePort(success({ ...state, context } as BrowserState))
      const call = fakeContext()
      await expect(
        browserTools(browser.port).browser_press_key.execute({ tabID: "one", key: "Enter" }, call.context),
      ).rejects.toThrow(/approval context/)
      expect(browser.sent).toHaveLength(1)
      expect(call.asked.map((input) => input.permission)).toEqual(["browser_read_state"])
    }
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
