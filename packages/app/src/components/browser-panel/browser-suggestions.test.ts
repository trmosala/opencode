import { expect, test } from "bun:test"
import { browserTabKeyIndex } from "@/browser-panel"
import { browserSuggestions } from "./browser-suggestions"
import type { BrowserTabs } from "@/browser-panel"

test("suggestions prefer existing tabs, deduplicate URLs, and match titles without remote requests", () => {
  const state: BrowserTabs = {
    sessionID: "test",
    tabs: [
      {
        id: "tab",
        pinned: false,
        url: "https://example.com/work",
        title: "My work",
        loading: false,
        canGoBack: false,
        canGoForward: false,
        agentAccess: false,
        loadFailed: false,
      },
    ],
    profile: {
      history: [
        { url: "https://example.com/work", title: "Older work", time: 1 },
        { url: "https://example.com/other", title: "WORK notes", time: 2 },
      ],
      bookmarks: [{ id: "bookmark", url: "https://example.com/work", title: "Work", pinned: true, folder: [] }],
      credentials: [],
      rememberHistory: true,
      vaultAvailable: false,
    },
  }
  expect(browserSuggestions("work", state).map((row) => [row.kind, row.tabID])).toEqual([
    ["tab", "tab"],
    ["history", undefined],
  ])
  expect(browserSuggestions("  ", state)).toEqual([])
  expect(browserSuggestions("no match", state)).toEqual([])
})

test("tab keyboard navigation wraps and supports strip boundaries", () => {
  expect(browserTabKeyIndex("ArrowLeft", 0, 3)).toBe(2)
  expect(browserTabKeyIndex("ArrowRight", 2, 3)).toBe(0)
  expect(browserTabKeyIndex("Home", 2, 3)).toBe(0)
  expect(browserTabKeyIndex("End", 0, 3)).toBe(2)
  expect(browserTabKeyIndex("Enter", 0, 3)).toBeUndefined()
  expect(browserTabKeyIndex("ArrowRight", 0, 0)).toBeUndefined()
})
