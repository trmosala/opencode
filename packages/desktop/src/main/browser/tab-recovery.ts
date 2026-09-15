import { getStore } from "../store"

export type SavedTab = { url: string; title: string }
export type ClosedTab = SavedTab & { id: string; time: number }
type SavedGroup = { sessionID: string; tabs: SavedTab[]; active: number; closed: ClosedTab[] }

export function recoveryURL(value: string) {
  if (value === "about:blank") return value
  if (!URL.canParse(value)) return "about:blank"
  const url = new URL(value)
  if (!["https:", "http:"].includes(url.protocol) || url.username || url.password) return "about:blank"
  return url.href
}

export function savedTabs(sessionID: string) {
  return recoveryGroups().find((entry) => entry.sessionID === sessionID)
}

export function saveTabs(group: SavedGroup) {
  const store = getStore("cm-browser")
  store.set(
    "tabSessions",
    [group, ...recoveryGroups().filter((entry) => entry.sessionID !== group.sessionID)].slice(0, 50),
  )
}

export function clearTabRecovery() {
  getStore("cm-browser").delete("tabSessions")
}

export function clearClosedTabs(since: number) {
  const store = getStore("cm-browser")
  store.set(
    "tabSessions",
    recoveryGroups().map((group) => ({
      ...group,
      closed: group.closed.filter((tab) => tab.time < since),
    })),
  )
}

function recoveryGroups() {
  const input = getStore("cm-browser").get("tabSessions", [])
  if (!Array.isArray(input)) return []
  return input
    .filter((entry): entry is SavedGroup => {
      if (
        !entry ||
        typeof entry !== "object" ||
        typeof entry.sessionID !== "string" ||
        entry.sessionID.length > 256 ||
        !Number.isInteger(entry.active)
      )
        return false
      if (!Array.isArray(entry.tabs) || entry.tabs.length > 32 || !entry.tabs.every(validTab)) return false
      return (
        Array.isArray(entry.closed) &&
        entry.closed.length <= 20 &&
        entry.closed.every(
          (tab: unknown) =>
            validTab(tab) &&
            "id" in tab &&
            typeof tab.id === "string" &&
            "time" in tab &&
            typeof tab.time === "number" &&
            Number.isFinite(tab.time),
        )
      )
    })
    .slice(0, 50)
}

function validTab(value: unknown): value is SavedTab {
  return (
    !!value &&
    typeof value === "object" &&
    "url" in value &&
    typeof value.url === "string" &&
    value.url === recoveryURL(value.url) &&
    "title" in value &&
    typeof value.title === "string" &&
    value.title.length <= 512
  )
}
