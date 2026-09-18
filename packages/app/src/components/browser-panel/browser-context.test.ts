import { describe, expect, test } from "bun:test"
import {
  formatBrowserElementContext,
  formatBrowserSelectionContext,
  formatBrowserUrlContext,
  browserSearchTemplate,
  normalizeBrowserUrl,
  resolveBrowserAddress,
} from "./browser-context"
import { browserSearchEngine } from "@/browser-panel"

describe("normalizeBrowserUrl", () => {
  test("defaults bare addresses to http", () => {
    expect(normalizeBrowserUrl("localhost:5173")).toBe("http://localhost:5173/")
  })

  test("keeps http and https URLs", () => {
    expect(normalizeBrowserUrl("https://example.com/path")).toBe("https://example.com/path")
    expect(normalizeBrowserUrl("http://example.com")).toBe("http://example.com/")
  })

  test("rejects non-web and malformed URLs", () => {
    expect(normalizeBrowserUrl("file:///tmp/a.html")).toBeUndefined()
    expect(normalizeBrowserUrl("javascript:alert(1)")).toBeUndefined()
    expect(normalizeBrowserUrl("data:text/html,hello")).toBeUndefined()
    expect(normalizeBrowserUrl("http://")).toBeUndefined()
    expect(normalizeBrowserUrl("")).toBeUndefined()
  })
})

describe("resolveBrowserAddress", () => {
  test("searches words and phrases through duck.com with query encoding", () => {
    expect(resolveBrowserAddress("cookies")).toBe("https://duck.com/?q=cookies")
    expect(resolveBrowserAddress("  cookies & cream #1  ")).toBe("https://duck.com/?q=cookies+%26+cream+%231")
    expect(new URL(resolveBrowserAddress("site:example.com cookies")!).searchParams.get("q")).toBe(
      "site:example.com cookies",
    )
  })

  test("uses validated explicit engines without changing direct navigation", () => {
    expect(resolveBrowserAddress("cookies & cream #1", "google")).toBe(
      "https://www.google.com/search?q=cookies+%26+cream+%231",
    )
    expect(resolveBrowserAddress("cookies & cream #1", "bing")).toBe(
      "https://www.bing.com/search?q=cookies+%26+cream+%231",
    )
    for (const engine of ["duckduckgo", "google", "bing"] as const) {
      expect(resolveBrowserAddress("localhost:5173/a", engine)).toBe("http://localhost:5173/a")
      expect(resolveBrowserAddress("https://example.com/a", engine)).toBe("https://example.com/a")
    }
  })

  test("preserves direct URLs, bare domains, and local development addresses", () => {
    expect(resolveBrowserAddress("https://example.com/a?q=b")).toBe("https://example.com/a?q=b")
    expect(resolveBrowserAddress("example.com/path")).toBe("http://example.com/path")
    expect(resolveBrowserAddress("localhost:5173?test=1")).toBe("http://localhost:5173/?test=1")
    expect(resolveBrowserAddress("127.0.0.1:8787/status")).toBe("http://127.0.0.1:8787/status")
    expect(resolveBrowserAddress("[::1]:5173")).toBe("http://[::1]:5173/")
    expect(resolveBrowserAddress("about:blank")).toBe("about:blank")
  })

  test("keeps blank, malformed explicit URLs and non-web schemes out of navigation", () => {
    expect(resolveBrowserAddress("   ")).toBeUndefined()
    expect(resolveBrowserAddress("http://")).toBeUndefined()
    expect(resolveBrowserAddress("javascript:alert(1)")).toBeUndefined()
    expect(resolveBrowserAddress("file:///tmp/a.html")).toBeUndefined()
    expect(resolveBrowserAddress("https://user:password@example.com")).toBeUndefined()
  })
})

test("search templates require HTTPS, no credentials or fragments, and one safe query parameter", () => {
  expect(browserSearchTemplate({ url: "https://search.example/path", parameter: "query" })).toEqual({
    url: "https://search.example/path",
    parameter: "query",
  })
  for (const value of [
    undefined,
    {},
    { url: "http://search.example", parameter: "q" },
    { url: "https://user:secret@search.example", parameter: "q" },
    { url: "https://search.example/#fragment", parameter: "q" },
    { url: "https://search.example/?q=existing", parameter: "q" },
    { url: "https://search.example", parameter: "q[]" },
  ])
    expect(browserSearchTemplate(value)).toBeUndefined()
})

test("missing, legacy DuckDuckGo, and invalid persisted values migrate to the default", () => {
  expect(browserSearchEngine(undefined)).toBe("duckduckgo")
  expect(browserSearchEngine("duck.com")).toBe("duckduckgo")
  expect(browserSearchEngine("duckduckgo.com")).toBe("duckduckgo")
  expect(browserSearchEngine("unknown")).toBe("duckduckgo")
  expect(browserSearchEngine("google")).toBe("google")
})

describe("browser context formatting", () => {
  test("formats URL context with title when present", () => {
    expect(formatBrowserUrlContext({ title: "Docs", url: "https://example.com" })).toBe(
      "Browser URL:\nDocs\nhttps://example.com",
    )
  })

  test("formats selected text with source", () => {
    expect(formatBrowserSelectionContext({ title: "Docs", url: "https://example.com" }, "  hello  ")).toBe(
      "Browser selection from Docs:\nhttps://example.com\n\nhello",
    )
  })

  test("returns undefined for empty selected text", () => {
    expect(formatBrowserSelectionContext({ url: "https://example.com" }, "  ")).toBeUndefined()
  })

  test("formats picked element context", () => {
    expect(
      formatBrowserElementContext(
        { title: "App", url: "https://example.com" },
        { tag: "button", label: "Save", text: "Save project" },
      ),
    ).toBe("Browser element from App:\nhttps://example.com\n\nLabel: Save\nElement: button\nText:\nSave project")
  })

  test("formats picked element with all fields in declared order", () => {
    expect(
      formatBrowserElementContext(
        { title: "App", url: "https://example.com" },
        { tag: "input", role: "textbox", label: "Email", id: "email", className: "field lg", text: "a@b.com" },
      ),
    ).toBe(
      "Browser element from App:\nhttps://example.com\n\nLabel: Email\nRole: textbox\nElement: input\nID: email\nClass: field lg\nText:\na@b.com",
    )
  })

  test("returns undefined for empty picked element", () => {
    expect(formatBrowserElementContext({ url: "https://example.com" }, undefined)).toBeUndefined()
  })
})
