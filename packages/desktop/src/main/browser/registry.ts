import { invalidateSnapshots, type DriverContents, type Target } from "./driver"
import {
  failure,
  type HistoryRequest,
  type Request,
  type Response,
  type BrowserState,
  type SiteTool,
  type NetworkObservation,
} from "@cookiemonster/cm-browser/protocol"
import { browserPageURL } from "./policy"
import { nativeT } from "../native-translations"
import type { createFrameSessions } from "./frame-sessions"

export type TabLifecycleRequest = Extract<Request, { op: "prepare_tab" | "create_tab" | "select_tab" | "close_tab" }>
export const browserOperationBusy = new Set<string>()
let tabHandler:
  | ((
      sessionID: string,
      request: TabLifecycleRequest,
      signal: AbortSignal,
      deadline: number,
    ) => Promise<Response<BrowserState>>)
  | undefined
export function setBrowserTabHandler(handler: typeof tabHandler) {
  tabHandler = handler
}
export function routeBrowserTab(
  sessionID: string,
  request: TabLifecycleRequest,
  signal: AbortSignal,
  deadline: number,
) {
  return (
    tabHandler?.(sessionID, request, signal, deadline) ??
    Promise.resolve(failure("no_target", nativeT("desktop.browser.tabs.noTarget")))
  )
}

let historyHandler:
  | ((sessionID: string, request: HistoryRequest, signal?: AbortSignal) => Promise<Response<BrowserState>>)
  | undefined
export function setBrowserHistoryHandler(handler: NonNullable<typeof historyHandler>) {
  historyHandler = handler
}
export function routeBrowserHistory(sessionID: string, request: HistoryRequest, signal?: AbortSignal) {
  return (
    historyHandler?.(sessionID, request, signal) ??
    Promise.resolve(failure("no_target", "Open this task in CookieMonster before using browser history."))
  )
}

export type BrowserRegistration = {
  id: string
  ownerID: number
  sessionID: string
  contents: DriverContents
  transferGuarded?: boolean
  frameSessions?: ReturnType<typeof createFrameSessions>
  agentOrigin?: string
  agentAccess: boolean
  revision: number
  accessRevision?: number
  accessConsent?: AbortController
  screenshotConsent?: AbortController
  diagnosticConsent?: AbortController
  siteToolConsent?: AbortController
  ownerContext?: () => string
  confirmScreenshot?: (url: string, signal: AbortSignal) => Promise<false | (() => void)>
  confirmDiagnostics?: (
    url: string,
    durationMs: number,
    signal: AbortSignal,
    kind: "console" | "network",
  ) => Promise<false | (() => void)>
  observeNetwork?: (durationMs: number, check: () => void, signal: AbortSignal) => Promise<NetworkObservation>
  confirmSiteTool?: (
    url: string,
    tool: SiteTool,
    argumentsJSON: string,
    signal: AbortSignal,
  ) => Promise<false | (() => void)>
  navigationAllowed?: (url: string) => boolean
}
// Consent belongs to one tab and exact origin, never to every tab on a hostname.
export function browserAccessAllowed(tab: BrowserRegistration, url: string) {
  return (
    tab.agentAccess &&
    !!tab.agentOrigin &&
    browserPageURL(url) &&
    url !== "about:blank" &&
    new URL(url).origin === tab.agentOrigin
  )
}

export function revokeBrowserAccess(tab: BrowserRegistration) {
  tab.accessConsent?.abort()
  tab.screenshotConsent?.abort()
  tab.diagnosticConsent?.abort()
  tab.siteToolConsent?.abort()
  tab.agentAccess = false
  tab.agentOrigin = undefined
  tab.accessRevision = (tab.accessRevision ?? 0) + 1
  tab.revision++
  invalidateSnapshots(tab.contents)
}

export function revokeBrowserAccessOnNavigation(tab: BrowserRegistration, url: string) {
  if (tab.agentAccess && !browserAccessAllowed(tab, url)) revokeBrowserAccess(tab)
}

const tabs = new Map<string, BrowserRegistration>()
let agentEnabled = true
let agentEpoch = 0
export const browserAgentEnabled = () => agentEnabled
export const browserAgentEpoch = () => agentEpoch
export function setBrowserAgentEnabled(enabled: boolean) {
  if (agentEnabled !== enabled) agentEpoch++
  agentEnabled = enabled
  if (enabled) return
  tabs.forEach((tab) => {
    revokeBrowserAccess(tab)
  })
}

export function registerBrowserTab(tab: BrowserRegistration) {
  if (tabs.has(tab.id)) throw new Error("Duplicate browser tab")
  tabs.set(tab.id, tab)
  return () => {
    tab.accessConsent?.abort()
    tab.screenshotConsent?.abort()
    tab.diagnosticConsent?.abort()
    tab.siteToolConsent?.abort()
    return tabs.delete(tab.id)
  }
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
