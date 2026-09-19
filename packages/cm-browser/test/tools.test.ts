import { describe, expect, test } from "bun:test"
import type { ToolContext } from "@opencode-ai/plugin"
import type { BrowserPort } from "../src/port"
import { browserTools } from "../src/tools"
import { failure, success, type BrowserState, type Request, type Response, type TabRequest } from "../src/protocol"

const state = {
  context: {
    tabID: "one",
    origin: "https://teams.microsoft.com",
    urlHash: "a".repeat(64),
    revision: 3,
    accessRevision: 2,
    ownerContext: "owner-task-1",
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
  test("frame targeting is rejected before plugin approval or top-page dispatch", async () => {
    const browser = fakePort()
    const call = fakeContext()
    for (const definition of Object.values(browserTools(browser.port)))
      for (const key of ["frameRef", "frameId", "frameID", "executionContextId", "contextId", "sessionId", "sessionID"])
        for (const value of [undefined, null, "", "opaque", 1, {}])
          await expect(definition.execute({ tabID: "one", [key]: value }, call.context)).rejects.toThrow(
            "Unsupported browser frame target.",
          )
    expect(browser.sent).toEqual([])
    expect(call.asked).toEqual([])
  })

  test("frame selection preserves original refs across separate deferred consent and rejects forged inputs", async () => {
    const args = {
      tabID: "one",
      frameRef: "a".repeat(36),
      ref: `frame.${"b".repeat(36)}:select`,
      optionRef: `frame.${"b".repeat(36)}:option`,
    }
    for (const decision of ["allow", "deny", "abort"]) {
      const binding = {
        ...args,
        op: "select_option" as const,
        approval: "c".repeat(36),
        topOrigin: "https://top.test:8443",
        origin: "https://child.test:9443",
      }
      const { tabID: _tabID, ...frameSelectContext } = binding
      const sent: Request[] = []
      const call = fakeContext()
      const controller = new AbortController()
      call.context.abort = controller.signal
      const entered = Promise.withResolvers<void>()
      const release = Promise.withResolvers<void>()
      call.context.ask = async (input) => {
        if (input.permission === "browser_read_state") return
        expect(input.permission).toBe("browser_select_frame_option")
        expect(input.patterns).toEqual([`${binding.topOrigin} -> ${binding.origin}`])
        expect(input.always).toEqual([])
        expect(input.metadata.ref).toBe(args.ref)
        expect(input.metadata.optionRef).toBe(args.optionRef)
        expect(sent).toEqual([{ op: "prepare_frame_select", ...args }])
        entered.resolve()
        await release.promise
      }
      const tools = browserTools({
        send: async (_session, request) => {
          sent.push(request)
          return success({ ...state, frameSelectContext })
        },
      })
      const pending = tools.browser_select_option.execute(args, call.context).catch((error: unknown) => error)
      await entered.promise
      if (decision === "abort") controller.abort()
      if (decision === "deny") release.reject(new Error("Denied"))
      else release.resolve()
      const response = await pending
      expect(response instanceof Error).toBe(decision !== "allow")
      expect(sent).toHaveLength(decision === "allow" ? 2 : 1)
      if (decision === "allow") expect(sent[1]).toEqual({ op: "select_option", ...args, frameSelectContext })
    }
    for (const extra of [{ op: "read_state" }, { frameSelectContext: {} }, { frameContext: {} }, { unknown: true }]) {
      const browser = fakePort()
      const call = fakeContext()
      await expect(
        browserTools(browser.port).browser_select_option.execute({ ...args, ...extra }, call.context),
      ).rejects.toThrow()
      expect(browser.sent).toEqual([])
      expect(call.asked).toEqual([])
    }
  })

  const emptyTabState = { tabID: "", url: "", title: "", visibleText: "", elements: [] }
  const tabActions: TabRequest["op"][] = ["create_tab", "select_tab", "close_tab"]

  test.each(tabActions)("%s binds token before deferred named approval, denial and late abort", async (op) => {
    for (const decision of ["allow", "deny", "abort"]) {
      const request: TabRequest = op === "create_tab" ? { op } : { op, tabID: "one" }
      const args = op === "create_tab" ? {} : { tabID: "one" }
      const prepared = { ...emptyTabState, tabToken: "original-token" }
      const sent: { sessionID: string; request: Request }[] = []
      const call = fakeContext("lifecycle-session")
      const controller = new AbortController()
      call.context.abort = controller.signal
      const waiting = Promise.withResolvers<void>()
      const approval = Promise.withResolvers<void>()
      call.context.ask = async (input) => {
        expect(input).toEqual({ permission: `browser_${op}`, patterns: ["*"], always: ["*"], metadata: request })
        expect(sent).toEqual([{ sessionID: "lifecycle-session", request: { op: "prepare_tab", request } }])
        waiting.resolve()
        await approval.promise
      }
      const port: BrowserPort = {
        send: async (sessionID, action, signal) => {
          expect(signal).toBe(controller.signal)
          sent.push({ sessionID, request: action })
          return success(action.op === "prepare_tab" ? prepared : { ...emptyTabState, tabResult: { op, tabID: "one" } })
        },
      }
      const tools = browserTools(port)
      const pending = tools[`browser_${op}`].execute(args, call.context).catch((error: unknown) => error)
      try {
        await waiting.promise
        prepared.tabToken = "changed-token"
        if (decision === "abort") controller.abort()
        if (decision === "deny") approval.reject(new Error("Denied"))
        else approval.resolve()
        const reply = await pending
        if (decision !== "allow") {
          expect(reply).toBeInstanceOf(Error)
          expect(sent).toHaveLength(1)
          continue
        }
        expect(reply).toBe(`${op} one`)
        expect(sent).toEqual([
          { sessionID: "lifecycle-session", request: { op: "prepare_tab", request } },
          { sessionID: "lifecycle-session", request: { ...request, token: "original-token" } },
        ])
      } finally {
        approval.resolve()
        await pending
      }
    }
  })

  test.each(tabActions)("%s checks abort around preparation and execution awaits", async (op) => {
    for (const stage of ["before", "prepare_tab", op]) {
      const call = fakeContext()
      const controller = new AbortController()
      call.context.abort = controller.signal
      const sent: Request[] = []
      const port: BrowserPort = {
        send: async (_sessionID, request, signal) => {
          expect(signal).toBe(controller.signal)
          sent.push(request)
          if (request.op === stage) controller.abort()
          return success(
            request.op === "prepare_tab"
              ? { ...emptyTabState, tabToken: "opaque" }
              : { ...emptyTabState, tabResult: { op, tabID: "one" } },
          )
        },
      }
      if (stage === "before") controller.abort()
      await expect(
        browserTools(port)[`browser_${op}`].execute(op === "create_tab" ? {} : { tabID: "one" }, call.context),
      ).rejects.toThrow()
      expect(sent).toHaveLength(stage === "before" ? 0 : stage === "prepare_tab" ? 1 : 2)
      expect(call.asked).toHaveLength(stage === op ? 1 : 0)
    }
  })

  test.each(tabActions)("%s rejects unknown inputs without preparation or approval", async (op) => {
    const args = op === "create_tab" ? {} : { tabID: "one" }
    for (const extra of [
      { url: "https://private.invalid/" },
      { title: "private" },
      { sessionID: "other" },
      { token: "supplied" },
      { context: {} },
      { op: "read_state" },
      { unknown: true },
      ...(op === "create_tab" ? [{ tabID: "one" }] : [{ tabID: "" }, { tabID: "x".repeat(129) }]),
    ]) {
      const browser = fakePort()
      const call = fakeContext()
      await expect(
        browserTools(browser.port)[`browser_${op}`].execute({ ...args, ...extra }, call.context),
      ).rejects.toThrow()
      expect(browser.sent).toEqual([])
      expect(call.asked).toEqual([])
    }
  })

  test.each(tabActions)("%s rejects malformed or metadata-bearing lifecycle results without retry", async (op) => {
    const args = op === "create_tab" ? {} : { tabID: "one" }
    const prepared = { ...emptyTabState, tabToken: "opaque" }
    const completed = { ...emptyTabState, tabResult: { op, tabID: "one" } }
    const extras = [
      { url: "https://private.invalid/" },
      { title: "PRIVATE" },
      { visibleText: "PRIVATE" },
      { elements: [state.elements[0]] },
      { tabs: [] },
      { history: [] },
      { context: state.context },
      { screenshot: {} },
      { metadata: {} },
      { opened: false },
      { truncated: false },
      { unknown: true },
    ]
    for (const stage of ["prepare_tab", op]) {
      const valid = stage === "prepare_tab" ? prepared : completed
      const invalid =
        stage === "prepare_tab"
          ? [
              emptyTabState,
              ...[undefined, "", 1, "x".repeat(129), "https://private.invalid/"].map((tabToken) => ({
                ...prepared,
                tabToken,
              })),
              { ...prepared, tabResult: completed.tabResult },
            ]
          : [
              emptyTabState,
              ...[
                undefined,
                {},
                { op: "navigate", tabID: "one" },
                { op, tabID: "" },
                { op, tabID: "x".repeat(129) },
                { op, tabID: "https://private.invalid/" },
                { op, tabID: "one", title: "PRIVATE" },
              ].map((tabResult) => ({ ...completed, tabResult })),
              { ...completed, tabToken: "opaque" },
              ...(op === "create_tab" ? [] : [{ ...completed, tabResult: { op, tabID: "other" } }]),
            ]
      for (const value of [
        ...invalid,
        ...extras.map((extra) => ({ ...valid, ...extra })),
        { ...valid, tabID: "one" },
      ]) {
        const sent: Request[] = []
        const call = fakeContext()
        const port: BrowserPort = {
          send: async (_sessionID, request) => {
            sent.push(request)
            return success((request.op === stage ? value : prepared) as BrowserState)
          },
        }
        await expect(browserTools(port)[`browser_${op}`].execute(args, call.context)).rejects.toThrow(
          /Invalid browser tab/,
        )
        expect(sent).toHaveLength(stage === "prepare_tab" ? 1 : 2)
        expect(call.asked).toHaveLength(stage === "prepare_tab" ? 0 : 1)
      }
    }
    const browser = fakePort(failure("bad_request", "Invalid browser request."))
    const call = fakeContext()
    await expect(browserTools(browser.port)[`browser_${op}`].execute(args, call.context)).rejects.toThrow(/bad_request/)
    expect(browser.sent).toHaveLength(1)
    expect(call.asked).toEqual([])
  })

  test("screenshot uses named approval and only attachment pixels, rejecting invalid results", async () => {
    const image = { data: Buffer.from([255, 216, 255, 217]).toString("base64"), width: 1, height: 1 }
    const value = { ...state, title: "", visibleText: "", elements: [], screenshot: image }
    const browser = fakePort(success(value))
    const call = fakeContext()
    const reply = await browserTools(browser.port).browser_screenshot.execute({ tabID: "one" }, call.context)
    expect(call.asked.map((item) => item.permission)).toEqual(["browser_read_state", "browser_screenshot"])
    expect(browser.sent.map((item) => item.request.op)).toEqual(["prepare_write", "screenshot"])
    expect(browser.sent[1].request).toMatchObject({ context: state.context })
    expect(reply).toEqual({
      output: `Screenshot 1x1; tab one; source ${state.url}`,
      attachments: [{ type: "file", mime: "image/jpeg", url: `data:image/jpeg;base64,${image.data}` }],
    })
    for (const screenshot of [
      undefined,
      { ...image, data: "" },
      { ...image, data: "bad!" },
      { ...image, width: 4097 },
      { ...image, width: 4096, height: 4096 },
    ]) {
      const invalid = fakePort(success({ ...value, screenshot }))
      await expect(
        browserTools(invalid.port).browser_screenshot.execute({ tabID: "one" }, fakeContext().context),
      ).rejects.toThrow("Invalid browser screenshot")
    }
    const denied = fakePort()
    const denial = fakeContext()
    denial.context.ask = async (input) => {
      if (input.permission === "browser_screenshot") throw new Error("Denied")
    }
    await expect(
      browserTools(denied.port).browser_screenshot.execute({ tabID: "one" }, denial.context),
    ).rejects.toThrow("Denied")
    expect(denied.sent.map((item) => item.request.op)).toEqual(["prepare_write"])
  })

  test("console observation asks explicitly and returns only bounded severity counts", async () => {
    const browser = fakePort(
      success({
        ...state,
        title: "",
        visibleText: "",
        elements: [],
        diagnostics: {
          console: { durationMs: 250, debug: 1, info: 2, warning: 3, error: 4, other: 0, total: 10 },
        },
      }),
    )
    const call = fakeContext()
    const reply = await browserTools(browser.port).browser_observe_console.execute(
      { tabID: "one", durationMs: 250 },
      call.context,
    )
    expect(call.asked.map((item) => item.permission)).toEqual(["browser_read_state", "browser_observe_console"])
    expect(browser.sent.map((item) => item.request.op)).toEqual(["prepare_write", "observe_console"])
    expect(browser.sent[1].request).toMatchObject({ context: state.context, durationMs: 250 })
    expect(reply).toBe("Console counts for tab one over 250ms: error 4, warning 3, info 2, debug 1, other 0, total 10.")

    for (const diagnostics of [
      undefined,
      { console: { durationMs: 250, debug: 0, info: 0, warning: 0, error: 0, other: 0, total: 1 } },
      {
        console: {
          durationMs: 250,
          debug: 0,
          info: 0,
          warning: 0,
          error: 0,
          other: 0,
          total: 0,
          messages: ["secret"],
        },
      },
    ]) {
      const invalid = fakePort(success({ ...state, title: "", visibleText: "", elements: [], diagnostics }))
      await expect(
        browserTools(invalid.port).browser_observe_console.execute(
          { tabID: "one", durationMs: 250 },
          fakeContext().context,
        ),
      ).rejects.toThrow("Invalid browser console observation result")
    }
  })

  test("network observation uses named approval, exact counts and no payload output", async () => {
    const network = {
      durationMs: 3000,
      http1xx: 0,
      http2xx: 1,
      http3xx: 0,
      http4xx: 2,
      http5xx: 3,
      other: 0,
      failed: 4,
      total: 10,
    }
    const value = { ...state, title: "", visibleText: "", elements: [], diagnostics: { network } }
    const browser = fakePort(success(value))
    const call = fakeContext()
    const reply = await browserTools(browser.port).browser_observe_network.execute({ tabID: "one" }, call.context)
    expect(call.asked.map((item) => item.permission)).toEqual(["browser_read_state", "browser_observe_network"])
    expect(browser.sent.map((item) => item.request.op)).toEqual(["prepare_write", "observe_network"])
    expect(browser.sent[1].request).toMatchObject({ context: state.context, durationMs: 3000 })
    expect(reply).toContain("2xx 1")
    expect(reply).toContain("zero is not a health verdict")
    expect(reply).not.toContain(state.url)
    const privateState = {
      ...value,
      url: "https://example.test/?secret=token",
      context: state.context,
      screenshot: { data: "secret-pixels", width: 1, height: 1 },
    }
    const privateReply = await browserTools(fakePort(success(privateState)).port).browser_observe_network.execute(
      { tabID: "one" },
      fakeContext().context,
    )
    expect(privateReply).not.toContain("secret")
    for (const diagnostics of [undefined, { network, console: { secret: "payload" } }]) {
      const invalid = fakePort(success({ ...value, diagnostics } as unknown as BrowserState))
      await expect(
        browserTools(invalid.port).browser_observe_network.execute({ tabID: "one" }, fakeContext().context),
      ).rejects.toThrow("Invalid browser network observation")
    }
    for (const invalid of [
      { ...network, total: 11 },
      { ...network, durationMs: 250 },
      { ...network, failed: -1 },
      { ...network, http2xx: 0.5 },
      { ...network, total: Number.MAX_SAFE_INTEGER + 1 },
      { ...network, http2xx: Infinity },
      { ...network, urls: ["secret"] },
    ]) {
      const port = fakePort(success({ ...value, diagnostics: { network: invalid } }))
      await expect(
        browserTools(port.port).browser_observe_network.execute({ tabID: "one" }, fakeContext().context),
      ).rejects.toThrow("Invalid browser network observation")
    }
    for (const args of [
      { tabID: "one", frameRef: "opaque" },
      { tabID: "one", durationMs: 249 },
      { tabID: "one", durationMs: 5001 },
    ]) {
      const port = fakePort()
      await expect(
        browserTools(port.port).browser_observe_network.execute(args, fakeContext().context),
      ).rejects.toThrow()
      expect(port.sent).toHaveLength(0)
    }
    const denied = fakePort()
    const denial = fakeContext()
    denial.context.ask = async (input) => {
      if (input.permission === "browser_observe_network") throw new Error("Denied")
    }
    await expect(
      browserTools(denied.port).browser_observe_network.execute({ tabID: "one" }, denial.context),
    ).rejects.toThrow("Denied")
    expect(denied.sent.map((item) => item.request.op)).toEqual(["prepare_write"])
  })

  test("site-tool discovery labels bounded metadata as untrusted", async () => {
    const browser = fakePort(
      success({
        ...state,
        title: "",
        visibleText: "",
        elements: [],
        siteTools: [
          {
            ref: "a".repeat(8) + "-aaaa-4aaa-8aaa-" + "a".repeat(12),
            name: "search",
            description: "Search the site",
            inputSchema: '{"type":"object"}',
            readOnly: true,
          },
        ],
      }),
    )
    const call = fakeContext()
    const reply = await browserTools(browser.port).browser_list_site_tools.execute({ tabID: "one" }, call.context)
    expect(call.asked.map((item) => item.permission)).toEqual(["browser_read_state"])
    expect(browser.sent.map((item) => item.request)).toEqual([{ op: "list_site_tools", tabID: "one" }])
    if (typeof reply === "string") throw new Error("Expected structured site-tool discovery result")
    expect(reply.output).toContain("untrusted site-provided WebMCP metadata")
    expect(reply.output).toContain('"name":"search"')
  })

  test("site-tool execution binds preparation before named per-origin approval", async () => {
    const toolRef = "a".repeat(8) + "-aaaa-4aaa-8aaa-" + "a".repeat(12)
    const siteToolContext = {
      ...state.context,
      toolRef,
      toolRevision: 4,
      argumentHash: "b".repeat(64),
    }
    const sent: Request[] = []
    const call = fakeContext()
    call.context.ask = async (input) => {
      call.asked.push({ permission: input.permission, patterns: input.patterns })
      if (input.permission === "browser_read_state") return
      expect(input).toEqual({
        permission: "browser_execute_site_tool",
        patterns: ["teams.microsoft.com"],
        always: [],
        metadata: {
          tabID: "one",
          origin: "https://teams.microsoft.com",
          name: "send_message",
          title: "Send message",
          arguments: { message: "hello" },
        },
      })
      expect(sent).toHaveLength(1)
    }
    const port: BrowserPort = {
      send: async (_sessionID, request) => {
        sent.push(request)
        if (request.op === "prepare_site_tool")
          return success({
            ...state,
            title: "",
            visibleText: "",
            elements: [],
            siteToolContext,
            siteToolRequest: {
              name: "send_message",
              title: "Send message",
              origin: "https://teams.microsoft.com",
              arguments: request.arguments,
            },
          })
        return success({
          ...state,
          title: "",
          visibleText: "",
          elements: [],
          siteToolResult: {
            name: "send_message",
            origin: "https://teams.microsoft.com",
            content: '{"sent":true}',
          },
        })
      },
    }
    const reply = await browserTools(port).browser_execute_site_tool.execute(
      { tabID: "one", toolRef, arguments: '{"message":"hello"}' },
      call.context,
    )
    expect(call.asked.map((item) => item.permission)).toEqual(["browser_read_state", "browser_execute_site_tool"])
    expect(sent[1]).toEqual({
      op: "execute_site_tool",
      tabID: "one",
      toolRef,
      arguments: '{"message":"hello"}',
      siteToolContext,
    })
    if (typeof reply === "string") throw new Error("Expected structured site-tool execution result")
    expect(reply.output).toContain("Untrusted site-tool result")
    expect(reply.output).toContain('{"sent":true}')
  })

  test.each([
    ["browser_drag", { sourceRef: "s4:e0", targetRef: "s4:e1" }],
    ["browser_select_option", { ref: "s4:e0", optionRef: "s4:o1" }],
    ["browser_hover", { ref: "s4:e0" }],
    ["browser_click", { ref: "s4:e0", mode: "double" }],
    ["browser_click", { ref: "s4:e0", mode: "right" }],
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
    if (
      name === "browser_drag" ||
      name === "browser_scroll" ||
      name === "browser_hover" ||
      name === "browser_click" ||
      name === "browser_select_option"
    ) {
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

  test.each(["browser_select_option", "browser_scroll", "browser_wait_for_element", "browser_wait_for_navigation"])(
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

  test("select options render only owned metadata and describe untrusted events", async () => {
    const browser = fakePort(
      success({
        ...state,
        elements: [
          {
            ...state.elements[0],
            tag: "select",
            optionsTruncated: true,
            options: [{ ref: "s4:o1", label: "Same", selected: false, disabled: true }],
          },
        ],
      }),
    )
    const tools = browserTools(browser.port)
    const reply = await tools.browser_read_state.execute({ tabID: "one" }, fakeContext().context)
    const output = typeof reply === "string" ? reply : reply.output
    expect(output).toContain("options for [s4:e0] (truncated)")
    expect(output).toContain("[s4:o1] Same selected=false disabled=true")
    expect(tools.browser_select_option.description).toContain("isTrusted=false")
  })

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

  test("renders normalized states and truncation without losing false values", async () => {
    const browser = fakePort(
      success({
        ...state,
        truncated: true,
        elements: [{ ...state.elements[0], checked: "mixed", selected: false, expanded: true, disabled: true }],
      }),
    )
    const reply = await browserTools(browser.port).browser_read_state.execute({ tabID: "one" }, fakeContext().context)
    const output = typeof reply === "string" ? reply : reply.output
    for (const value of ["checked=mixed", "selected=false", "expanded=true", "disabled=true", "truncated"])
      expect(output).toContain(value)
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
    ["browser_click", { ref: "s4:e0", mode: "double" }],
    ["browser_click", { ref: "s4:e0", mode: "right" }],
    ["browser_drag", { sourceRef: "s4:e0", targetRef: "s4:e1" }],
    ["browser_select_option", { ref: "s4:e0", optionRef: "s4:o1" }],
    ["browser_hover", { ref: "s4:e0" }],
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
    ["browser_click", { ref: "s4:e0", mode: "double" }],
    ["browser_click", { ref: "s4:e0", mode: "right" }],
    ["browser_drag", { sourceRef: "s4:e0", targetRef: "s4:e1" }],
    ["browser_select_option", { ref: "s4:e0", optionRef: "s4:o1" }],
    ["browser_hover", { ref: "s4:e0" }],
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
