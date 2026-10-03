import { expect, test } from "bun:test"
import { parseRequest } from "@cookiemonster/cm-browser/protocol"
import { browserNavigationURL, browserURL, MAX_BROWSER_NAVIGATION_URL_LENGTH } from "./policy"

test("native authentication navigation keeps the separate agent destination bound", () => {
  const prefix = "https://teams.microsoft.com/v2/authv2?state="
  const url = (length: number) => prefix + "x".repeat(length - prefix.length)
  expect(browserURL(url(2048))).toBe(true)
  for (const length of [2049, 2096, 8192, MAX_BROWSER_NAVIGATION_URL_LENGTH]) {
    expect(browserNavigationURL(url(length))).toBe(true)
    expect(browserURL(url(length))).toBe(false)
    expect(parseRequest({ op: "navigate", tabID: "tab", url: url(length) })).toBeUndefined()
  }
  expect(browserNavigationURL(url(MAX_BROWSER_NAVIGATION_URL_LENGTH + 1))).toBe(false)
})

test("native navigation preserves scheme, authority and credential restrictions", () => {
  expect(browserNavigationURL("about:blank")).toBe(true)
  expect(browserNavigationURL("http://localhost:3000/")).toBe(true)
  expect(browserNavigationURL("https://example.test/path")).toBe(true)
  for (const value of [
    undefined,
    {},
    "https://",
    "javascript:alert(1)",
    "file:///tmp/a",
    "data:text/html,x",
    "oc://renderer/",
    "https://user:pass@example.test/",
    "https://user@example.test/",
    `https://${"x".repeat(2048)}.test/path`,
  ])
    expect(browserNavigationURL(value)).toBe(false)
})

test("native navigation bounds the canonical URL before bookmarks can persist it", () => {
  const expanded = `https://example.test/${"é".repeat(12000)}`
  expect(expanded.length).toBeLessThan(MAX_BROWSER_NAVIGATION_URL_LENGTH)
  expect(new URL(expanded).href.length).toBeGreaterThan(MAX_BROWSER_NAVIGATION_URL_LENGTH)
  expect(browserNavigationURL(expanded)).toBe(false)
  const supported = `https://example.test/${"é".repeat(10000)}`
  expect(browserNavigationURL(supported)).toBe(true)
  expect(browserNavigationURL(new URL(supported).href)).toBe(true)
})
