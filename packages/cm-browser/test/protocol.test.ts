import { expect, test } from "bun:test"
import {
  DEFAULT_ALLOWLIST,
  MAX_TYPED_TEXT,
  MAX_SNAPSHOT_BYTES,
  screenshotBytes,
  screenshotDimensions,
  success,
  MAX_URL_LENGTH,
  hostAllowed,
  parseBrowserIpcRequest,
  parseBrowserIpcCancel,
  parseRequest,
  stateDirectory,
} from "../src/protocol"

test("tab lifecycle requires exact actions, explicit targets and preparation tokens", () => {
  for (const request of [
    { op: "create_tab" },
    { op: "select_tab", tabID: "one" },
    { op: "close_tab", tabID: "one" },
  ] as const) {
    expect(parseRequest({ op: "prepare_tab", request })).toEqual({ op: "prepare_tab", request })
    expect(parseRequest(request)).toBeUndefined()
    expect(parseRequest({ ...request, token: "a".repeat(36) })).toEqual({ ...request, token: "a".repeat(36) })
    for (const token of [undefined, "", 1, "x".repeat(129)]) expect(parseRequest({ ...request, token })).toBeUndefined()
    expect(parseRequest({ op: "prepare_write", request })).toBeUndefined()
    expect(
      parseRequest({ op: "prepare_tab", request: { ...request, url: "https://private.invalid/" } }),
    ).toBeUndefined()
    for (const extra of [
      { url: "https://private.invalid/" },
      { context: {} },
      { sessionID: "other" },
      { unknown: true },
    ]) {
      expect(parseRequest({ op: "prepare_tab", request: { ...request, ...extra } })).toBeUndefined()
      expect(parseRequest({ op: "prepare_tab", request, ...extra })).toBeUndefined()
      expect(parseRequest({ ...request, token: "opaque", ...extra })).toBeUndefined()
    }
    expect(parseRequest({ op: "prepare_tab", request: { ...request, token: "opaque" } })).toBeUndefined()
    for (const token of ["x".repeat(128), "uuid_123-abc"])
      expect(parseRequest({ ...request, token })).toEqual({ ...request, token })
    for (const token of ["https://private.invalid/", "private title", "opaque\\n"])
      expect(parseRequest({ ...request, token })).toBeUndefined()
  }
  for (const tabID of [undefined, "", 1, "x".repeat(129)])
    expect(parseRequest({ op: "prepare_tab", request: { op: "close_tab", tabID } })).toBeUndefined()
  expect(parseRequest({ op: "prepare_tab", request: { op: "create_tab", tabID: "one" } })).toBeUndefined()
})

test("screenshot byte, edge, raster and complete UTF-8 response budgets are exact", () => {
  for (const length of [46_080, 46_081]) {
    const bytes = Buffer.alloc(length)
    bytes.set([255, 216, 255])
    bytes.set([255, 217], length - 2)
    expect(Boolean(screenshotBytes(bytes.toString("base64")))).toBe(length === 46_080)
  }
  for (const value of ["", "!!!!", "/9j/2Q==\\n", "/9j/2R==", Buffer.from("not jpeg").toString("base64")])
    expect(screenshotBytes(value)).toBeUndefined()
  expect(screenshotDimensions(4096, 1024)).toBe(true)
  expect(screenshotDimensions(2048, 2048)).toBe(true)
  for (const pair of [
    [4097, 1],
    [4096, 1025],
    [2048, 2049],
    [0, 1],
    [1.5, 1],
    [NaN, 1],
  ])
    expect(screenshotDimensions(...(pair as [number, number]))).toBe(false)
  const state = {
    tabID: "one",
    url: "http://localhost/",
    title: "",
    visibleText: "",
    elements: [],
    screenshot: { data: "a".repeat(61_440), width: 1, height: 1 },
  }
  const spare = 65_536 - Buffer.byteLength(JSON.stringify({ ok: true, result: state }))
  state.url += "x".repeat(spare)
  expect(success(state).ok).toBe(true)
  expect(success({ ...state, url: state.url + "x" }).ok).toBe(false)
  expect(success({ ...state, url: state.url.slice(0, -1) + "é" }).ok).toBe(false)
})

test("screenshot requires approval binding and exposes no capture controls", () => {
  const request = { op: "screenshot", tabID: "one" } as const
  const context = { tabID: "one", origin: "http://localhost", urlHash: "a".repeat(64), revision: 0, accessRevision: 0 }
  expect(parseRequest({ op: "prepare_write", request })).toEqual({ op: "prepare_write", request })
  expect(parseRequest(request)).toBeUndefined()
  expect(parseRequest({ ...request, context, clip: {}, quality: 100, fullPage: true })).toEqual({ ...request, context })
  for (const tabID of ["", 1, undefined, "x".repeat(129)])
    expect(parseRequest({ op: "prepare_write", request: { ...request, tabID } })).toBeUndefined()
})

test("drag accepts only bounded endpoint refs and retains write binding", () => {
  const request = {
    op: "drag",
    tabID: "one",
    sourceRef: "one.snapshot:source",
    targetRef: "one.snapshot:target",
  } as const
  const context = { tabID: "one", origin: "http://localhost", urlHash: "a".repeat(64), revision: 0, accessRevision: 0 }
  expect(parseRequest({ op: "prepare_write", request })).toEqual({ op: "prepare_write", request })
  expect(parseRequest(request)).toBeUndefined()
  expect(parseRequest({ ...request, context, x: 1, y: 2, steps: 100, duration: 100 })).toEqual({ ...request, context })
  for (const key of ["sourceRef", "targetRef", "tabID"])
    for (const value of [undefined, "", 1, "x".repeat(key === "tabID" ? 129 : 257)])
      expect(parseRequest({ op: "prepare_write", request: { ...request, [key]: value } })).toBeUndefined()
})

test("select_option requires bounded select and option refs with write binding", () => {
  const request = {
    op: "select_option",
    tabID: "one",
    ref: "one.snapshot:select",
    optionRef: "one.snapshot:option",
  } as const
  const context = { tabID: "one", origin: "http://localhost", urlHash: "a".repeat(64), revision: 0, accessRevision: 0 }
  expect(parseRequest({ op: "prepare_write", request })).toEqual({ op: "prepare_write", request })
  expect(parseRequest(request)).toBeUndefined()
  expect(parseRequest({ ...request, context, value: "never forwarded" })).toEqual({ ...request, context })
  for (const key of ["ref", "optionRef", "tabID"])
    for (const value of [undefined, "", 1, "x".repeat(key === "tabID" ? 129 : 257)])
      expect(parseRequest({ op: "prepare_write", request: { ...request, [key]: value } })).toBeUndefined()
})

test("hover and click modes retain write binding and reject malformed input", () => {
  const context = { tabID: "one", origin: "http://localhost", urlHash: "a".repeat(64), revision: 0, accessRevision: 0 }
  const prepare = (request: unknown) => parseRequest({ op: "prepare_write", request })
  for (const request of [
    { op: "hover", tabID: "one", ref: "one.snapshot:e0" } as const,
    ...([undefined, "left", "double", "right"] as const).map(
      (mode) =>
        ({
          op: "click",
          tabID: "one",
          ref: "one.snapshot:e0",
          ...(mode ? { mode } : {}),
        }) as const,
    ),
  ]) {
    expect(prepare(request)).toEqual({ op: "prepare_write", request })
    expect(parseRequest(request)).toBeUndefined()
    expect(parseRequest({ ...request, context })).toEqual({ ...request, context })
    for (const ref of [undefined, "", 1, "x".repeat(257)]) expect(prepare({ ...request, ref })).toBeUndefined()
    for (const tabID of [undefined, "", 1, "x".repeat(129)]) expect(prepare({ ...request, tabID })).toBeUndefined()
  }
  for (const mode of [null, "", "middle", "DOUBLE", 2, {}, []])
    expect(prepare({ op: "click", tabID: "one", ref: "ref", mode })).toBeUndefined()
})

test("scroll and waits require explicit targets and bounded inputs", () => {
  const scroll = { op: "scroll", tabID: "one", deltaX: -2000, deltaY: 2000 } as const
  const prepare = (request: unknown) => parseRequest({ op: "prepare_write", request })
  expect(prepare(scroll)).toEqual({ op: "prepare_write", request: scroll })
  expect(parseRequest(scroll)).toBeUndefined()
  for (const values of [
    { deltaX: 2001 },
    { deltaY: -2001 },
    { deltaX: Infinity },
    { deltaY: NaN },
    { deltaX: 0.5 },
    { deltaX: "1" },
    { deltaX: 0, deltaY: 0 },
    { ref: "" },
    { ref: "x".repeat(257) },
  ])
    expect(prepare({ ...scroll, ...values })).toBeUndefined()
  const waits = [
    { op: "wait_for_element", tabID: "one", selector: "#ready", timeoutMs: 15000 },
    { op: "wait_for_navigation", tabID: "one", url: "http://localhost/done", timeoutMs: 15000 },
  ] as const
  for (const wait of waits) {
    expect(parseRequest(wait)).toEqual(wait)
    expect(prepare(wait)).toBeUndefined()
    for (const timeoutMs of [undefined, 0, -1, 15001, 0.5, Infinity, NaN, "1"])
      expect(parseRequest({ ...wait, timeoutMs })).toBeUndefined()
  }
  for (const input of [...waits, scroll]) {
    const parse = input.op === "scroll" ? prepare : parseRequest
    for (const tabID of [undefined, "", "x".repeat(129)]) expect(parse({ ...input, tabID })).toBeUndefined()
    for (const timeoutMs of [0, -1, 15001, 0.5, Infinity]) expect(parse({ ...input, timeoutMs })).toBeUndefined()
    expect(parse({ ...input, timeoutMs: 1 })).toBeDefined()
  }
  for (const selector of ["", " ", "x".repeat(513)]) expect(parseRequest({ ...waits[0], selector })).toBeUndefined()
  for (const url of ["", "file:///private", "http://localhost/" + "x".repeat(MAX_URL_LENGTH)])
    expect(parseRequest({ ...waits[1], url })).toBeUndefined()
})

test("private cancellation requires bounded request and session identities, never a signal payload", () => {
  const cancel = { type: "browser_cancel", id: "request", sessionID: "session" } as const
  expect(parseBrowserIpcCancel({ ...cancel, signal: {}, request: {} })).toEqual(cancel)
  expect(parseBrowserIpcRequest(cancel)).toBeUndefined()
  for (const invalid of [null, [], {}, { ...cancel, id: "" }, { ...cancel, sessionID: 42 }])
    expect(parseBrowserIpcCancel(invalid)).toBeUndefined()
  for (const key of ["id", "sessionID"])
    for (const length of [128, 129]) {
      const input = { ...cancel, [key]: "x".repeat(length) }
      expect(Boolean(parseBrowserIpcCancel(input))).toBe(length === 128)
      expect(Boolean(parseBrowserIpcRequest({ ...input, type: "browser_request", request: { op: "list_tabs" } }))).toBe(
        length === 128,
      )
    }
})

test("success bounds complete UTF-8 response JSON without truncating identities", () => {
  const overhead = Buffer.byteLength(JSON.stringify({ ok: true, result: "" }))
  const exact = "x".repeat(MAX_SNAPSHOT_BYTES - overhead)
  expect(success(exact)).toEqual({ ok: true, result: exact })
  for (const result of [
    exact + "x",
    "\u4e2d".repeat(MAX_SNAPSHOT_BYTES / 2),
    "\n".repeat(MAX_SNAPSHOT_BYTES / 2),
    { tabs: [{ url: exact }, { url: exact }] },
    { history: [{ url: exact, title: "" }] },
  ]) {
    const response = success(result)
    expect(response).toMatchObject({ ok: false, code: "unavailable" })
    expect(Buffer.byteLength(JSON.stringify(response))).toBeLessThanOrEqual(MAX_SNAPSHOT_BYTES)
  }
})

test("parses explicit tab operations and rejects missing IDs and oversized inputs", () => {
  const requests = [
    { op: "list_tabs" },
    { op: "read_state", tabID: "one" },
    { op: "navigate", tabID: "one", url: "https://teams.microsoft.com/" },
    { op: "click", tabID: "one", ref: "one.snapshot:e0" },
    { op: "fill", tabID: "one", ref: "one.snapshot:e0", text: "hi" },
    { op: "press_key", tabID: "one", key: "Enter", modifiers: ["Ctrl"] },
  ] as const
  const context = { tabID: "one", origin: "http://localhost", urlHash: "a".repeat(64), revision: 0, accessRevision: 0 }
  for (const request of requests) {
    if (request.op === "read_state" || request.op === "list_tabs") {
      expect(parseRequest(request)).toEqual(request)
      continue
    }
    expect(parseRequest(request)).toBeUndefined()
    expect(parseRequest({ ...request, context })).toEqual({ ...request, context })
    expect(parseRequest({ op: "prepare_write", request })).toEqual({ op: "prepare_write", request })
  }
  for (const request of [
    { op: "read_state" },
    { op: "evaluate", tabID: "one", code: "1" },
    { op: "navigate", tabID: "one", url: "x".repeat(MAX_URL_LENGTH + 1) },
    { op: "fill", tabID: "one", ref: "ref", text: "x".repeat(MAX_TYPED_TEXT + 1) },
    { op: "press_key", tabID: "one", key: "Enter", modifiers: ["Super"] },
  ])
    expect(parseRequest({ ...request, context })).toBeUndefined()
  const message = { type: "browser_request", id: "req-1", sessionID: "ses_1", request: requests[1] } as const
  expect(parseBrowserIpcRequest(message)).toEqual(message)
  expect(parseBrowserIpcRequest({ ...message, sessionID: "" })).toBeUndefined()
})

test("write contexts are runtime-validated and survive IPC parsing", () => {
  const context = { tabID: "one", origin: "http://localhost", urlHash: "a".repeat(64), revision: 0, accessRevision: 0 }
  const request = { op: "press_key", tabID: "one", key: "Enter", modifiers: [], context } as const
  const message = { type: "browser_request", id: "req", sessionID: "session", request } as const
  expect(parseBrowserIpcRequest(message)).toEqual(message)
  for (const invalid of [
    undefined,
    null,
    [],
    {},
    { ...context, tabID: "" },
    { ...context, tabID: "x".repeat(129) },
    { ...context, origin: "file:///private" },
    { ...context, origin: "http://localhost/" + "x".repeat(MAX_URL_LENGTH) },
    { ...context, origin: "http://localhost/path" },
    { ...context, origin: "http://user:secret@localhost" },
    { ...context, urlHash: undefined },
    { ...context, urlHash: "a".repeat(63) },
    { ...context, urlHash: "g".repeat(64) },
    { ...context, revision: -1 },
    { ...context, revision: 0.5 },
    { ...context, revision: "0" },
    { ...context, accessRevision: NaN },
    { ...context, accessRevision: Number.MAX_SAFE_INTEGER + 1 },
  ])
    expect(parseRequest({ ...request, context: invalid })).toBeUndefined()
  for (const input of [
    { op: "read_state", tabID: "one" },
    { op: "prepare_write", request },
    { ...request, modifiers: ["Super"] },
  ])
    expect(parseRequest({ op: "prepare_write", request: input })).toBeUndefined()
})

test("host policy allows exact hosts and subdomains, not lookalikes or other schemes", () => {
  expect(hostAllowed("https://teams.microsoft.com/v2/", DEFAULT_ALLOWLIST)).toBe(true)
  expect(hostAllowed("https://eu.teams.microsoft.com/", DEFAULT_ALLOWLIST)).toBe(true)
  expect(hostAllowed("https://notteams.microsoft.com.evil.test/", DEFAULT_ALLOWLIST)).toBe(false)
  expect(hostAllowed("file:///etc/passwd", DEFAULT_ALLOWLIST)).toBe(false)
  expect(stateDirectory({ APPDATA: "C:\\Users\\x\\AppData\\Roaming" }, "win32")).toContain("CookieMonster")
  expect(stateDirectory({ HOME: "/home/x" }, "linux")).toContain(".config")
})

test("history requests validate result bounds and date ranges without requiring a tab", () => {
  expect(parseRequest({ op: "search_history", query: "guide", limit: 20, from: 0, to: 100 })).toEqual({
    op: "search_history",
    query: "guide",
    limit: 20,
    from: 0,
    to: 100,
  })
  for (const values of [
    { limit: 21 },
    { limit: 0 },
    { from: 200, to: 100 },
    { from: -1 },
    { to: 9e15 },
    { query: "x".repeat(257) },
  ])
    expect(parseRequest({ op: "search_history", query: "", limit: 10, ...values })).toBeUndefined()
  expect(parseRequest({ op: "open_history", ref: "" })).toBeUndefined()
  expect(parseRequest({ op: "open_history", ref: "opaque" })).toEqual({ op: "open_history", ref: "opaque" })
})
