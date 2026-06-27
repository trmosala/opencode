import { describe, expect, test } from "bun:test"
import {
  formatBrowserElementContext,
  formatBrowserSelectionContext,
  formatBrowserUrlContext,
  normalizeBrowserUrl,
} from "./browser-context"

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
