import { randomUUID } from "node:crypto"
import type { BrowserClearKind, BrowserClearRange, BrowserProfile } from "@opencode-ai/app/browser-panel"
import { getStore } from "../store"

export function historyRows() {
  const store = getStore("cm-browser")
  const input = store.get("history", [])
  const rows = Array.isArray(input) ? input : []
  const valid = rows.filter(
    (row): row is BrowserProfile["history"][number] =>
      row &&
      typeof row.url === "string" &&
      /^https?:/.test(row.url) &&
      Number.isFinite(row.time) &&
      typeof row.title === "string" &&
      (row.id === undefined || typeof row.id === "string"),
  )
  const result = valid.map((row) => ({ ...row, id: row.id ?? randomUUID() })).slice(0, 2000)
  if (result.length !== rows.length || valid.some((row) => !row.id)) store.set("history", result)
  return result
}

export function clearSince(range: BrowserClearRange, now = Date.now()) {
  const durations = { hour: 3600_000, day: 86400_000, week: 7 * 86400_000, month: 30 * 86400_000, all: Infinity }
  if (!Object.hasOwn(durations, range)) throw new Error("Invalid time range")
  return Math.max(0, now - durations[range])
}

export function validateClear(kinds: BrowserClearKind[], range: BrowserClearRange) {
  clearSince(range)
  if (
    !Array.isArray(kinds) ||
    !kinds.length ||
    kinds.length > 5 ||
    new Set(kinds).size !== kinds.length ||
    kinds.some((kind) => !["history", "cache", "cookies", "passwords", "downloads"].includes(kind))
  )
    throw new Error("Invalid data selection")
  if (range !== "all" && kinds.some((kind) => kind !== "history" && kind !== "downloads"))
    throw new Error("Selected data requires all-time clearing")
}
