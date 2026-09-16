import { expect, test } from "bun:test"
import {
  DEFAULT_ALLOWLIST,
  MAX_TYPED_TEXT,
  MAX_SNAPSHOT_BYTES,
  success,
  MAX_URL_LENGTH,
  hostAllowed,
  parseBrowserIpcRequest,
  parseRequest,
  stateDirectory,
} from "../src/protocol"

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
