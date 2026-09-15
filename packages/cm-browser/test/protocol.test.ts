import { expect, test } from "bun:test"
import {
  DEFAULT_ALLOWLIST,
  MAX_TYPED_TEXT,
  MAX_URL_LENGTH,
  hostAllowed,
  parseBrowserIpcRequest,
  parseRequest,
  stateDirectory,
} from "../src/protocol"

test("parses explicit tab operations and rejects missing IDs and oversized inputs", () => {
  const requests = [
    { op: "list_tabs" },
    { op: "read_state", tabID: "one" },
    { op: "navigate", tabID: "one", url: "https://teams.microsoft.com/" },
    { op: "click", tabID: "one", ref: "one.snapshot:e0" },
    { op: "fill", tabID: "one", ref: "one.snapshot:e0", text: "hi" },
    { op: "press_key", tabID: "one", key: "Enter", modifiers: ["Ctrl"] },
  ] as const
  for (const request of requests) expect(parseRequest(request)).toEqual(request)
  for (const request of [
    { op: "read_state" },
    { op: "evaluate", tabID: "one", code: "1" },
    { op: "navigate", tabID: "one", url: "x".repeat(MAX_URL_LENGTH + 1) },
    { op: "fill", tabID: "one", ref: "ref", text: "x".repeat(MAX_TYPED_TEXT + 1) },
    { op: "press_key", tabID: "one", key: "Enter", modifiers: ["Super"] },
  ])
    expect(parseRequest(request)).toBeUndefined()
  const message = { type: "browser_request", id: "req-1", sessionID: "ses_1", request: requests[1] } as const
  expect(parseBrowserIpcRequest(message)).toEqual(message)
  expect(parseBrowserIpcRequest({ ...message, sessionID: "" })).toBeUndefined()
})

test("host policy allows exact hosts and subdomains, not lookalikes or other schemes", () => {
  expect(hostAllowed("https://teams.microsoft.com/v2/", DEFAULT_ALLOWLIST)).toBe(true)
  expect(hostAllowed("https://eu.teams.microsoft.com/", DEFAULT_ALLOWLIST)).toBe(true)
  expect(hostAllowed("https://notteams.microsoft.com.evil.test/", DEFAULT_ALLOWLIST)).toBe(false)
  expect(hostAllowed("file:///etc/passwd", DEFAULT_ALLOWLIST)).toBe(false)
  expect(stateDirectory({ APPDATA: "C:\\Users\\x\\AppData\\Roaming" }, "win32")).toContain("CookieMonster")
  expect(stateDirectory({ HOME: "/home/x" }, "linux")).toContain(".config")
})
