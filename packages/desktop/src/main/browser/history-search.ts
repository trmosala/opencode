import type { HistoryRequest } from "@cookiemonster/cm-browser/protocol"

export function searchHistory(
  rows: { id: string; url: string; title: string; time: number }[],
  request: Extract<HistoryRequest, { op: "search_history" }>,
) {
  const query = request.query.trim().toLowerCase()
  return rows
    .filter((row) => {
      if (!URL.canParse(row.url) || row.url.length > 2048) return false
      const url = new URL(row.url)
      return (
        ["http:", "https:"].includes(url.protocol) &&
        !url.username &&
        !url.password &&
        row.time >= (request.from ?? 0) &&
        row.time <= (request.to ?? Infinity) &&
        (!query || `${row.title}\n${row.url}`.toLowerCase().includes(query))
      )
    })
    .sort((a, b) => b.time - a.time)
    .slice(0, request.limit)
}
