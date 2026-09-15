import type { DriverContents, Target } from "./driver"

export type BrowserRegistration = {
  id: string
  ownerID: number
  sessionID: string
  contents: DriverContents
  agentAccess: boolean
  revision: number
  accessRevision?: number
  navigationAllowed?: (url: string) => boolean
}
const tabs = new Map<string, BrowserRegistration>()
let agentEnabled = true
export const browserAgentEnabled = () => agentEnabled
export function setBrowserAgentEnabled(enabled: boolean) {
  agentEnabled = enabled
  if (enabled) return
  tabs.forEach((tab) => {
    tab.agentAccess = false
    tab.accessRevision = (tab.accessRevision ?? 0) + 1
    tab.revision++
  })
}

export function registerBrowserTab(tab: BrowserRegistration) {
  if (tabs.has(tab.id)) throw new Error("Duplicate browser tab")
  tabs.set(tab.id, tab)
  return () => tabs.delete(tab.id)
}

export function browserTabs(sessionID: string) {
  return [...tabs.values()].filter((tab) => tab.sessionID === sessionID && !tab.contents.isDestroyed())
}

export function resolveBrowserTarget(sessionID: string, tabID: string): Target | undefined {
  const tab = tabs.get(tabID)
  if (!tab || tab.sessionID !== sessionID || tab.contents.isDestroyed()) return
  return { tabID, contents: tab.contents }
}

export function browserRegistration(sessionID: string, tabID: string) {
  return browserTabs(sessionID).find((tab) => tab.id === tabID)
}
