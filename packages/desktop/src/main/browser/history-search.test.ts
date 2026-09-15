import { expect, test } from "bun:test"
import { searchHistory } from "./history-search"

test("history search matches title or URL, filters dates inclusively and bounds newest-first visits", () => {
  const rows = [
    { id: "a", url: "https://example.com/docs", title: "Guide", time: 100 },
    { id: "b", url: "https://example.com/guide", title: "Reference", time: 200 },
    { id: "c", url: "https://example.com/docs", title: "Guide again", time: 300 },
  ]
  expect(
    searchHistory(rows, { op: "search_history", query: "GUIDE", from: 100, to: 200, limit: 20 }).map((row) => row.id),
  ).toEqual(["b", "a"])
  expect(searchHistory(rows, { op: "search_history", query: "", limit: 1 }).map((row) => row.id)).toEqual(["c"])
  expect(
    searchHistory(
      rows.filter((row) => row.id !== "c"),
      { op: "search_history", query: "again", limit: 20 },
    ),
  ).toEqual([])
  expect(
    searchHistory([{ id: "d", url: "https://user:secret@example.com", title: "Guide", time: 100 }], {
      op: "search_history",
      query: "",
      limit: 20,
    }),
  ).toEqual([])
})
