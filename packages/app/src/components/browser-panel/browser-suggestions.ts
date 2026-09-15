import type { BrowserTabs } from "@/browser-panel"

export function browserSuggestions(input: string, state: BrowserTabs) {
  const query = input.trim().toLowerCase()
  if (!query) return []
  const seen = new Set<string>()
  const rows = [
    ...state.tabs
      .filter((tab) => tab.id !== state.activeID)
      .map((tab) => ({ url: tab.url, title: tab.title, tabID: tab.id, kind: "tab" as const })),
    ...(state.profile?.bookmarks ?? []).map((row) => ({ ...row, tabID: undefined, kind: "bookmark" as const })),
    ...(state.profile?.history ?? []).map((row) => ({ ...row, tabID: undefined, kind: "history" as const })),
  ]
  return rows
    .filter((row) => {
      if (!/^https?:/.test(row.url) || !`${row.title} ${row.url}`.toLowerCase().includes(query) || seen.has(row.url))
        return false
      seen.add(row.url)
      return true
    })
    .slice(0, 8)
}
