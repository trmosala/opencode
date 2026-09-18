import { expect, test } from "bun:test"
import { browserSuggestions } from "./browser-suggestions"
import type { BrowserTabs } from "@/browser-panel"

test("suggestions prefer existing tabs, deduplicate URLs, and match titles without remote requests", () => {
  const state: BrowserTabs = {
    sessionID: "test",
    tabs: [
      {
        id: "tab",
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
