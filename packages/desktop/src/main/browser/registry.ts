import { invalidateSnapshots, type DriverContents, type Target } from "./driver"
import {
  failure,
  type HistoryRequest,
  type Request,
  type Response,
  type BrowserState,
  type NetworkObservation,
} from "@cookiemonster/cm-browser/protocol"
import { browserPageURL } from "./policy"
import { nativeT } from "../native-translations"
import type { createFrameSessions } from "./frame-sessions"
import type { BrowserOperationState } from "@opencode-ai/app/browser-panel"
import type { BrowserOwnerScope } from "./session-resolver"

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
  if (browserTabs(sessionID).some((tab) => browserTabReserved(tab)))
    return Promise.resolve(failure("unavailable", nativeT("desktop.browser.operationUnavailable")))
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
  notice?: { code: string; message: string }
  operation?: BrowserOperationState
  operationChanged?: () => void
  id: string
  ownerID: number
  sessionID: string
  agentOwnerSessionID?: string
  ownerScope?: () => BrowserOwnerScope | undefined
  ownerScopeReady?: Promise<BrowserOwnerScope>
  resolveOwnerScope?: (signal: AbortSignal) => Promise<BrowserOwnerScope>
  contents: DriverContents
  transferGuarded?: boolean
  frameSessions?: ReturnType<typeof createFrameSessions>
  agentAccess: boolean
  leavePending?: boolean
  revision: number
  accessRevision?: number
  accessConsent?: AbortController
  screenshotConsent?: AbortController
  diagnosticConsent?: AbortController
  siteToolConsent?: AbortController
  ownerContext?: () => string
  captureOwner?: (screenshot: boolean) => () => void
  observeNetwork?: (durationMs: number, check: () => void, signal: AbortSignal) => Promise<NetworkObservation>
  navigationAllowed?: (url: string) => boolean
}
// Authority belongs to this native tab, including its cross-origin documents.
// URL validation describes driver capability, not another origin grant.
export function browserAccessAllowed(tab: BrowserRegistration, url: string) {
  return tab.agentAccess && browserPageURL(url)
}

// Reservations only exclude competing access. They never expose a child session or grant lookup authority.
const reservations = new WeakMap<BrowserRegistration, object>()
const accessObservers = new WeakMap<BrowserRegistration, Set<() => void>>()

export function browserTabReserved(tab: BrowserRegistration, token?: object) {
  const reservation = reservations.get(tab)
  return reservation !== undefined && reservation !== token
}

export function reserveBrowserTab(tab: BrowserRegistration, token: object) {
  if (reservations.has(tab) || browserOperationBusy.has(tab.id)) throw new Error("Browser tab occupied")
  reservations.set(tab, token)
  tab.revision++
  invalidateSnapshots(tab.contents)
  return () => {
    if (reservations.get(tab) !== token) return
    reservations.delete(tab)
    tab.revision++
    invalidateSnapshots(tab.contents)
  }
}

export function watchBrowserAccess(tab: BrowserRegistration, revoke: () => void) {
  const observers = accessObservers.get(tab) ?? new Set<() => void>()
  accessObservers.set(tab, observers)
  observers.add(revoke)
  return () => {
    observers.delete(revoke)
    if (!observers.size) accessObservers.delete(tab)
  }
}

export function revokeBrowserAccess(tab: BrowserRegistration) {
  accessObservers.get(tab)?.forEach((revoke) => revoke())
  tab.accessConsent?.abort()
  tab.screenshotConsent?.abort()
  tab.diagnosticConsent?.abort()
  tab.siteToolConsent?.abort()
  tab.agentAccess = false
  tab.accessRevision = (tab.accessRevision ?? 0) + 1
  tab.revision++
  invalidateSnapshots(tab.contents)
}

export function invalidateBrowserDocument(tab: BrowserRegistration) {
  tab.accessConsent?.abort()
  tab.screenshotConsent?.abort()
  tab.diagnosticConsent?.abort()
  tab.siteToolConsent?.abort()
  tab.revision++
  invalidateSnapshots(tab.contents)
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
    if (tabs.get(tab.id) !== tab) return false
    revokeBrowserAccess(tab)
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
