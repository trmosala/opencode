import { describe, expect, test } from "bun:test"
import {
  DEFAULT_ALLOWLIST,
  MAX_TYPED_TEXT,
  MAX_URL_LENGTH,
  hostAllowed,
  parseBrowserIpcRequest,
  parseRequest,
  stateDirectory,
} from "../src/protocol"

describe("browser protocol", () => {
  test("parses every supported operation", () => {
    expect(parseRequest({ op: "read_state" })).toEqual({ op: "read_state" })
    expect(parseRequest({ op: "navigate", url: "https://teams.microsoft.com/" })).toEqual({
      op: "navigate",
      url: "https://teams.microsoft.com/",
    })
    expect(parseRequest({ op: "click", ref: "s4:e12" })).toEqual({ op: "click", ref: "s4:e12" })
    expect(parseRequest({ op: "fill", ref: "s4:e12", text: "hi" })).toEqual({
      op: "fill",
      ref: "s4:e12",
      text: "hi",
    })
    expect(parseRequest({ op: "press_key", key: "Enter", modifiers: ["Ctrl"] })).toEqual({
      op: "press_key",
      key: "Enter",
      modifiers: ["Ctrl"],
    })
  })

  test("rejects unsupported operations and oversized inputs", () => {
    expect(parseRequest({ op: "evaluate", code: "1" })).toBeUndefined()
    expect(parseRequest({ op: "navigate", url: "x".repeat(MAX_URL_LENGTH + 1) })).toBeUndefined()
    expect(parseRequest({ op: "fill", ref: "s1:e0", text: "x".repeat(MAX_TYPED_TEXT + 1) })).toBeUndefined()
    expect(parseRequest({ op: "press_key", key: "Enter", modifiers: ["Super"] })).toBeUndefined()
  })

  test("parses correlated session requests", () => {
    expect(
      parseBrowserIpcRequest({
        type: "browser_request",
        id: "req-1",
        sessionID: "ses_1",
        request: { op: "read_state" },
      }),
    ).toMatchObject({ id: "req-1", sessionID: "ses_1", request: { op: "read_state" } })
    expect(parseBrowserIpcRequest({ type: "browser_request", id: "", sessionID: "ses_1" })).toBeUndefined()
  })
})

describe("host policy", () => {
  test("allows exact hosts and subdomains, but not lookalikes or other schemes", () => {
    expect(hostAllowed("https://teams.microsoft.com/v2/", DEFAULT_ALLOWLIST)).toBe(true)
    expect(hostAllowed("https://eu.teams.microsoft.com/", DEFAULT_ALLOWLIST)).toBe(true)
    expect(hostAllowed("https://notteams.microsoft.com.evil.test/", DEFAULT_ALLOWLIST)).toBe(false)
    expect(hostAllowed("file:///etc/passwd", DEFAULT_ALLOWLIST)).toBe(false)
  })

  test("resolves the per-platform policy directory", () => {
    expect(stateDirectory({ APPDATA: "C:\\Users\\x\\AppData\\Roaming" }, "win32")).toContain("CookieMonster")
    expect(stateDirectory({ HOME: "/home/x" }, "linux")).toContain(".config")
  })
})
