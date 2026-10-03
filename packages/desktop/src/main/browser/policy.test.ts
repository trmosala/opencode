import { expect, test } from "bun:test"
import { parseRequest } from "@cookiemonster/cm-browser/protocol"
import { browserNavigationURL, browserURL, MAX_BROWSER_NAVIGATION_URL_LENGTH } from "./policy"

test("browser navigation accepts long Teams redirects without widening agent inputs", () => {
  const prefix = "https://teams.microsoft.com/v2/authv2?state="
  const url = prefix + "x".repeat(2096 - prefix.length)
  expect(browserNavigationURL(url)).toBe(true)
  expect(browserURL(url)).toBe(false)
  expect(parseRequest({ op: "navigate", tabID: "tab", url })).toBeUndefined()
  expect(browserURL(prefix + "x".repeat(2048 - prefix.length))).toBe(true)
  expect(browserNavigationURL(prefix + "x".repeat(MAX_BROWSER_NAVIGATION_URL_LENGTH - prefix.length))).toBe(true)
  expect(browserNavigationURL(prefix + "x".repeat(MAX_BROWSER_NAVIGATION_URL_LENGTH + 1 - prefix.length))).toBe(false)
})

test("navigation retains scheme and embedded-credential restrictions", () => {
  expect(browserNavigationURL("about:blank")).toBe(true)
  expect(browserNavigationURL("http://localhost:3000/")).toBe(true)
  for (const url of [
    undefined,
    {},
    "https://",
    "javascript:alert(1)",
    "file:///tmp/a",
    "data:text/html,x",
    "oc://renderer/",
    "https://user:pass@example.com/",
  ])
    expect(browserNavigationURL(url)).toBe(false)
})
