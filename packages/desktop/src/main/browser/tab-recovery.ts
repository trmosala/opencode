import { getStore } from "../store"

export type SavedTab = {
  url: string
  title: string
  pinned?: boolean
  navigation?: { entries: { url: string; title: string }[]; activeIndex: number }
}
export type ClosedTab = SavedTab & { id: string; time: number }
type SavedGroup = { sessionID: string; tabs: SavedTab[]; active: number; closed: ClosedTab[] }

export function recoveryURL(value: string) {
  if (value === "about:blank") return value
  if (!URL.canParse(value)) return "about:blank"
  const url = new URL(value)
  if (!["https:", "http:"].includes(url.protocol) || url.username || url.password) return "about:blank"
  return url.href
}

export function recoveryNavigation(value: unknown): SavedTab["navigation"] {
  if (!value || typeof value !== "object" || !("entries" in value) || !("activeIndex" in value)) return
  const { entries, activeIndex } = value
  if (
    !Array.isArray(entries) ||
    !entries.length ||
    entries.length > 100 ||
    typeof activeIndex !== "number" ||
    !Number.isInteger(activeIndex) ||
    activeIndex < 0 ||
    activeIndex >= entries.length ||
    !entries.every((entry) => validTab(entry) && entry.url.length <= 2048)
  )
    return
  // ponytail: keep 20 entries around the selected page, not just the newest 20.
  const start = Math.max(0, Math.min(activeIndex - 10, entries.length - 20))
  return {
    entries: entries.slice(start, start + 20).map(({ url, title }) => ({ url, title })),
    activeIndex: activeIndex - start,
  }
}

export function projectSavedTab(value: unknown): SavedTab | undefined {
  if (!validTab(value)) return
  const navigation = recoveryNavigation("navigation" in value ? value.navigation : undefined)
  return {
    url: value.url,
    title: value.title,
    ...(value && "pinned" in value && value.pinned === true ? { pinned: true } : {}),
    ...(navigation?.entries[navigation.activeIndex].url === value.url ? { navigation } : {}),
  }
}

export function savedTabs(sessionID: string) {
  return recoveryGroups().find((entry) => entry.sessionID === sessionID)
}

export function saveTabs(group: SavedGroup) {
  const groups = recoveryGroups()
  getStore("cm-browser").set(
    "tabSessions",
    projectRecoveryGroups([group, ...groups.filter((entry) => entry.sessionID !== group.sessionID)].slice(0, 50)),
  )
}

export function clearTabRecovery() {
  getStore("cm-browser").delete("tabSessions")
}

export function clearClosedTabs(since: number) {
  getStore("cm-browser").set(
    "tabSessions",
    recoveryGroups().map((group) => ({
      ...group,
      closed: group.closed.filter((tab) => tab.time < since),
    })),
  )
}

function recoveryGroups() {
  return projectRecoveryGroups(getStore("cm-browser").get("tabSessions", []))
}

export function projectRecoveryGroups(input: unknown): SavedGroup[] {
  // Do not turn malformed metadata into an empty record that the next save overwrites.
  if (!Array.isArray(input) || input.length > 50) throw new Error("Invalid browser recovery")
  return input.map((entry) => {
    if (
      !entry ||
      typeof entry !== "object" ||
      typeof entry.sessionID !== "string" ||
      entry.sessionID.length > 256 ||
      !Number.isInteger(entry.active) ||
      !Array.isArray(entry.tabs) ||
      entry.tabs.length > 32 ||
      !entry.tabs.every(validTab) ||
      (entry.tabs.length ? entry.active < 0 || entry.active >= entry.tabs.length : entry.active !== -1) ||
      !Array.isArray(entry.closed) ||
      entry.closed.length > 20 ||
      !entry.closed.every(
        (tab: unknown) =>
          validTab(tab) &&
          "id" in tab &&
          typeof tab.id === "string" &&
          tab.id.length <= 256 &&
          "time" in tab &&
          typeof tab.time === "number" &&
          Number.isFinite(tab.time),
      )
    )
      throw new Error("Invalid browser recovery")
    return {
      sessionID: entry.sessionID,
      tabs: entry.tabs.map((tab: unknown) => projectSavedTab(tab)!),
      active: entry.active,
      closed: entry.closed.map((tab: ClosedTab) => ({ ...projectSavedTab(tab)!, id: tab.id, time: tab.time })),
    }
  })
}

function validTab(value: unknown): value is { url: string; title: string } {
  return (
    !!value &&
    typeof value === "object" &&
    "url" in value &&
    typeof value.url === "string" &&
    value.url === recoveryURL(value.url) &&
    "title" in value &&
    typeof value.title === "string" &&
    value.title.length <= 512 &&
    (!("pinned" in value) || typeof value.pinned === "boolean")
  )
}
