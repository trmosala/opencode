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
  test("desktop panel validates before approval and returns only the matching native result", async () => {
    for (const args of [
      { view: "browser", tabID: "one" }, { view: "review" }, { view: "hidden" },
    ] as const) {
      const panelResult = { ...args, browserReady: args.view === "browser" }
      const browser = fakePort(success({
        tabID: "", url: "", title: "", visibleText: "", elements: [], panelResult,
      } as BrowserState))
      const call = fakeContext()
      expect(await browserTools(browser.port).desktop_set_panel.execute(args, call.context))
        .toBe(JSON.stringify(panelResult))
      expect(browser.sent).toEqual([{ sessionID: "ses_1", request: { op: "set_panel", ...args } }])
      expect(call.asked).toEqual([{ permission: "desktop_set_panel", patterns: ["*"] }])
    }
    for (const args of [
      {}, { view: "browser" }, { view: "browser", tabID: "../one" }, { view: "files" },
      { view: "review", tabID: "one" }, { view: "hidden", tabID: undefined },
      { view: "hidden", op: "set_panel" }, { view: "review", unknown: true },
    ]) {
      const browser = fakePort()
      const call = fakeContext()
      await expect(browserTools(browser.port).desktop_set_panel.execute(args, call.context)).rejects.toThrow()
      expect(browser.sent).toEqual([])
      expect(call.asked).toEqual([])
    }
    for (const result of [
      {}, { panelResult: { view: "review", browserReady: false } },
      { panelResult: { view: "browser", tabID: "other", browserReady: true } },
      { panelResult: { view: "browser", tabID: "one", browserReady: false } },
      { panelResult: { view: "browser", tabID: "one", browserReady: true, private: "data" } },
      { panelResult: { view: "browser", tabID: "one", browserReady: true }, title: "private" },
    ]) {
      const browser = fakePort(success({
        tabID: "", url: "", title: "", visibleText: "", elements: [], ...result,
      } as BrowserState))
      await expect(browserTools(browser.port).desktop_set_panel.execute(
        { view: "browser", tabID: "one" }, fakeContext().context,
      )).rejects.toThrow("Invalid desktop panel result.")
      expect(browser.sent).toHaveLength(1)
    }
  })

  test("desktop panel checks denial and abort around approval and dispatch", async () => {
    for (const stage of ["before", "deny", "approval", "dispatch"]) {
      const controller = new AbortController()
      const call = fakeContext()
      call.context.abort = controller.signal
      let approvals = 0
      let sends = 0
      call.context.ask = async () => {
        approvals++
        if (stage === "deny") throw new Error("Denied")
        if (stage === "approval") controller.abort()
      }
      if (stage === "before") controller.abort()
      const tools = browserTools({
        send: async (_sessionID, _request, signal) => {
          sends++
          expect(signal).toBe(controller.signal)
          if (stage === "dispatch") controller.abort()
          return success({
            tabID: "", url: "", title: "", visibleText: "", elements: [],
            panelResult: { view: "hidden", browserReady: false },
          })
        },
      })
      await expect(tools.desktop_set_panel.execute({ view: "hidden" }, call.context)).rejects.toThrow()
      expect(approvals).toBe(stage === "before" ? 0 : 1)
      expect(sends).toBe(stage === "dispatch" ? 1 : 0)
    }
  })

  test("renders embedded content, omissions and the actual targeted wait condition", async () => {
    const observed = {
      ...state,
      inspection: { selector: "#week", matched: true },
      observedCondition: { selector: "#week", condition: "attached" as const },
      documents: [
        {
          frameRef: "a".repeat(36),
          origin: "https://calendar.example",
          url: "https://calendar.example/week",
          title: "Calendar",
          status: "truncated" as const,
          visibleText: "Synthetic appointment",
          omissions: ["element_limit"],
          elements: [{ ...state.elements[0], ref: "frame.test:open", label: "Open appointment" }],
        },
      ],
    }
    const fixture = fakePort(success(observed))
    const output = await browserTools(fixture.port).browser_read_state.execute({ tabID: "one" }, fakeContext().context)
    if (typeof output === "string") throw new Error("Expected structured browser result")
    expect(output.output).toContain("Synthetic appointment")
    expect(output.output).toContain("[frame.test:open]")
    expect(output.output).toContain("truncated")
    expect(output.output).toContain("omission: element_limit")
    expect(output.output).toContain("inspection: #week; matched=true")
    expect(output.output).toContain("observed condition: #week; attached")
  })

  test("embedded input retains exact action and consumes only main's native frame preparation", async () => {
    const frameRef = "a".repeat(36)
    const frameContext = {
      frameRef,
      approval: "b".repeat(36),
      topOrigin: "https://teams.microsoft.com",
      origin: "null",
    }
    const sent: Request[] = []
    const port: BrowserPort = {
      send: async (sessionID, request) => {
        sent.push(request)
        return request.op === "prepare_frame_input"
          ? success({ ...state, frameContext })
          : success({ ...state, frameRef })
      },
    }
    const context = fakeContext()
    const ref = `frame.${"c".repeat(36)}:target`
    await browserTools(port).browser_fill.execute(
      { tabID: "one", frameRef, ref, text: "Synthetic note" },
      context.context,
    )
    expect(sent).toEqual([
      { op: "prepare_frame_input", tabID: "one", frameRef, action: { op: "fill", ref, text: "Synthetic note" } },
      { op: "frame_input", tabID: "one", frameRef, frameContext, action: { op: "fill", ref, text: "Synthetic note" } },
    ])
    expect(context.asked).toEqual([])
  })
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

  test("frame selection uses tab authority, preserves refs and rejects aborts or forged inputs", async () => {
    const args = {
      tabID: "one",
      frameRef: "a".repeat(36),
      ref: `frame.${"b".repeat(36)}:select`,
      optionRef: `frame.${"b".repeat(36)}:option`,
    }
    for (const abort of [false, true]) {
      const frameContext = {
        frameRef: args.frameRef,
        approval: "c".repeat(36),
        topOrigin: "https://top.test:8443",
        origin: "https://child.test:9443",
      }
      const sent: Request[] = []
      const call = fakeContext()
      const controller = new AbortController()
      call.context.abort = controller.signal
      call.context.ask = async () => {
        throw new Error("Redundant approval")
      }
      const tools = browserTools({
        send: async (_session, request) => {
          sent.push(request)
          if (abort) controller.abort()
          return success({ ...state, frameContext })
        },
      })
      const response = await tools.browser_select_option.execute(args, call.context).catch((error: unknown) => error)
      expect(response instanceof Error).toBe(abort)
      expect(sent).toHaveLength(abort ? 1 : 2)
      if (!abort)
        expect(sent[1]).toEqual({
          op: "frame_input",
          tabID: args.tabID,
          frameRef: args.frameRef,
          frameContext,
          action: { op: "select_option", ref: args.ref, optionRef: args.optionRef },
        })
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

  test("screenshot uses tab authority and only attachment pixels, rejecting invalid results", async () => {
    const image = { data: Buffer.from([255, 216, 255, 217]).toString("base64"), width: 1, height: 1 }
    const value = { ...state, title: "", visibleText: "", elements: [], screenshot: image }
    const browser = fakePort(success(value))
    const call = fakeContext()
    const reply = await browserTools(browser.port).browser_screenshot.execute({ tabID: "one" }, call.context)
    expect(call.asked).toEqual([])
    expect(browser.sent.map((item) => item.request.op)).toEqual(["prepare_write", "screenshot"])
    expect(browser.sent[1].request).toMatchObject({ context: state.context })
    expect(reply).toEqual({
      output: `Screenshot 1x1; tab one; source ${state.url}`,
      attachments: [{ type: "file", mime: "image/jpeg", url: `data:image/jpeg;base64,${image.data}` }],
    })
    for (const metadata of [
      { visualRef: "a".repeat(36) },
      { actionUnavailable: "Animated layout cannot bind visual input." },
    ]) {
      const observed = fakePort(
        success({
          ...value,
          screenshot: { ...image, ...metadata, viewportWidth: 2, viewportHeight: 2, scaleX: 0.5, scaleY: 0.5 },
        }),
      )
      const result = await browserTools(observed.port).browser_screenshot.execute(
        { tabID: "one" },
        fakeContext().context,
      )
      if (typeof result === "string") throw new Error("Expected screenshot attachment")
      expect(result.output).toContain("viewport 2x2; scale 0.5,0.5")
      expect(result.output).toContain("visualRef" in metadata ? "visualRef" : "visual action unavailable")
    }
    for (const screenshot of [
      undefined,
      { ...image, data: "" },
      { ...image, data: "bad!" },
      { ...image, width: 4097 },
      { ...image, width: 4096, height: 4096 },
      { ...image, visualRef: "a".repeat(36), viewportWidth: 2, viewportHeight: 2, scaleX: NaN, scaleY: 0.5 },
      { ...image, viewportWidth: 2, viewportHeight: 2, scaleX: 0.5, scaleY: 0.5 },
    ]) {
      const invalid = fakePort(success({ ...value, screenshot }))
      await expect(
        browserTools(invalid.port).browser_screenshot.execute({ tabID: "one" }, fakeContext().context),
      ).rejects.toThrow("Invalid browser screenshot")
    }
    const denied = fakePort(failure("access_denied", "Tab grant revoked"))
    await expect(
      browserTools(denied.port).browser_screenshot.execute({ tabID: "one" }, fakeContext().context),
    ).rejects.toThrow("Tab grant revoked")
    expect(denied.sent.map((item) => item.request.op)).toEqual(["prepare_write"])
  })

  test("console observation uses tab authority and returns only bounded severity counts", async () => {
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
    expect(call.asked).toEqual([])
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

  test("network observation uses tab authority, exact counts and no payload output", async () => {
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
    expect(call.asked).toEqual([])
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
    const denied = fakePort(failure("access_denied", "Tab grant revoked"))
    await expect(
      browserTools(denied.port).browser_observe_network.execute({ tabID: "one" }, fakeContext().context),
    ).rejects.toThrow("Tab grant revoked")
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
    expect(call.asked).toEqual([])
    expect(browser.sent.map((item) => item.request)).toEqual([{ op: "list_site_tools", tabID: "one" }])
    if (typeof reply === "string") throw new Error("Expected structured site-tool discovery result")
    expect(reply.output).toContain("untrusted site-provided WebMCP metadata")
    expect(reply.output).toContain('"name":"search"')
  })

  test("site-tool execution binds preparation without per-origin approval", async () => {
    const toolRef = "a".repeat(8) + "-aaaa-4aaa-8aaa-" + "a".repeat(12)
    const siteToolContext = {
      ...state.context,
      toolRef,
      toolRevision: 4,
      argumentHash: "b".repeat(64),
    }
    const sent: Request[] = []
    const call = fakeContext()
    call.context.ask = async () => {
      throw new Error("Redundant approval")
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
    expect(call.asked).toEqual([])
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
  ] as const)("%s keeps task identity and abort without redundant approval", async (name, args) => {
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
    expect(call.asked).toEqual([])
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
      expect(call.asked).toEqual([])
      expect(browser.sent.at(-1)?.request).toMatchObject({ context: state.context })
    }
    controller.abort()
    const count = browser.sent.length
    await expect(tools[name].execute({ tabID: "one", ...args }, call.context)).rejects.toThrow()
    expect(browser.sent).toHaveLength(count)
  })

  test("click explains uncertain dispatch and labels a refreshed observation", async () => {
    const call = fakeContext()
    const uncertain: BrowserPort = {
      send: async (_sessionID, request) =>
        request.op === "prepare_write"
          ? success(state)
          : {
              ok: false,
              code: "unavailable",
              error: "Browser operation interrupted or unavailable.",
              actionStatus: "dispatched_uncertain",
            },
    }
    await expect(
      browserTools(uncertain).browser_click.execute({ tabID: "one", ref: "s4:e0" }, call.context),
    ).rejects.toThrow("observe the current tab state before sending further input")

    const observed: BrowserPort = {
      send: async (_sessionID, request) =>
        request.op === "prepare_write" ? success(state) : success({ ...state, actionStatus: "dispatched_observed" }),
    }
    const reply = await browserTools(observed).browser_click.execute({ tabID: "one", ref: "s4:e0" }, call.context)
    if (typeof reply === "string") throw new Error("Expected browser result")
    expect(reply.output).toContain("action status: dispatched_observed")
  })

  test.each(["before", "prepare_write", "press_key"])("abort during %s prevents further dispatch", async (stage) => {
    const call = fakeContext()
    const controller = new AbortController()
    call.context.abort = controller.signal
    const sent: Request[] = []
    const port: BrowserPort = {
      send: async (_session, request) => {
        sent.push(request)
        if (request.op === stage) controller.abort()
        return success(state)
      },
    }
    if (stage === "before") controller.abort()
    await expect(
      browserTools(port).browser_press_key.execute({ tabID: "one", key: "Enter" }, call.context),
    ).rejects.toThrow()
    expect(sent).toHaveLength(stage === "before" ? 0 : stage === "prepare_write" ? 1 : 2)
    expect(call.asked).toEqual([])
  })

  test("navigation uses the tab grant across receiving origins without approval", async () => {
    const browser = fakePort()
    const call = fakeContext()
    call.context.ask = async () => {
      throw new Error("Redundant approval")
    }
    await browserTools(browser.port).browser_navigate.execute(
      { tabID: "one", url: "https://destination.test/" },
      call.context,
    )
    expect(browser.sent.map(({ request }) => request.op)).toEqual(["prepare_write", "navigate"])
    expect(browser.sent[1].request).toEqual({
      op: "navigate",
      tabID: "one",
      url: "https://destination.test/",
      context: state.context,
    })
  })

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
    expect(call.asked).toEqual([])
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

  test("writes retain explicit tab identity without permission prompts", async () => {
    const browser = fakePort()
    const tools = browserTools(browser.port)
    const click = fakeContext("ses_click")
    await tools.browser_click.execute({ tabID: "one", ref: "s4:e0" }, click.context)
    expect(click.asked).toEqual([])

    const key = fakeContext("ses_key")
    await tools.browser_press_key.execute({ tabID: "one", key: "Enter", ctrl: true }, key.context)
    expect(browser.sent.at(-1)?.request).toEqual({
      tabID: "one",
      op: "press_key",
      key: "Enter",
      modifiers: ["Ctrl"],
      context: state.context,
    })
    expect(key.asked).toEqual([])
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
  ] as const)("%s retains the context captured before deferred preparation settles", async (name, args) => {
    const browser = fakePort()
    const call = fakeContext()
    const waiting = Promise.withResolvers<void>()
    const approval = Promise.withResolvers<void>()
    const port: BrowserPort = {
      send: async (sessionID, request, signal) => {
        const response = await browser.port.send(sessionID, request, signal)
        waiting.resolve()
        await approval.promise
        return response
      },
    }
    call.context.ask = async () => {
      throw new Error("Redundant approval")
    }
    const pending = browserTools(port)[name].execute({ tabID: "one", ...args }, call.context)
    try {
      await waiting.promise
      expect(browser.sent).toHaveLength(1)
      expect(browser.sent[0].request.op).toBe("prepare_write")
      expect(call.asked).toEqual([])
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
  ] as const)("%s cannot dispatch after an aborted deferred preparation answers late", async (name, args) => {
    const browser = fakePort()
    const call = fakeContext()
    const controller = new AbortController()
    const waiting = Promise.withResolvers<void>()
    const approval = Promise.withResolvers<void>()
    call.context.abort = controller.signal
    const port: BrowserPort = {
      send: async (sessionID, request, signal) => {
        const response = await browser.port.send(sessionID, request, signal)
        waiting.resolve()
        await approval.promise
        return response
      },
    }
    const tools = browserTools(port)
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

  test("missing or malformed main context fails before write dispatch", async () => {
    for (const context of [undefined, { ...state.context, revision: -1 }, { ...state.context, tabID: "other" }]) {
      const browser = fakePort(success({ ...state, context } as BrowserState))
      const call = fakeContext()
      await expect(
        browserTools(browser.port).browser_press_key.execute({ tabID: "one", key: "Enter" }, call.context),
      ).rejects.toThrow(/document context/)
      expect(browser.sent).toHaveLength(1)
      expect(call.asked).toEqual([])
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
