import { randomUUID } from "node:crypto"
import { cancelBrowserNavigation, navigateBrowser } from "./navigation"
import type { EventEmitter } from "node:events"
import { trackDownload } from "./download-records"
import {
  stagedDownload,
  recoverDownload,
  recoveringDownloads,
  cancelRecoveredDownload,
  pruneDownloadRecovery,
} from "./download-recovery"
import { basename, join } from "node:path"
import { app, BrowserWindow, WebContentsView, dialog, session, shell, Notification } from "electron"
import contextMenu from "electron-context-menu"
import type { IpcMainInvokeEvent, WebContents, WebPreferences, DownloadItem } from "electron"
import type {
  BrowserBounds,
  BrowserCommand,
  BrowserDownload,
  BrowserTabs,
  BrowserClearKind,
  BrowserClearRange,
  BrowserSiteData,
  BrowserSiteStorage,
  DesktopPanelRequest,
} from "@opencode-ai/app/browser-panel"
import { browserShortcut, browserDeviceSize, BROWSER_DEVICE_DEFAULT } from "@opencode-ai/app/browser-panel"
import { nativeT } from "../native-translations"
import { observeNetwork } from "./network-diagnostics"
import {
  browserPreferences,
  browserNavigationURL,
  browserPageURL,
  MAX_BROWSER_NAVIGATION_URL_LENGTH,
  BROWSER_PARTITION,
} from "./policy"
import {
  registerBrowserTab,
  revokeBrowserAccess,
  invalidateBrowserDocument,
  setBrowserAgentEnabled,
  browserAgentEnabled,
  browserAgentEpoch,
  browserTaskPaused,
  browserTaskEpoch,
  setBrowserTaskPaused,
  browserOperationBusy,
  browserTabReserved,
  browserRegistration,
  watchBrowserAccess,
  watchBrowserAuthority,
  setBrowserHistoryHandler,
  type BrowserRegistration,
} from "./registry"
import {
  browserPreferencesState,
  saveBrowserPreferences,
  downloadDirectory,
  chooseDownloadDirectory,
  downloadHistory,
  recordDownload,
  reserveDownload,
  revealDownload,
  mediaOrigin,
  mediaPermission,
  saveSitePermission,
  notificationPermission,
  practicalPermission,
  sitePermissionsRevision,
  browserZoomFactor,
  saveBrowserZoom,
  saveBrowserDevicePreset,
  deleteBrowserDevicePreset,
} from "./preferences"
import { presentationOrigin } from "./presentation-preferences"
import { displayCaptureSupported, siteOrigin } from "./site-permissions"
import { transferRule } from "./transfer-policy"
import { browserInputFailure, invalidateSnapshots, shouldShowBrowserContextMenu } from "./driver"
import { deviceEmulation } from "./device-preview"
import { captureBrowserContext, cancelPicker } from "./context"
import { initializeVaultLocking, vaultAccess } from "./vault-session"
import { vaultAvailable } from "./vault"
import { readContacts, saveContact, deleteContact } from "./contacts"
import { prepareContactScript, completeContactScript } from "./contact-form"
import { resolveExternalURL } from "../external-url"
import { linkDestination } from "./link-destination"
import { saveBookmark, deleteBookmark, moveBookmark, transferBookmarks } from "./bookmarks"
import { getStore } from "../store"
import { historyRows, validateClear, clearSince } from "./browsing-data"
import {
  savedTabs,
  saveTabs,
  clearTabRecovery,
  recoveryURL,
  recoveryNavigation,
  projectSavedTab,
  type SavedTab,
  type ClosedTab,
} from "./tab-recovery"
import {
  browserProfile,
  browserSettings,
  clearBrowserData,
  forgetLogin,
  editLogin,
  importBrowserData,
  rememberPage,
} from "./profile"

import { runBrowserLogin } from "./login-command"
import { watchLoginOffers, allowLoginOffers } from "./login-offers"
import { generateBrowserPassword } from "./password-generation-command"
import { agentHistory } from "./agent-history"
import { createTabHandler, type NativeTabAction } from "./agent-tabs"
import { setBrowserTabHandler, setBrowserPanelHandler } from "./registry"
import { failure, success, hasFrameTarget, parsePanelRequest, type TabRequest, type PanelRequest, type PanelResult } from "@cookiemonster/cm-browser/protocol"
import { allowDownload, guardUploads, saveTransferRule } from "./transfer-permissions"
import { transferVaultBackup } from "./vault-backup"
import { createLeaveConfirmation } from "./leave-confirmation"
import { browserResourceBlocker, inspectBrowserResources } from "./resource-policy"
import { browserOwnerScopeCurrent, resolveBrowserOwnerScope, type BrowserOwnerScope } from "./session-resolver"

type Tab = BrowserRegistration & {
  failure?: { kind: "load" | "crash"; code: string; message: string }
  agentClose?: {
    check: () => void
    signal: AbortSignal
    deadline: number
    retry?: () => void
    retrying?: boolean
    settled?: () => void
    settledPromise?: Promise<void>
    prompt?: Promise<boolean>
    stay?: () => void
  }
  leaveIntent?: {
    navigation: boolean
    controller: AbortController
    deadline: number
    check: () => void
    replay: () => Promise<unknown> | unknown
    settled: Promise<void>
    settle: () => void
    prompt?: Promise<boolean>
    replaying?: boolean
    vetoed?: boolean
    vetoRevision?: number
  }
  uploadGuard?: Promise<unknown>
  saved: SavedTab
  recovery?: { started: boolean; restoring: boolean }
  view: WebContentsView
  openerID?: string
  loadFailed: boolean
  device?: boolean
  deviceSize?: { width: number; height: number }
  find?: { active: number; matches: number }
  findRequest?: number
  permissionReload?: boolean
  permissionReloadQueued?: boolean
  permissionReloadPhase?: "dispatch" | "loading"
  permissionReplaceQueued?: boolean
  permissionReplacing?: boolean
  cancelLoginOffer?: () => void
  readyLoginOffers?: (check: () => void) => Promise<number>
  loginBusy?: boolean
  siteData?: BrowserSiteData
  deferredRestore?: boolean
  resourcePending?: boolean
  resourceReplacement?: SavedTab
  restorePromise?: Promise<void>
  restore?: () => Promise<void>
}
type Group = {
  revision?: number
  sessionID: string
  tabs: Tab[]
  activeID?: string
  downloads?: BrowserDownload[]
  closed: ClosedTab[]
  restoring?: boolean
}
type Owner = {
  panelRequest?: {
    request: DesktopPanelRequest
    check(): void
    acknowledge(value: unknown): boolean
    cancel(): void
  }
  authorityID: string
  linkContext?: { sessionID: string; lease: string }
  win: BrowserWindow
  groups: Map<string, Group>
  viewport?: { sessionID: string; lease: string; bounds: BrowserBounds }
  attached?: Tab
  suspended: number
  screenshotEpoch: number
  taskEpoch: number
  tabConsent?: AbortController
  shutting?: boolean
  generationCheck?: () => void
  loginCheck?: () => void
  captureChecks?: Set<() => void>
}
function advanceOwnerTask(owner: Owner) {
  owner.taskEpoch++
  owner.tabConsent?.abort()
  owner.groups.forEach((group) =>
    group.tabs.forEach((tab) => {
      tab.screenshotConsent?.abort()
      tab.diagnosticConsent?.abort()
      tab.siteToolConsent?.abort()
    }),
  )
  owner.captureChecks?.forEach((check) => check())
}
const contactDeliveries = new Set<string>()
const owners = new Map<number, Owner>()
const transfers = new Map<string, { item: DownloadItem; owner: Owner; group: Group; download: BrowserDownload }>()
setBrowserHistoryHandler(async (sessionID, request, signal) => {
  const owner = [...owners.values()].find(
    (entry) => entry.linkContext?.sessionID === sessionID || entry.groups.has(sessionID),
  )
  if (!owner || owner.shutting || owner.win.isDestroyed())
    return failure("no_target", "Open this task in CookieMonster before using browser history.")
  return agentHistory(
    owner.win,
    sessionID,
    request,
    (row) => {
      const group = groupFor(owner, sessionID)
      if (group.tabs.length >= 32) throw new Error("Browser tab limit reached")
      const tab = createTab(owner, group, undefined, row)
      publish(owner, group)
      owner.win.webContents.send("browser-opened", sessionID)
      return tab.id
    },
    signal,
  ).catch(() => failure("unavailable", "Browser history operation unavailable."))
})
setBrowserTabHandler(createTabHandler(resolveNativeTabAction))
setBrowserPanelHandler(async (sessionID, request, signal, deadline) => {
  const matches = [...owners.values()].filter((owner) => owner.linkContext?.sessionID === sessionID)
  if (matches.length !== 1) return failure("no_target", nativeT("desktop.browser.tabs.noTarget"))
  const owner = matches[0]
  const group = owner.groups.get(sessionID)
  const target = request.view === "browser" ? group?.tabs.find((tab) => tab.id === request.tabID) : undefined
  if (request.view === "browser" && (!target?.agentAccess || browserTabReserved(target)))
    return failure("access_denied", nativeT("desktop.browser.operationUnavailable"))
  if (owner.panelRequest || owner.suspended || [...(group?.tabs ?? [])].some((tab) => browserOperationBusy.has(tab.id) || tab.leavePending))
    return failure("unavailable", nativeT("desktop.browser.tabs.busy"))
  try {
    if (signal.aborted || Date.now() >= deadline || owner.shutting || owner.win.isDestroyed() ||
      owner.win.webContents.isDestroyed() || !owner.win.isVisible() || owner.win.isMinimized() ||
      (owner.viewport && owner.viewport.sessionID !== sessionID)) throw new Error()
    if (target && group) {
      group.activeID = target.id
      persistGroup(owner, group)
      publish(owner, group)
      layout(owner)
    }
    const panelResult = await requestDesktopPanel(owner, sessionID, request, signal, deadline)
    return success({ tabID: "", url: "", title: "", visibleText: "", elements: [], panelResult })
  } catch {
    return failure("unavailable", nativeT("desktop.browser.operationUnavailable"))
  }
})
let profileReady = false
vaultAccess.subscribe(() => owners.forEach((owner) => owner.groups.forEach((group) => publish(owner, group))))

export function registerBrowserOwner(win: BrowserWindow) {
  initializeVaultLocking()
  setBrowserAgentEnabled(browserPreferencesState().agentEnabled)
  const existing = owners.get(win.webContents.id)
  if (existing) return existing
  const owner: Owner = {
    authorityID: randomUUID(),
    win,
    groups: new Map(),
    suspended: 0,
    screenshotEpoch: 0,
    taskEpoch: 0,
  }
  const id = win.webContents.id
  owners.set(id, owner)
  const hide = () => {
    if (owner.viewport) {
      advanceOwnerTask(owner)
    }
    owner.viewport = undefined
    layout(owner)
  }
  win.on("resize", hide)
  win.on("hide", () => {
    owner.screenshotEpoch++
    vaultAccess.lock()
    layout(owner)
  })
  win.on("close", () => {
    owner.screenshotEpoch++
    owner.shutting = true
  })
  win.on("show", () => {
    owner.shutting = false
    layout(owner)
  })
  win.on("minimize", () => {
    owner.screenshotEpoch++
    vaultAccess.lock()
    layout(owner)
  })
  win.on("restore", () => layout(owner))
  win.webContents.on("did-start-navigation", (_event, _url, _inPlace, main) => {
    owner.screenshotEpoch++
    if (main) {
      owner.groups.forEach((group) => group.tabs.forEach(revokeBrowserAccess))
      vaultAccess.lock()
      hide()
    }
  })
  win.webContents.on("render-process-gone", () => {
    owner.screenshotEpoch++
    owner.groups.forEach((group) => group.tabs.forEach(revokeBrowserAccess))
    vaultAccess.lock()
    hide()
  })
  win.webContents.once("destroyed", () => {
    owner.screenshotEpoch++
    owner.shutting = true
    vaultAccess.lock()
    owners.delete(id)
    owner.groups.forEach((group) =>
      group.tabs.slice().forEach((tab) => {
        if (!tab.view.webContents.isDestroyed()) tab.view.webContents.close()
      }),
    )
    owner.groups.clear()
  })
  return owner
}

export function browserOwner(event: IpcMainInvokeEvent) {
  const owner = owners.get(event.sender.id)
  if (!owner || owner.win.isDestroyed() || event.senderFrame !== event.sender.mainFrame)
    throw new Error("Invalid browser sender")
  return owner
}

export function browserLinkContext(owner: Owner, sessionID: string | null, lease: string) {
  if (
    typeof lease !== "string" ||
    lease.length > 128 ||
    (sessionID !== null && (typeof sessionID !== "string" || !sessionID || sessionID.length > 256))
  )
    throw new Error("Invalid browser context")
  if (
    (sessionID !== null && (owner.linkContext?.sessionID !== sessionID || owner.linkContext?.lease !== lease)) ||
    (sessionID === null && owner.linkContext?.lease === lease)
  ) {
    owner.panelRequest?.cancel()
    advanceOwnerTask(owner)
    if (sessionID !== null) owner.linkContext = { sessionID, lease }
    if (sessionID === null) owner.linkContext = undefined
  }
  owner.captureChecks?.forEach((check) => check())
}

function requestDesktopPanel(owner: Owner, sessionID: string, request: PanelRequest, signal: AbortSignal, deadline: number) {
  if (owner.panelRequest) return Promise.reject(new Error("Panel request busy"))
  const link = owner.linkContext
  const lifecycle = owner.screenshotEpoch
  const globalEpoch = browserAgentEpoch()
  const taskEpoch = browserTaskEpoch(sessionID)
  const group = owner.groups.get(sessionID)
  const target = request.view === "browser" ? group?.tabs.find((tab) => tab.id === request.tabID) : undefined
  const contents = target?.contents
  const revision = target?.revision
  const accessRevision = target?.accessRevision
  const granted = target?.agentAccess
  // Viewport mount/clear changes owner.taskEpoch as part of this operation.
  // Link identity and the independent task/global epochs still fence authority.
  const event: DesktopPanelRequest = { id: randomUUID(), sessionID, deadline, ...request }
  const check = () => {
    signal.throwIfAborted()
    if (
      Date.now() >= deadline || owner.shutting || owner.win.isDestroyed() || owner.win.webContents.isDestroyed() ||
      owners.get(owner.win.webContents.id) !== owner || !owner.win.isVisible() || owner.win.isMinimized() ||
      [...owners.values()].filter((entry) => entry.linkContext?.sessionID === sessionID).length !== 1 ||
      owner.suspended || owner.linkContext !== link || link?.sessionID !== sessionID ||
      owner.screenshotEpoch !== lifecycle || !browserAgentEnabled() || browserAgentEpoch() !== globalEpoch ||
      browserTaskPaused(sessionID) || browserTaskEpoch(sessionID) !== taskEpoch ||
      (owner.viewport && owner.viewport.sessionID !== sessionID) ||
      (target && (owner.groups.get(sessionID) !== group || !group?.tabs.includes(target) ||
        group.activeID !== target.id || target.contents !== contents || target.contents.isDestroyed() ||
        target.revision !== revision || target.accessRevision !== accessRevision || target.agentAccess !== granted))
    ) throw new Error("Panel authority changed")
  }
  return new Promise<PanelResult>((resolve, reject) => {
    const finish = (result?: PanelResult) => {
      if (owner.panelRequest !== pending) return
      owner.panelRequest = undefined
      clearTimeout(timer)
      signal.removeEventListener("abort", cancel)
      checks.delete(validate)
      unwatch?.()
      unwatchAuthority()
      listeners.forEach(([emitter, name]) => emitter.removeListener(name, cancel))
      if (!owner.win.isDestroyed() && !owner.win.webContents.isDestroyed())
        owner.win.webContents.send("desktop-panel-cancel", event.id)
      if (result) resolve(result)
      else reject(new Error("Panel operation unavailable"))
    }
    const cancel = () => finish()
    const validate = () => { try { check() } catch { cancel() } }
    const checks = (owner.captureChecks ??= new Set())
    const listeners: [EventEmitter, string][] = [
      ...["close", "closed", "hide", "minimize"].map((name): [EventEmitter, string] => [owner.win, name]),
      ...["destroyed", "render-process-gone", "did-start-navigation"].map(
        (name): [EventEmitter, string] => [owner.win.webContents, name],
      ),
    ]
    const pending: NonNullable<Owner["panelRequest"]> = {
      request: event, check, cancel,
      acknowledge(value) {
        if (!record(value) || value.id !== event.id || value.sessionID !== sessionID) return false
        const { id, sessionID: acknowledgedSession, ...state } = value
        if ("op" in state) return false
        const observed = parsePanelRequest({ ...state, op: "set_panel" })
        if (!observed || observed.view !== request.view ||
          (request.view === "browser" && (observed.view !== "browser" || observed.tabID !== request.tabID))) return false
        check()
        if (request.view === "browser") {
          if (!target) return false
          const native = target.view.getBounds()
          // Private blank tabs display the renderer's landing page without a native page.
          const landing = !target.agentCreated && target.contents.getURL() === "about:blank"
          if (!landing && (owner.attached !== target || !owner.viewport || !native.width || !native.height ||
            !owner.win.contentView.children.includes(target.view))) return false
          finish({ view: "browser", tabID: target.id, browserReady: true })
          return true
        }
        if (owner.attached) return false
        finish({ view: request.view, browserReady: false })
        return true
      },
    }
    const timer = setTimeout(cancel, Math.max(0, deadline - Date.now()))
    const unwatch = target ? watchBrowserAccess(target, cancel) : undefined
    const unwatchAuthority = watchBrowserAuthority(sessionID, cancel)
    owner.panelRequest = pending
    checks.add(validate)
    signal.addEventListener("abort", cancel, { once: true })
    listeners.forEach(([emitter, name]) => emitter.on(name, cancel))
    try {
      check()
      owner.win.webContents.send("desktop-panel-request", event)
    } catch { cancel() }
  }).then((result) => {
    check()
    return result
  })
}

export function browserPanelRequestCurrent(owner: Owner, id: unknown, sessionID: unknown) {
  const pending = owner.panelRequest
  if (!pending || id !== pending.request.id || sessionID !== pending.request.sessionID) return false
  try { pending.check(); return true } catch { pending.cancel(); return false }
}

export function browserPanelAcknowledgement(owner: Owner, input: unknown) {
  if (!record(input) || !browserPanelRequestCurrent(owner, input.id, input.sessionID)) return false
  return owner.panelRequest?.acknowledge(input) ?? false
}

export async function openBrowserLink(win: BrowserWindow, value: string, destination?: "browser" | "external") {
  const url = typeof value === "string" && resolveExternalURL(value)
  if (
    !url ||
    url.length > MAX_BROWSER_NAVIGATION_URL_LENGTH ||
    (destination !== undefined && destination !== "browser" && destination !== "external")
  )
    throw new Error("Invalid link")
  const owner = owners.get(win.webContents.id)
  const sessionID = owner?.linkContext?.sessionID
  if (
    !owner ||
    !sessionID ||
    !browserNavigationURL(url) ||
    (destination ?? linkDestination(url, browserPreferencesState())) === "external"
  ) {
    await shell.openExternal(url)
    return
  }
  createTab(owner, groupFor(owner, sessionID), undefined, { url, title: "" })
  win.webContents.send("browser-opened", sessionID)
}

export function browserLinkMenu(contents: WebContents, url: string) {
  if (!browserNavigationURL(url) || url === "about:blank") return []
  const owner = [...owners.values()].find(
    (entry) =>
      entry.win.webContents === contents ||
      [...entry.groups.values()].some((group) => group.tabs.some((tab) => tab.contents === contents)),
  )
  if (!owner) return []
  const group = [...owner.groups.values()].find((group) => group.tabs.some((tab) => tab.contents === contents))
  return [
    {
      label: nativeT("desktop.browser.openInternal"),
      enabled: !!group || !!owner.linkContext,
      click: () => {
        if (group) {
          createTab(owner, group, undefined, { url, title: "" })
          return
        }
        void openBrowserLink(owner.win, url, "browser").catch(() => undefined)
      },
    },
    {
      label: nativeT("desktop.browser.openExternal"),
      click: () => {
        void shell.openExternal(url).catch(() => undefined)
      },
    },
  ]
}

function groupFor(owner: Owner, sessionID: string) {
  if (typeof sessionID !== "string" || !sessionID || sessionID.length > 256) throw new Error("Invalid browser session")
  const existing = owner.groups.get(sessionID)
  if (existing) return existing
  const saved = browserPreferencesState().restoreTabs ? savedTabs(sessionID) : undefined
  const group: Group = { sessionID, tabs: [], closed: [], restoring: true }
  owner.groups.set(sessionID, group)
  if (saved) {
    group.closed = saved.closed.slice(0, 20)
    saved.tabs
      .slice(0, 32)
      .forEach((tab, index) => createTab(owner, group, undefined, tab, undefined, index !== saved.active))
    group.activeID = group.tabs[saved.active]?.id ?? group.tabs[0]?.id
  }
  group.restoring = false
  if (group.activeID) layout(owner)
  return group
}

function persistGroup(owner: Owner, group: Group) {
  if (owner.shutting || owner.win.isDestroyed() || group.restoring || !browserPreferencesState().restoreTabs) return
  saveTabs({
    sessionID: group.sessionID,
    tabs: group.tabs.map((tab) => tab.saved),
    active: group.tabs.findIndex((tab) => tab.id === group.activeID),
    closed: group.closed,
  })
}

async function clearData(kind: BrowserClearKind, range: BrowserClearRange = "all") {
  await clearBrowserData(session.fromPartition(BROWSER_PARTITION), kind, range)
  if (kind === "downloads") await pruneDownloadRecovery()
  if (kind !== "history") return
  const since = clearSince(range)
  owners.forEach((owner) =>
    owner.groups.forEach((group) => {
      group.closed = group.closed.filter((tab) => tab.time < since)
    }),
  )
}

const siteStorage = new Map<string, BrowserSiteStorage>([
  ["cache_storage", "cacheStorage"],
  ["file_systems", "fileSystems"],
  ["indexeddb", "indexedDB"],
  ["local_storage", "localStorage"],
  ["service_workers", "serviceWorkers"],
  ["websql", "webSQL"],
])

function record(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value)
}

async function inspectSiteData(contents: WebContents, url: string, origin: string): Promise<BrowserSiteData> {
  const [cookies, quota] = await Promise.allSettled([
    contents.session.cookies.get({ url }),
    (async () => {
      if (!contents.debugger.isAttached()) contents.debugger.attach("1.3")
      return contents.debugger.sendCommand("Storage.getUsageAndQuota", { origin })
    })(),
  ])
  const result: BrowserSiteData = { origin, storage: [] }
  if (cookies.status === "fulfilled") result.cookies = cookies.value.length
  if (quota.status !== "fulfilled" || !record(quota.value)) return result
  const value = quota.value
  if (typeof value.usage === "number" && Number.isFinite(value.usage) && value.usage >= 0)
    result.usage = Math.round(value.usage)
  if (Array.isArray(value.usageBreakdown))
    result.storage = value.usageBreakdown.flatMap((entry) => {
      if (!record(entry)) return []
      const row = entry
      const type = typeof row.storageType === "string" ? siteStorage.get(row.storageType) : undefined
      return type && typeof row.usage === "number" && Number.isFinite(row.usage) && row.usage > 0 ? [type] : []
    })
  return result
}

function browserDataOrigin(value: string) {
  return !browserNavigationURL(value) || value === "about:blank" ? undefined : new URL(value).origin
}

function state(group: Group): BrowserTabs {
  group.revision = (group.revision ?? 0) + 1
  const profile = browserProfile()
  return {
    revision: group.revision,
    sessionID: group.sessionID,
    agentPaused: browserTaskPaused(group.sessionID),
    activeID: group.activeID,
    recentlyClosed: group.closed,
    downloads: [
      ...(group.downloads ?? []).filter((entry) => entry.state === "saving"),
      ...downloadHistory().filter((entry) => !transfers.has(entry.id) && !recoveringDownloads().has(entry.id)),
    ],
    profile,
    tabs: group.tabs
      .filter((tab) => !tab.view.webContents.isDestroyed())
      .map((tab) => {
        const contents = tab.view.webContents
        const url = tab.deferredRestore ? tab.saved.url : contents.getURL()
        const origin = presentationOrigin(url)
        const rule = transferRule(profile.transferRules ?? [], url)
        return {
          id: tab.id,
          pinned: tab.saved.pinned === true,
          revision: tab.revision,
          openerID: tab.openerID,
          agentAccess: tab.agentAccess,
          agentCreated: tab.agentCreated,
          operation: tab.operation ? { ...tab.operation } : undefined,
          notice: tab.notice,
          failure: tab.failure,
          // ponytail: report main's policy for the live URL, never the saved/display fallback.
          access: {
            loading: contents.isLoadingMainFrame() || tab.deferredRestore === true,
            hostAllowed: browserPageURL(url) && url !== "about:blank",
            blank: url === "about:blank",
            transferGuarded: tab.transferGuarded === true,
            transferRule: rule,
            transferSource: !/^https?:/.test(url) ? "unavailable" : rule.origin === "*" ? "default" : "exception",
          },
          loadFailed: tab.loadFailed,
          loadError:
            tab.failure?.message ??
            (tab.loadFailed && tab.recovery?.restoring ? nativeT("desktop.browser.recovery.failed") : undefined),
          connection: tab.loadFailed
            ? "error"
            : contents.isLoadingMainFrame()
              ? "unknown"
              : url.startsWith("https:")
                ? "https"
                : url.startsWith("http:")
                  ? "http"
                  : "unknown",
          zoom: origin
            ? (profile.zoomRules?.find((row) => row.origin === origin)?.factor ?? 1)
            : contents.getZoomFactor(),
          device: tab.device,
          deviceSize: tab.deviceSize ?? BROWSER_DEVICE_DEFAULT,
          find: tab.find,
          siteData: tab.siteData?.origin === browserDataOrigin(url) ? tab.siteData : undefined,
          url: url || tab.saved.url,
          title: (tab.deferredRestore ? tab.saved.title : contents.getTitle().slice(0, 512)) || tab.saved.title,
          loading: contents.isLoading(),
          unloaded: tab.deferredRestore === true,
          canGoBack: tab.deferredRestore
            ? (tab.saved.navigation?.activeIndex ?? 0) > 0
            : contents.navigationHistory.canGoBack(),
          canGoForward: tab.deferredRestore
            ? (tab.saved.navigation?.activeIndex ?? 0) < (tab.saved.navigation?.entries.length ?? 1) - 1
            : contents.navigationHistory.canGoForward(),
        }
      }),
  }
}

function publish(owner: Owner, group: Group) {
  if (!owner.win.isDestroyed() && !owner.win.webContents.isDestroyed())
    owner.win.webContents.send("browser-tabs", state(group))
}

function layout(owner: Owner) {
  owner.generationCheck?.()
  owner.loginCheck?.()
  owner.captureChecks?.forEach((check) => check())
  const viewport = owner.viewport
  const tab =
    viewport &&
    owner.groups.get(viewport.sessionID)?.tabs.find((tab) => tab.id === owner.groups.get(viewport.sessionID)?.activeID)
  const visible =
    !owner.suspended && owner.win.isVisible() && !owner.win.isMinimized() && tab && !tab.contents.isDestroyed()
  if (owner.attached && (owner.attached !== tab || !visible)) {
    owner.attached.cancelLoginOffer?.()
    cancelPicker(owner.attached.view.webContents)
    // Retain the native parent while hidden. Removing a WebContentsView during a
    // resize can strand its drawing surface when the window changes display scale.
    owner.attached.view.setVisible(false)
    owner.attached = undefined
    owner.captureChecks?.forEach((check) => check())
  }
  if (!visible || !viewport) return
  const zoom = owner.win.webContents.getZoomFactor()
  const size = owner.win.getContentBounds()
  const x = Math.max(0, Math.round(viewport.bounds.x * zoom))
  const y = Math.max(0, Math.round(viewport.bounds.y * zoom))
  const width = Math.max(0, Math.min(Math.round(viewport.bounds.width * zoom), size.width - x))
  const height = Math.max(0, Math.min(Math.round(viewport.bounds.height * zoom), size.height - y))
  if (!width || !height) {
    owner.attached?.cancelLoginOffer?.()
    owner.attached?.view.setVisible(false)
    owner.attached = undefined
    owner.captureChecks?.forEach((check) => check())
    return
  }
  tab.view.setBounds({ x, y, width, height })
  if (tab.device) contentsDevice(tab, width, height)
  if (tab.deferredRestore) void tab.restore?.()
  if (owner.attached !== tab) {
    if (!owner.win.contentView.children.includes(tab.view)) owner.win.contentView.addChildView(tab.view)
    tab.view.setVisible(true)
    owner.attached = tab
  }
}

async function confirmTabLeave(
  owner: Owner,
  tab: Tab,
  check: () => void,
  control: { signal: AbortSignal; deadline: number },
) {
  const controller = new AbortController()
  const cancel = () => controller.abort()
  const contents = tab.view.webContents
  const listeners: [EventEmitter, string][] = [
    ...["close", "closed", "hide", "minimize"].map((event): [EventEmitter, string] => [owner.win, event]),
    ...["destroyed", "render-process-gone"].flatMap((event): [EventEmitter, string][] => [
      [contents, event],
      [owner.win.webContents, event],
    ]),
    ...["did-navigate", "did-navigate-in-page", "dom-ready"].map((event): [EventEmitter, string] => [contents, event]),
    [owner.win.webContents, "did-start-navigation"],
  ]
  const validate = () => {
    try {
      check()
    } catch {
      cancel()
    }
  }
  // An unparented macOS message box is app-modal; give only the dialog its own sheet owner.
  const sheet =
    process.platform === "darwin"
      ? new BrowserWindow({
          width: 400,
          height: 160,
          show: false,
          title: nativeT("desktop.browser.leave"),
          webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false },
        })
      : undefined
  sheet?.on("close", cancel)
  const checks = (owner.captureChecks ??= new Set())
  checks.add(validate)
  const unwatch = watchBrowserAccess(tab, cancel)
  listeners.forEach(([emitter, event]) => emitter.on(event, cancel))
  tab.leavePending = true
  try {
    return await createLeaveConfirmation({
      check,
      signal: AbortSignal.any([controller.signal, control.signal]),
      deadline: control.deadline,
      ask: async (signal) => {
        sheet?.showInactive()
        const options = {
          type: "warning" as const,
          message: nativeT("desktop.browser.leave"),
          detail: nativeT("desktop.browser.leaveDetail"),
          buttons: [nativeT("desktop.browser.stay"), nativeT("desktop.browser.leaveConfirm")],
          defaultId: 0,
          cancelId: 0,
          signal,
        }
        const answer = await (sheet ? dialog.showMessageBox(sheet, options) : dialog.showMessageBox(options))
        return answer.response === 1
      },
    }).confirm()
  } catch {
    return false
  } finally {
    listeners.forEach(([emitter, event]) => emitter.removeListener(event, cancel))
    checks.delete(validate)
    unwatch()
    if (sheet && !sheet.isDestroyed()) sheet.destroy()
    tab.leavePending = false
  }
}

async function runLeaveIntent<T>(
  owner: Owner,
  tab: Tab,
  action: () => Promise<T> | T,
  navigation = false,
): Promise<T | undefined> {
  // Loading a destination can be superseded; a leave decision or its approved replay cannot.
  if (tab.leaveIntent && (!tab.leaveIntent.navigation || tab.leaveIntent.prompt || tab.leaveIntent.replaying))
    throw new Error(nativeT("desktop.browser.tabs.busy"))
  const contents = tab.view.webContents
  const sourceURL = contents.getURL()
  const revision = tab.revision
  const taskEpoch = owner.taskEpoch
  const deadline = Date.now() + 60_000
  const settled = Promise.withResolvers<void>()
  const intent: NonNullable<Tab["leaveIntent"]> = {
    navigation,
    controller: new AbortController(),
    deadline,
    check: () => {
      if (
        contents.isDestroyed() ||
        owner.shutting ||
        owner.taskEpoch !== taskEpoch ||
        !owner.groups.get(tab.sessionID)?.tabs.includes(tab) ||
        !!tab.agentClose ||
        (tab.revision !== revision && (!intent.vetoed || tab.revision !== intent.vetoRevision)) ||
        contents.getURL() !== sourceURL ||
        Date.now() >= deadline ||
        intent.controller.signal.aborted ||
        tab.leaveIntent !== intent
      )
        throw new Error("Leave intent expired or changed")
    },
    replay: action,
    settled: settled.promise,
    settle: settled.resolve,
  }
  tab.leaveIntent = intent
  try {
    let result: T | undefined
    let failure: unknown
    try {
      result = await action()
    } catch (error) {
      failure = error
    } finally {
      intent.settle()
    }
    if (intent.prompt) {
      const leave = await intent.prompt.catch(() => false)
      if (leave) {
        await intent.settled
        intent.check()
        intent.replaying = true
        return await action()
      }
      return undefined
    }
    if (failure) throw failure
    return result
  } finally {
    intent.controller.abort()
    if (tab.leaveIntent === intent) tab.leaveIntent = undefined
  }
}

function runPendingNavigation(contents: WebContents, action: () => void) {
  const events: EventEmitter = contents
  return new Promise<void>((resolve) => {
    let settled = false
    const finish = () => {
      if (settled) return
      settled = true
      clearTimeout(timeout)
      contents.removeListener("did-finish-load", finish)
      contents.removeListener("did-stop-loading", finish)
      contents.removeListener("did-navigate-in-page", finish)
      contents.removeListener("did-fail-load", failed)
      contents.removeListener("destroyed", finish)
      events.removeListener("-before-unload-fired", unloaded)
      resolve()
    }
    const failed = (_event: Electron.Event, _code: number, _description: string, _url: string, main: boolean) => {
      if (main) finish()
    }
    const unloaded = (_event: Electron.Event, proceed: boolean) => {
      if (!proceed) finish()
    }
    const timeout = setTimeout(finish, 15_000)
    contents.once("did-finish-load", finish)
    contents.once("did-stop-loading", finish)
    contents.once("did-navigate-in-page", finish)
    contents.on("did-fail-load", failed)
    contents.once("destroyed", finish)
    events.once("-before-unload-fired", unloaded)
    action()
  })
}

function closeTabAttempt(contents: WebContents) {
  const events: EventEmitter = contents
  return new Promise<void>((resolve) => {
    const finish = () => {
      contents.removeListener("destroyed", finish)
      events.removeListener("-before-unload-fired", unloaded)
      resolve()
    }
    const unloaded = (_event: Electron.Event, proceed: boolean) => {
      if (!proceed) finish()
    }
    contents.once("destroyed", finish)
    events.once("-before-unload-fired", unloaded)
    contents.close({ waitForBeforeUnload: true })
  })
}

function contentsDevice(tab: Tab, width: number, height: number) {
  tab.view.webContents.enableDeviceEmulation(deviceEmulation(tab.deviceSize ?? BROWSER_DEVICE_DEFAULT, width, height))
}

function applyBrowserZoom(contents: WebContents) {
  if (!contents.isDestroyed()) contents.setZoomFactor(browserZoomFactor(contents.getURL()))
}

function updateBrowserZoom(contents: WebContents, factor: number) {
  const origin = presentationOrigin(contents.getURL())
  if (!origin) {
    contents.setZoomFactor(factor)
    return
  }
  saveBrowserZoom(contents.getURL(), factor)
  owners.forEach((entry) =>
    entry.groups.forEach((entryGroup) =>
      entryGroup.tabs.forEach((entryTab) => {
        if (presentationOrigin(entryTab.contents.getURL()) === origin) applyBrowserZoom(entryTab.view.webContents)
      }),
    ),
  )
}

const sitePermissionPrompts = new WeakSet<Owner>()
const resourceCaptures = new WeakSet<WebContents>()
type PracticalPermission = "notifications" | "displayCapture" | "clipboard"

function permissionTarget(contents: WebContents | null, requested: string, main: boolean) {
  if (!contents || contents.isDestroyed() || !main) return
  const url = contents.getURL()
  const origin = siteOrigin(url)
  if (!origin || siteOrigin(requested) !== origin || contents.mainFrame.url !== url || contents.mainFrame.detached)
    return
  const owner = [...owners.values()].find((entry) => entry.attached?.view.webContents === contents)
  const tab = owner?.attached
  const group = tab && owner?.groups.get(tab.sessionID)
  if (
    !owner ||
    !tab ||
    !group ||
    owner.shutting ||
    owner.suspended ||
    owner.win.isDestroyed() ||
    owner.win.webContents.isDestroyed() ||
    !owner.win.isVisible() ||
    owner.win.isMinimized() ||
    !owner.win.contentView.children.includes(tab.view) ||
    owner.viewport?.sessionID !== tab.sessionID ||
    (owner.linkContext && owner.linkContext.sessionID !== tab.sessionID) ||
    !owner.viewport.bounds.width ||
    !owner.viewport.bounds.height ||
    group.activeID !== tab.id ||
    !group.tabs.includes(tab) ||
    browserRegistration(tab.sessionID, tab.id) !== tab ||
    tab.ownerID !== owner.win.webContents.id ||
    tab.contents !== contents ||
    tab.agentAccess ||
    tab.loginBusy ||
    tab.agentClose ||
    tab.recovery ||
    tab.permissionReload ||
    tab.permissionReloadPhase ||
    tab.loadFailed ||
    contents.isLoadingMainFrame() ||
    browserOperationBusy.has(tab.id) ||
    browserInputFailure(contents)
  )
    return
  return { owner, tab, group, origin, url }
}

function practicalTarget(
  contents: WebContents | null,
  requested: string,
  main: boolean,
  permission: PracticalPermission,
) {
  if (permission === "notifications" && !Notification.isSupported()) return
  if (permission === "displayCapture" && !displayCaptureSupported()) return
  return permissionTarget(contents, requested, main)
}

function practicalPermissionValue(origin: string, permission: PracticalPermission) {
  if (permission === "notifications") return notificationPermission(origin)
  return practicalPermission(origin, permission)
}

function savePracticalPermission(origin: string, permission: PracticalPermission) {
  if (permission === "notifications") return saveSitePermission(origin, undefined, undefined, "allow")
  if (permission === "displayCapture") return saveSitePermission(origin, undefined, undefined, undefined, "allow")
  return saveSitePermission(origin, undefined, undefined, undefined, undefined, "allow")
}

function requestPracticalPermission(
  contents: WebContents | null,
  callback: (allowed: boolean) => void,
  details: { requestingUrl: string; isMainFrame: boolean },
  permission: PracticalPermission,
) {
  const target = practicalTarget(contents, details.requestingUrl, details.isMainFrame, permission)
  if (!target || !contents || details.requestingUrl !== target.url || sitePermissionPrompts.has(target.owner)) {
    callback(false)
    return
  }
  const value = practicalPermissionValue(target.origin, permission)
  if (value !== "ask") {
    callback(value === "allow")
    return
  }
  const { owner, tab, group, origin, url } = target
  const frame = contents.mainFrame
  const revision = tab.revision
  const accessRevision = tab.accessRevision
  const taskEpoch = owner.taskEpoch
  const policy = sitePermissionsRevision()
  const consent = new AbortController()
  const checks = (owner.captureChecks ??= new Set())
  const listeners: [EventEmitter, string][] = [
    ...["hide", "minimize", "close", "closed"].map((event): [EventEmitter, string] => [owner.win, event]),
    ...["did-start-navigation", "render-process-gone", "destroyed"].flatMap((event): [EventEmitter, string][] => [
      [contents, event],
      [owner.win.webContents, event],
    ]),
  ]
  let settled = false
  const valid = () => {
    const current = practicalTarget(contents, url, true, permission)
    return (
      current?.owner === owner &&
      current.tab === tab &&
      current.group === group &&
      contents.mainFrame === frame &&
      !frame.detached &&
      contents.getURL() === url &&
      tab.revision === revision &&
      tab.accessRevision === accessRevision &&
      owner.taskEpoch === taskEpoch &&
      sitePermissionsRevision() === policy &&
      practicalPermissionValue(origin, permission) === "ask"
    )
  }
  const finish = (allow: boolean) => {
    if (settled) return
    settled = true
    clearTimeout(timer)
    clearInterval(monitor)
    checks.delete(check)
    listeners.forEach(([emitter, event]) => emitter.removeListener(event, revoke))
    sitePermissionPrompts.delete(owner)
    consent.abort()
    let granted = false
    try {
      if (allow && valid()) {
        // Persist before granting: Electron rechecks permission on property/show paths.
        savePracticalPermission(origin, permission)
        granted = true
      }
    } catch {
      // A corrupt/unwritable policy never becomes a transient grant.
    }
    callback(granted)
    if (granted)
      owners.forEach((entry) => {
        entry.captureChecks?.forEach((check) => check())
        entry.groups.forEach((group) => publish(entry, group))
      })
  }
  const revoke = () => finish(false)
  const check = () => {
    if (!valid()) revoke()
  }
  const monitor = setInterval(check, 100)
  monitor.unref()
  const timer = setTimeout(revoke, 30_000)
  sitePermissionPrompts.add(owner)
  checks.add(check)
  listeners.forEach(([emitter, event]) => emitter.on(event, revoke))
  try {
    void dialog
      .showMessageBox(owner.win, {
        type: "question",
        message: nativeT(`desktop.browser.${permission}.title`, { origin }),
        detail: nativeT(`desktop.browser.${permission}.detail`, { task: tab.sessionID, tab: tab.id }),
        buttons: [nativeT("desktop.browser.cancel"), nativeT("desktop.browser.allow")],
        defaultId: 0,
        cancelId: 0,
        signal: consent.signal,
      })
      .then((answer) => finish(answer.response === 1), revoke)
  } catch {
    revoke()
  }
}

function createTab(
  owner: Owner,
  group: Group,
  popup?: { preferences?: WebPreferences; webContents?: WebContents; openerID: string },
  saved: SavedTab = { url: "about:blank", title: "" },
  position?: number,
  deferredRestore = false,
  activate = true,
  agentCreated = false,
) {
  if (group.tabs.length >= 32) throw new Error("Browser tab limit reached")
  if (!profileReady) {
    const profile = session.fromPartition(BROWSER_PARTITION)
    // Electron-created popups ignore per-WebContents/session UA overrides on their
    // first navigation (electron/electron#45897). Keep its fallback Chromium-based too.
    app.userAgentFallback = app.userAgentFallback.replace(/\s(?:Electron|OpenCodeDev|OpenCode|CookieMonster)\/\S+/g, "")
    profile.setUserAgent(app.userAgentFallback)
    profile.setPermissionCheckHandler((contents, permission, requested, details) => {
      const practical =
        permission === "notifications"
          ? "notifications"
          : permission === "display-capture"
            ? "displayCapture"
            : ["clipboard-read", "clipboard-sanitized-write", "deprecated-sync-clipboard-read"].includes(permission)
              ? "clipboard"
              : undefined
      if (practical) {
        const target = practicalTarget(contents, requested, details.isMainFrame, practical)
        return (
          !!target &&
          details.requestingUrl === target.url &&
          practicalPermissionValue(target.origin, practical) === "allow"
        )
      }
      if (!contents || permission !== "media") return false
      const origin = mediaOrigin(contents.getURL(), requested, details.isMainFrame)
      if (!origin) return false
      if (details.mediaType === "audio" || details.mediaType === "video")
        return mediaPermission(origin, details.mediaType) === "allow"
      return mediaPermission(origin, "audio") === "allow" && mediaPermission(origin, "video") === "allow"
    })
    profile.setPermissionRequestHandler((contents, permission, callback, details) => {
      const practical =
        permission === "notifications"
          ? "notifications"
          : permission === "display-capture"
            ? "displayCapture"
            : ["clipboard-read", "clipboard-sanitized-write", "deprecated-sync-clipboard-read"].includes(permission)
              ? "clipboard"
              : undefined
      if (practical) {
        requestPracticalPermission(
          contents,
          (allowed) => {
            if (allowed && practical === "displayCapture" && contents) resourceCaptures.add(contents)
            callback(allowed)
          },
          details,
          practical,
        )
        return
      }
      const origin = contents && mediaOrigin(contents.getURL(), details.requestingUrl, details.isMainFrame)
      const media = "mediaTypes" in details ? details.mediaTypes : undefined
      // Electron reports getDisplayMedia through this hook as media with no camera/microphone types.
      if (permission === "media" && origin && media?.length === 0) {
        requestPracticalPermission(
          contents,
          (allowed) => {
            if (allowed && contents) resourceCaptures.add(contents)
            callback(allowed)
          },
          details,
          "displayCapture",
        )
        return
      }
      if (
        permission !== "media" ||
        !origin ||
        !media?.length ||
        media.some((type) => mediaPermission(origin, type) === "block")
      ) {
        callback(false)
        return
      }
      if (media.every((type) => mediaPermission(origin, type) === "allow")) {
        if (contents) resourceCaptures.add(contents)
        callback(true)
        return
      }
      const owner = [...owners.values()].find((entry) => entry.attached?.view.webContents === contents)
      if (!owner || !owner.win.isVisible()) {
        callback(false)
        return
      }
      owner.suspended++
      layout(owner)
      void dialog
        .showMessageBox(owner.win, {
          type: "question",
          message: nativeT("desktop.browser.media", { origin }),
          detail: nativeT(
            media.includes("audio") && media.includes("video")
              ? "desktop.browser.media.both"
              : media.includes("video")
                ? "desktop.browser.media.camera"
                : "desktop.browser.media.microphone",
          ),
          buttons: [nativeT("desktop.browser.cancel"), nativeT("desktop.browser.allow")],
          defaultId: 0,
          cancelId: 0,
        })
        .then(
          (answer) => {
            const allowed =
              answer.response === 1 &&
              !contents.isDestroyed() &&
              mediaOrigin(contents.getURL(), origin, true) === origin &&
              media.every((type) => mediaPermission(origin, type) !== "block")
            if (allowed) resourceCaptures.add(contents)
            callback(allowed)
          },
          () => callback(false),
        )
        .finally(() => {
          owner.suspended--
          layout(owner)
        })
    })
    profile.setDevicePermissionHandler(() => false)
    profile.on("will-download", (event, item, source) => {
      const target = [...owners.values()]
        .flatMap((owner) => [...owner.groups.values()].map((group) => ({ owner, group })))
        .find(({ group }) => group.tabs.some((tab) => tab.contents === source))
      if (!target || target.owner.win.isDestroyed()) {
        event.preventDefault()
        return
      }
      const tab = target.group.tabs.find((tab) => tab.contents === source)!
      if (!allowDownload(target.owner.win, tab, item.getFilename(), item.getURL())) {
        event.preventDefault()
        return
      }
      const download: BrowserDownload = {
        id: randomUUID(),
        filename: basename(item.getFilename().replaceAll("\\", "/")),
        state: "saving",
        time: Date.now(),
        received: 0,
        total: item.getTotalBytes(),
        paused: false,
        canControl: true,
      }
      const staged = stagedDownload(
        target.owner.win,
        item,
        download,
        URL.canParse(tab.contents.getURL()) ? new URL(tab.contents.getURL()).origin : "",
      )
      trackDownload(event, item, download, {
        save: (row, path) => recordDownload(row, new Set([...transfers.keys(), ...recoveringDownloads()]), path),
        checkpoint: staged?.checkpoint,
        finish: staged?.finish,
        preserveOnNativeCancel: !!staged,
        start: () => {
          // Admission is durable before any destination is reserved or configured.
          item.setSaveDialogOptions({
            title: nativeT("desktop.browser.saveDownload"),
            defaultPath: join(downloadDirectory(), download.filename),
          })
          if (staged) staged.start()
          if (!staged && !browserPreferencesState().askDownloadLocation) {
            try {
              item.setSavePath(reserveDownload(downloadDirectory(), download.filename))
            } catch {
              // If the chosen directory is missing or unwritable, fall back to the native chooser.
              item.setSaveDialogOptions({
                title: nativeT("desktop.browser.saveDownload"),
                defaultPath: join(app.getPath("downloads"), download.filename),
              })
            }
          }
          target.group.downloads = [
            download,
            ...(target.group.downloads ?? []).filter((entry, index) => entry.state === "saving" || index < 4),
          ]
          transfers.set(download.id, { item, ...target, download })
        },
        release: () => {
          transfers.delete(download.id)
          staged?.release()
          void pruneDownloadRecovery().catch(() => undefined)
        },
        publish: () => publish(target.owner, target.group),
      })
    })
    profile.setDisplayMediaRequestHandler((_request, callback) => callback({}), {
      useSystemPicker: displayCaptureSupported(),
    })
    profileReady = true
    void pruneDownloadRecovery().catch(() => undefined)
  }
  // Keep Electron's popup plumbing, but never inherit a preload or privileged preferences.
  const view = new WebContentsView({
    ...(popup?.webContents ? { webContents: popup.webContents } : {}),
    webPreferences: { ...popup?.preferences, ...browserPreferences, preload: undefined },
  })
  const contents = view.webContents
  const disposeMenu = contextMenu({
    window: contents,
    shouldShowMenu: () => shouldShowBrowserContextMenu(contents),
    showSearchWithGoogle: false,
    showLookUpSelection: false,
    showSaveImageAs: true,
    prepend: (_actions, params) => browserLinkMenu(contents, params.linkURL),
  })
  contents.once("destroyed", disposeMenu)
  const tab: Tab = {
    saved: projectSavedTab(saved) ?? { url: recoveryURL(saved.url), title: saved.title.slice(0, 512) },
    id: randomUUID(),
    ownerID: owner.win.webContents.id,
    sessionID: group.sessionID,
    contents,
    view,
    agentAccess: false,
    agentCreated,
    transferGuarded: agentCreated || group.tabs.some((tab) => tab.id === popup?.openerID && tab.transferGuarded),
    revision: 0,
    openerID: popup?.openerID,
    loadFailed: false,
    deferredRestore,
  }
  tab.ownerContext = () => `${owner.authorityID}_${owner.taskEpoch}`
  let ownerScope: BrowserOwnerScope | undefined
  tab.resolveOwnerScope = async (signal) => {
    if (ownerScope && browserOwnerScopeCurrent(ownerScope.generation)) return ownerScope
    const scope = await resolveBrowserOwnerScope(tab.sessionID, signal)
    if (contents.isDestroyed() || owner.groups.get(group.sessionID) !== group || !group.tabs.includes(tab))
      throw new Error("Browser tab owner changed")
    ownerScope = scope
    return scope
  }
  tab.ownerScope = () => (ownerScope && browserOwnerScopeCurrent(ownerScope.generation) ? ownerScope : undefined)
  tab.ownerScopeReady = tab.resolveOwnerScope(AbortSignal.timeout(3000))
  void tab.ownerScopeReady.catch(() => undefined)
  tab.captureOwner = (screenshot) => {
    const epoch = owner.screenshotEpoch
    const taskEpoch = owner.taskEpoch
    const check = () => {
      if (
        owner.screenshotEpoch !== epoch ||
        owner.taskEpoch !== taskEpoch ||
        owner.suspended ||
        tab.leavePending ||
        owner.shutting ||
        owner.win.isDestroyed() ||
        owner.win.webContents.isDestroyed() ||
        !owner.win.isVisible() ||
        owner.win.isMinimized() ||
        owners.get(tab.ownerID) !== owner ||
        owner.groups.get(tab.sessionID) !== group ||
        !group.tabs.includes(tab) ||
        (owner.linkContext?.sessionID ?? owner.viewport?.sessionID) !== tab.sessionID ||
        (screenshot &&
          (group.activeID !== tab.id || owner.attached !== tab || !owner.win.contentView.children.includes(tab.view)))
      )
        throw new Error("Browser capture owner changed")
    }
    check()
    return check
  }
  tab.observeNetwork = (durationMs, check, signal) =>
    observeNetwork(contents.session.webRequest, contents, durationMs, check, signal)
  if (tab.transferGuarded) {
    tab.uploadGuard = guardUploads(owner.win, tab, contents)
    void tab.uploadGuard.catch(() => {
      if (!contents.isDestroyed()) contents.close()
    })
  }
  const firstUnpinned = group.tabs.findIndex((entry) => entry.saved.pinned !== true)
  const target = position ?? (tab.saved.pinned === true && firstUnpinned >= 0 ? firstUnpinned : group.tabs.length)
  group.tabs.splice(Math.max(0, Math.min(target, group.tabs.length)), 0, tab)
  if (!group.restoring && activate) group.activeID = tab.id
  const unregister = registerBrowserTab(tab)
  tab.operationChanged = () => {
    if (!contents.isDestroyed() && owner.groups.get(group.sessionID) === group && group.tabs.includes(tab)) changed()
  }
  const offers = watchLoginOffers(
    owner.win,
    contents,
    () => owner.attached === tab && owner.win.contentView.children.includes(tab.view) && !tab.agentAccess,
    () => !tab.loginBusy && !tab.leavePending && !owner.suspended,
    (value) => {
      tab.loginBusy = value
      if (value) tab.accessRevision = (tab.accessRevision ?? 0) + 1
    },
    () => publish(owner, group),
  )
  tab.cancelLoginOffer = offers.disable
  tab.readyLoginOffers = offers.ready
  const changed = () => publish(owner, group)
  const invalidate = () => {
    invalidateBrowserDocument(tab)
    cancelPicker(contents)
  }
  contents.on("will-frame-navigate", (event) => {
    if (
      event.isMainFrame &&
      !(tab.permissionReplacing && event.url === "about:blank") &&
      (tab.agentClose || !browserNavigationURL(event.url) || tab.navigationAllowed?.(event.url) === false)
    )
      event.preventDefault()
  })
  contents.on("will-redirect", (event, url, _inPlace, main) => {
    if (main && (!browserNavigationURL(url) || tab.navigationAllowed?.(url) === false)) event.preventDefault()
  })
  contents.on("did-start-navigation", (_event, url, inPlace, main) => {
    if (!main) return

    // Supersede the callback, not the last recoverable snapshot; a retry may fail or stop.
    if (tab.recovery?.started) tab.recovery = undefined
    if (tab.recovery) tab.recovery.started = true
    if (!inPlace && tab.permissionReloadPhase) tab.permissionReloadPhase = "loading"
    tab.loadFailed = false
    tab.failure = undefined
    tab.find = undefined
    tab.findRequest = undefined
    tab.siteData = undefined
    invalidate()
    changed()
  })
  contents.on("dom-ready", () => {
    invalidate()
    // Embedded pages must never participate in the shell's native window drag regions.
    // User-origin CSS also overrides a site's own !important drag rules; navigation removes it.
    void contents.insertCSS("* { app-region: no-drag !important; }", { cssOrigin: "user" }).catch(() => undefined)
    if (tab.device) {
      // A new document can reset Chromium's emulation while the per-tab preview stays enabled.
      const bounds = tab.view.getBounds()
      contentsDevice(tab, bounds.width, bounds.height)
    }
    changed()
  })
  contents.on("did-fail-load", (_event, code, description, _url, main) => {
    if (!main || code === -3) return
    tab.loadFailed = true
    tab.failure = {
      kind: "load",
      code: String(code),
      message: nativeT("desktop.browser.pageLoadCause", { cause: description.slice(0, 256), code }),
    }
    changed()
  })
  const navigated = () => {
    if (!tab.recovery && !tab.loadFailed) {
      const navigation = recoveryNavigation({
        entries: contents.navigationHistory.getAllEntries(),
        activeIndex: contents.navigationHistory.getActiveIndex(),
      })
      tab.saved = projectSavedTab({
        url: recoveryURL(contents.getURL()),
        title: contents.getTitle().slice(0, 512),
        pinned: tab.saved.pinned === true,
        navigation,
      })!
      persistGroup(owner, group)
    }
    changed()
  }
  tab.restore = () => {
    if (!tab.deferredRestore && tab.restorePromise) return tab.restorePromise
    if (contents.isDestroyed()) return Promise.resolve()
    tab.deferredRestore = false
    const recovery = { started: false, restoring: group.restoring || !!tab.saved.navigation }
    tab.recovery = recovery
    tab.restorePromise = (
      tab.saved.navigation
        ? contents.navigationHistory.restore({
            entries: tab.saved.navigation.entries,
            index: tab.saved.navigation.activeIndex,
          })
        : contents.loadURL(tab.saved.url)
    ).then(
      () => {
        if (contents.isDestroyed() || tab.recovery !== recovery || tab.loadFailed) return
        tab.recovery = undefined
        navigated()
      },
      () => {
        if (contents.isDestroyed() || tab.recovery !== recovery) return
        tab.loadFailed = true
        changed()
      },
    )
    return tab.restorePromise
  }
  contents.on("did-navigate", () => {
    resourceCaptures.delete(contents)
    tab.notice = undefined
    // A main-frame document commit covers all prior requests, including ones queued before this commit.
    tab.permissionReload = false
    tab.permissionReloadQueued = false
    invalidate()
    applyBrowserZoom(contents)
    navigated()
  })
  contents.on("did-navigate-in-page", (_event, _url, main) => {
    if (main) {
      applyBrowserZoom(contents)
      navigated()
    }
  })
  contents.on("did-finish-load", () => {
    rememberPage(contents.getURL(), contents.getTitle())
    changed()
  })
  contents.on("did-navigate-in-page", (_event, url, main) => {
    if (main) rememberPage(url, contents.getTitle())
  })
  contents.on("found-in-page", (_event, result) => {
    if (result.requestId !== tab.findRequest) return
    tab.find = { active: result.activeMatchOrdinal, matches: result.matches }
    changed()
  })
  contents.on("did-start-loading", changed)
  contents.on("did-stop-loading", () => {
    // A stopped attempt (including 204/abort/failure) permits recovery but does not prove document disposal.
    if (tab.permissionReloadPhase === "loading") {
      tab.permissionReloadPhase = undefined
      reloadForPermissions(tab, false)
    }
    changed()
  })
  contents.on("page-title-updated", navigated)
  contents.on("render-process-gone", (_event, details) => {
    tab.loadFailed = true
    tab.failure = {
      kind: "crash",
      code: details.reason,
      message: nativeT("desktop.browser.pageCrashCause", { cause: details.reason }),
    }
    revokeBrowserAccess(tab)
    invalidate()
    changed()
  })
  contents.on("will-prevent-unload", (event) => {
    const pending = tab.agentClose
    const intent = tab.leaveIntent
    // A site cannot keep capturing by vetoing the document replacement after its permission is revoked.
    if (tab.permissionReplacing || (tab.permissionReloadPhase && !pending)) {
      event.preventDefault()
      return
    }
    if (pending?.retrying || intent?.replaying) {
      try {
        pending?.check()
        intent?.check()
        event.preventDefault()
        if (intent?.replaying) intent.replaying = false
      } catch {
        return
      }
      return
    }
    try {
      pending?.check()
    } catch {
      if (pending) {
        pending.prompt ??= pending.settledPromise!.then(() => pending.stay?.()).then(() => false)
      }
      return
    }
    if (intent) {
      intent.vetoed = true
      intent.vetoRevision = tab.revision
      intent.prompt ??= confirmTabLeave(owner, tab, intent.check, {
        signal: intent.controller.signal,
        deadline: intent.deadline,
      })
      return
    }
    if (!pending) {
      if (tab.resourcePending) return
      tab.notice = {
        code: "untracked_leave",
        message: nativeT("desktop.browser.untrackedLeave"),
      }
      changed()
      return
    }
    pending.prompt ??= confirmTabLeave(owner, tab, pending.check, pending)
      .then(async (leave) => {
        await pending.settledPromise
        if (!leave) {
          pending.stay?.()
          return false
        }
        pending.check()
        pending.retrying = true
        pending.retry?.()
        return true
      })
      .catch(() => {
        pending.stay?.()
        return false
      })
  })
  contents.setWindowOpenHandler(({ url }) => {
    if (!browserNavigationURL(url || "about:blank") || group.tabs.length >= 32) return { action: "deny" }
    return {
      action: "allow",
      outlivesOpener: true,
      overrideBrowserWindowOptions: { webPreferences: browserPreferences },
      createWindow: (options) =>
        createTab(owner, group, {
          preferences: options.webPreferences,
          // Electron supplies this at runtime but omits it from BrowserWindowConstructorOptions.
          webContents: (options as { webContents?: WebContents }).webContents,
          openerID: tab.id,
        }).view.webContents,
    }
  })
  contents.on("before-input-event", (event, input) => {
    if (input.type !== "keyDown" || owner.attached !== tab) return
    const shortcut = browserShortcut({
      key: input.key,
      ctrlKey: input.control,
      metaKey: input.meta,
      altKey: input.alt,
      shiftKey: input.shift,
    })
    if (shortcut) {
      event.preventDefault()
      if (shortcut === "address" || shortcut === "find") owner.win.webContents.focus()
      owner.win.webContents.send("browser-shortcut", { sessionID: group.sessionID, shortcut })
      return
    }
    if (input.type !== "keyDown" || !(input.control || input.meta) || input.alt) return
    if (!["+", "=", "-", "0"].includes(input.key)) return
    event.preventDefault()
    updateBrowserZoom(
      contents,
      input.key === "0"
        ? 1
        : Math.max(0.5, Math.min(3, contents.getZoomFactor() * (input.key === "-" ? 1 / 1.2 : 1.2))),
    )
    changed()
  })
  contents.once("destroyed", () => {
    tab.recovery = undefined
    unregister()
    if (owner.attached === tab) {
      owner.attached = undefined
    }
    if (!owner.win.isDestroyed() && owner.win.contentView.children.includes(view))
      owner.win.contentView.removeChildView(view)
    const index = group.tabs.indexOf(tab)
    if (!tab.resourceReplacement && !owner.shutting && !owner.win.isDestroyed())
      group.closed = [{ ...tab.saved, id: randomUUID(), time: Date.now() }, ...group.closed].slice(0, 20)
    group.tabs.splice(index, 1)
    if (tab.resourceReplacement && !owner.shutting && !owner.win.isDestroyed())
      createTab(owner, group, undefined, tab.resourceReplacement, index, true, false)
    if (group.activeID === tab.id) group.activeID = group.tabs[Math.max(0, index - 1)]?.id
    persistGroup(owner, group)
    if (!owner.win.isDestroyed()) {
      layout(owner)
      changed()
    }
  })
  layout(owner)
  changed()
  persistGroup(owner, group)
  if (!popup && !deferredRestore) void tab.restore()
  return tab
}

export async function browserCommand(owner: Owner, sessionID: string, value: unknown) {
  if (!value || typeof value !== "object") throw new Error("Invalid browser command")
  // Native commands are top-only; frame consent never authorizes credential delivery.
  if (hasFrameTarget(value as Record<string, unknown>))
    throw new Error(nativeT("desktop.browser.driver.frameUnavailable"))
  const command = value as BrowserCommand
  const group = groupFor(owner, sessionID)
  if (command.op === "open-link") {
    if (
      !browserNavigationURL(command.url) ||
      command.url === "about:blank" ||
      !["browser", "external"].includes(command.destination)
    )
      throw new Error("Invalid link")
    if (command.destination === "external") await shell.openExternal(command.url)
    if (command.destination === "browser") createTab(owner, group, undefined, { url: command.url, title: "" })
    return state(group)
  }
  if (command.op === "lock-vault") {
    vaultAccess.lock()
    return state(group)
  }
  if (command.op === "unlock-vault") {
    if (owner.suspended || !vaultAvailable()) throw new Error("Vault authentication unavailable")
    owner.suspended++
    layout(owner)
    try {
      await vaultAccess.unlock(owner.win)
    } finally {
      owner.suspended--
      layout(owner)
    }
    return state(group)
  }
  if (command.op === "state") return state(group)
  if (command.op === "agent-pause") {
    if (typeof command.paused !== "boolean") throw new Error(nativeT("desktop.browser.operationUnavailable"))
    if (!command.paused && group.tabs.some((tab) => tab.loginBusy)) throw new Error(nativeT("desktop.browser.tabs.busy"))
    setBrowserTaskPaused(sessionID, command.paused)
    owners.forEach((entry) => {
      const current = entry.groups.get(sessionID)
      if (current) publish(entry, current)
    })
    return state(group)
  }
  if (command.op === "new") {
    createTab(owner, group)
    return state(group)
  }
  if (command.op === "reopen" || command.op === "open-history") {
    const entry =
      command.op === "reopen"
        ? command.id === undefined
          ? group.closed[0]
          : group.closed.find((row) => row.id === command.id)
        : historyRows().find((row) => row.id === command.id)
    if (!entry) return state(group)
    createTab(owner, group, undefined, entry)
    if (command.op === "reopen") group.closed = group.closed.filter((row) => row.id !== entry.id)
    persistGroup(owner, group)
    publish(owner, group)
    return state(group)
  }
  if (command.op === "download-control") {
    if (command.action === "cancel" && cancelRecoveredDownload(owner.win, sessionID, command.id)) return state(group)
    const transfer = transfers.get(command.id)
    if (
      !transfer ||
      transfer.owner !== owner ||
      transfer.group !== group ||
      !["pause", "resume", "cancel"].includes(command.action)
    )
      throw new Error("Download is not active in this session")
    if (command.action === "pause") transfer.item.pause()
    if (command.action === "resume") transfer.item.resume()
    if (command.action === "cancel") {
      transfer.download.state = "cancelled"
      transfer.item.cancel()
    }
    if (transfers.has(command.id)) transfer.download.paused = transfer.item.isPaused()
    publish(owner, group)
    return state(group)
  }
  if (
    [
      "import",
      "clear",
      "clear-selected",
      "forget-history",
      "forget-download",
      "settings",
      "forget-login",
      "edit-login",
      "contact-save",
      "contact-delete",
      "allow-login-offers",
      "preferences",
      "download-directory",
      "reveal-download",
      "recover-download",
      "site-permission",
      "transfer-rule",
      "bookmark-save",
      "bookmark-delete",
      "bookmark-move",
      "bookmark-import",
      "bookmark-export",
      "vault-backup",
      "device-preset-save",
      "device-preset-delete",
    ].includes(command.op)
  ) {
    owner.suspended++
    layout(owner)
    try {
      if (command.op === "allow-login-offers") allowLoginOffers(command.origin)
      if (command.op === "transfer-rule") saveTransferRule(command.rule, command.remove)
      if (command.op === "bookmark-save") saveBookmark(command)
      if (command.op === "bookmark-delete") deleteBookmark(command.id)
      if (command.op === "bookmark-move") moveBookmark(command.id, command.direction)
      if (command.op === "bookmark-export") await transferBookmarks(owner.win)
      if (command.op === "device-preset-save") saveBrowserDevicePreset(command)
      if (command.op === "device-preset-delete") deleteBrowserDevicePreset(command.id)
      if (command.op === "import" || command.op === "bookmark-import") {
        const taskEpoch = owner.taskEpoch
        const windowEpoch = owner.screenshotEpoch
        const renderer = owner.win.webContents
        await importBrowserData(
          owner.win,
          session.fromPartition(BROWSER_PARTITION),
          command.op === "import" ? command.kind : "bookmarks",
          () => {
            if (
              owner.shutting ||
              owners.get(renderer.id) !== owner ||
              owner.groups.get(sessionID) !== group ||
              owner.taskEpoch !== taskEpoch ||
              owner.screenshotEpoch !== windowEpoch ||
              (owner.linkContext && owner.linkContext.sessionID !== sessionID)
            )
              throw new Error()
          },
        )
      }
      if (command.op === "vault-backup") {
        const taskEpoch = owner.taskEpoch
        const windowEpoch = owner.screenshotEpoch
        const renderer = owner.win.webContents
        await transferVaultBackup(owner.win, command.direction, () => {
          if (
            owner.shutting ||
            owners.get(renderer.id) !== owner ||
            owner.groups.get(sessionID) !== group ||
            owner.taskEpoch !== taskEpoch ||
            owner.screenshotEpoch !== windowEpoch ||
            (owner.linkContext && owner.linkContext.sessionID !== sessionID)
          )
            throw new Error()
        })
      }
      if (command.op === "settings") browserSettings(command.rememberHistory)
      if (command.op === "preferences") {
        saveBrowserPreferences(command.values)
        setBrowserAgentEnabled(browserPreferencesState().agentEnabled)
        if (command.values.restoreTabs === false) clearTabRecovery()
        if (command.values.restoreTabs === true)
          owners.forEach((entry) => entry.groups.forEach((group) => persistGroup(entry, group)))
      }
      if (command.op === "forget-history" || command.op === "forget-download") {
        if (typeof command.id !== "string") throw new Error("Invalid record")
        const key = command.op === "forget-history" ? "history" : "downloads"
        const rows =
          key === "history" ? historyRows() : (getStore("cm-browser").get("downloads", []) as { id: string }[])
        getStore("cm-browser").set(
          key,
          rows.filter((row) => row.id !== command.id),
        )
        if (command.op === "forget-download") await pruneDownloadRecovery()
      }
      if (command.op === "clear-selected") {
        validateClear(command.kinds, command.range)
        const answer = await dialog.showMessageBox(owner.win, {
          type: "warning",
          message: nativeT("desktop.browser.clearSelected"),
          detail: [
            nativeT(`desktop.browser.range.${command.range}`),
            ...command.kinds.map((kind) => nativeT(`desktop.browser.clear.${kind}`)),
          ].join("\n"),
          buttons: [nativeT("desktop.browser.cancel"), nativeT("desktop.browser.clearConfirm")],
          defaultId: 0,
          cancelId: 0,
        })
        if (answer.response === 1) for (const kind of command.kinds) await clearData(kind, command.range)
      }
      if (command.op === "download-directory") await chooseDownloadDirectory(owner.win, command.reset)
      if (command.op === "reveal-download") revealDownload(command.id)
      if (command.op === "recover-download") {
        await recoverDownload(
          owner.win,
          sessionID,
          command.id,
          () => new Set([...transfers.keys(), ...recoveringDownloads()]),
          (download) => {
            group.downloads = [download, ...(group.downloads ?? []).filter((row) => row.id !== download.id)]
            if (!owner.win.isDestroyed()) publish(owner, group)
          },
        )
      }
      if (command.op === "site-permission") {
        const update = saveSitePermission(
          command.origin,
          command.camera,
          command.microphone,
          command.notifications,
          command.displayCapture,
          command.clipboard,
        )
        owners.forEach((entry) => entry.captureChecks?.forEach((check) => check()))
        const matching = [...owners.values()].flatMap((entry) =>
          [...entry.groups.values()].flatMap((group) =>
            group.tabs.filter(
              (tab) => !tab.contents.isDestroyed() && mediaOrigin(tab.contents.getURL(), update.origin, true),
            ),
          ),
        )
        if (update.displayCaptureRevoked) await Promise.all(matching.map((tab) => replaceForPermissions(tab)))
        else if (update.mediaChanged) matching.forEach((tab) => reloadForPermissions(tab))
      }
      if (command.op === "edit-login") await editLogin(owner.win, command)
      if (command.op === "forget-login") forgetLogin(command.id)
      if (command.op === "contact-save") {
        if (contactDeliveries.has(command.contact?.id)) throw new Error("Contact delivery pending; retry the edit")
        saveContact(command.contact, command.create)
      }
      if (command.op === "contact-delete") {
        const ticket = vaultAccess.require()
        const contact = readContacts().find((row) => row.id === command.id && row.revision === command.revision)
        if (!contact) throw new Error("Contact changed")
        const answer = await dialog.showMessageBox(owner.win, {
          type: "warning",
          message: nativeT("desktop.browser.contacts.delete", { label: contact.label }),
          buttons: [nativeT("desktop.browser.cancel"), nativeT("desktop.browser.clearConfirm")],
          defaultId: 0,
          cancelId: 0,
        })
        vaultAccess.require(ticket)
        if (answer.response === 1) {
          if (contactDeliveries.has(command.id)) throw new Error("Contact delivery pending; retry deletion")
          deleteContact(command.id, command.revision)
        }
      }
      if (command.op === "clear") {
        if (!["history", "cache", "cookies", "passwords", "downloads"].includes(command.kind))
          throw new Error("Invalid data type")
        const answer = await dialog.showMessageBox(owner.win, {
          type: "warning",
          message: nativeT(`desktop.browser.clear.${command.kind}`),
          buttons: [nativeT("desktop.browser.cancel"), nativeT("desktop.browser.clearConfirm")],
          defaultId: 0,
          cancelId: 0,
        })
        if (answer.response === 1) await clearData(command.kind)
      }
    } finally {
      owner.suspended--
      layout(owner)
      owners.forEach((entry) => entry.groups.forEach((group) => publish(entry, group)))
    }
    return state(group)
  }
  const tab = "tabID" in command && group.tabs.find((tab) => tab.id === command.tabID)
  if (!tab || tab.view.webContents.isDestroyed()) throw new Error("Browser tab not found")
  const contents = tab.view.webContents
  if (
    tab.leavePending &&
    !(command.op === "access" && !command.enabled) &&
    !["select", "stop", "tab-pin", "tab-move"].includes(command.op)
  )
    throw new Error(nativeT("desktop.browser.tabs.busy"))
  if (
    (tab.permissionReplacing ||
      tab.agentClose ||
      (tab.permissionReloadPhase &&
        !(command.op === "stop" && tab.permissionReloadPhase === "loading" && contents.isLoadingMainFrame()))) &&
    ["close", "close-tabs", "navigate", "back", "forward", "reload", "stop"].includes(command.op)
  )
    throw new Error(nativeT("desktop.browser.tabs.busy"))
  if (tab.resourcePending && command.op !== "select" && command.op !== "access")
    throw new Error(nativeT("desktop.browser.tabs.busy"))
  if (!["tab-pin", "tab-move", "tab-unload", "select", "close", "close-tabs"].includes(command.op)) {
    if (command.op === "navigate" && tab.deferredRestore) {
      tab.deferredRestore = false
      tab.saved = projectSavedTab({ ...tab.saved, url: command.url, navigation: undefined })!
    } else await tab.restore?.()
  }
  if (command.op === "tab-unload") {
    if (tab.deferredRestore) return state(group)
    const revision = tab.revision
    const taskEpoch = owner.taskEpoch
    const sourceURL = contents.getURL()
    const deadline = Date.now() + 60_000
    const check = () => {
      const origin = siteOrigin(sourceURL)
      const reason = browserResourceBlocker({
        active: group.activeID === tab.id,
        loading: contents.isLoading(),
        pinned: tab.saved.pinned === true,
        granted: tab.agentAccess,
        busy:
          browserTabReserved(tab) ||
          (browserOperationBusy.has(tab.id) && !tab.resourcePending) ||
          !!tab.operation ||
          !!tab.agentClose ||
          !!tab.leaveIntent ||
          !!tab.uploadGuard ||
          !!tab.loginBusy ||
          !!tab.permissionReloadPhase ||
          !!tab.permissionReplacing ||
          sitePermissionPrompts.has(owner),
        transferring:
          (group.downloads ?? []).some((entry) => entry.state === "saving") || recoveringDownloads().size > 0,
        media: contents.isCurrentlyAudible() || contents.isBeingCaptured() || resourceCaptures.has(contents),
        unsaved: false,
        unknown:
          !!origin &&
          (mediaPermission(origin, "video") === "allow" ||
            mediaPermission(origin, "audio") === "allow" ||
            practicalPermissionValue(origin, "displayCapture") === "allow"),
      })
      if (
        reason ||
        contents.isDestroyed() ||
        owner.shutting ||
        owner.win.isDestroyed() ||
        owner.taskEpoch !== taskEpoch ||
        tab.revision !== revision ||
        contents.getURL() !== sourceURL ||
        !group.tabs.includes(tab) ||
        Date.now() >= deadline
      )
        throw new Error(nativeT("desktop.browser.resources.protected"))
    }
    check()
    tab.resourcePending = true
    browserOperationBusy.add(tab.id)
    const controller = new AbortController()
    const cancel = () => controller.abort()
    const timeout = setInterval(() => {
      try {
        check()
      } catch {
        cancel()
      }
    }, 100)
    owner.win.on("close", cancel)
    owner.win.on("hide", cancel)
    owner.win.on("minimize", cancel)
    contents.once("destroyed", cancel)
    try {
      const inspect = async () => {
        const status = await inspectBrowserResources(contents)
        check()
        if (status.unsaved || status.media || status.unknown)
          throw new Error(nativeT("desktop.browser.resources.protected"))
      }
      await inspect()
      const answer = await dialog.showMessageBox(owner.win, {
        type: "warning",
        message: nativeT("desktop.browser.resources.title"),
        detail: nativeT("desktop.browser.resources.detail"),
        buttons: [nativeT("desktop.browser.cancel"), nativeT("desktop.browser.resources.unload")],
        defaultId: 0,
        cancelId: 0,
        signal: controller.signal,
      })
      if (answer.response !== 1 || controller.signal.aborted) return state(group)
      await inspect()
      tab.resourceReplacement = projectSavedTab({
        ...tab.saved,
        navigation: recoveryNavigation({
          entries: contents.navigationHistory.getAllEntries(),
          activeIndex: contents.navigationHistory.getActiveIndex(),
        }),
        url: recoveryURL(sourceURL),
        title: contents.getTitle().slice(0, 512) || tab.saved.title,
      })
      if (!tab.resourceReplacement) throw new Error(nativeT("desktop.browser.resources.protected"))
      // Native beforeunload may veto this close. Never replay or override it for resource savings.
      await closeTabAttempt(contents)
      if (!contents.isDestroyed())
        tab.notice = { code: "resource_protected", message: nativeT("desktop.browser.resources.protected") }
      return state(group)
    } finally {
      clearInterval(timeout)
      owner.win.removeListener("close", cancel)
      owner.win.removeListener("hide", cancel)
      owner.win.removeListener("minimize", cancel)
      if (!contents.isDestroyed()) contents.removeListener("destroyed", cancel)
      tab.resourcePending = false
      tab.resourceReplacement = undefined
      browserOperationBusy.delete(tab.id)
    }
  } else if (command.op === "tab-pin") {
    if (typeof command.pinned !== "boolean") throw new Error("Invalid tab pin")
    if ((tab.saved.pinned === true) === command.pinned) return state(group)
    group.tabs.splice(group.tabs.indexOf(tab), 1)
    tab.saved = projectSavedTab({ ...tab.saved, pinned: command.pinned })!
    const boundary = group.tabs.findIndex((entry) => entry.saved.pinned !== true)
    group.tabs.splice(boundary < 0 ? group.tabs.length : boundary, 0, tab)
    persistGroup(owner, group)
    return state(group)
  } else if (command.op === "tab-move") {
    if (!["left", "right"].includes(command.direction)) throw new Error("Invalid tab move")
    const pinned = tab.saved.pinned === true
    const siblings = group.tabs.filter((entry) => (entry.saved.pinned === true) === pinned)
    const position = siblings.indexOf(tab)
    const target = siblings[position + (command.direction === "left" ? -1 : 1)]
    if (target) {
      const from = group.tabs.indexOf(tab)
      const to = group.tabs.indexOf(target)
      group.tabs[from] = target
      group.tabs[to] = tab
      persistGroup(owner, group)
    }
    return state(group)
  } else if (command.op === "duplicate") {
    const index = group.tabs.indexOf(tab)
    const firstUnpinned = group.tabs.findIndex((entry) => entry.saved.pinned !== true)
    createTab(
      owner,
      group,
      undefined,
      {
        url: recoveryURL(tab.deferredRestore ? tab.saved.url : contents.getURL() || tab.saved.url),
        title: contents.getTitle().slice(0, 512) || tab.saved.title,
        pinned: false,
      },
      tab.saved.pinned === true ? (firstUnpinned < 0 ? group.tabs.length : firstUnpinned) : index + 1,
    )
    return state(group)
  } else if (command.op === "close-tabs") {
    if (!["others", "right"].includes(command.scope)) throw new Error("Invalid bulk close")
    const index = group.tabs.indexOf(tab)
    const targets = group.tabs.filter(
      (entry, entryIndex) =>
        entry !== tab && entry.saved.pinned !== true && (command.scope === "others" || entryIndex > index),
    )
    if (
      targets.some(
        (entry) => entry.agentClose || entry.leaveIntent || entry.permissionReloadPhase || entry.resourcePending,
      )
    )
      throw new Error(nativeT("desktop.browser.tabs.busy"))
    if (targets.some((entry) => entry.id === group.activeID)) {
      group.activeID = tab.id
      layout(owner)
    }
    for (const entry of targets) {
      if (entry.contents.isDestroyed()) continue
      cancelBrowserNavigation(entry.view.webContents)
      await runLeaveIntent(owner, entry, () => closeTabAttempt(entry.view.webContents))
      // Stay ends the batch, keeping all remaining unsaved work available to the user.
      if (!entry.contents.isDestroyed()) break
    }
    return state(group)
  } else if (command.op === "inspect-site") {
    const url = contents.getURL()
    const origin = browserDataOrigin(url)
    if (!origin || owner.suspended || contents.isLoadingMainFrame()) throw new Error("Invalid site")
    const revision = tab.revision
    const data = await inspectSiteData(contents, url, origin)
    if (
      contents.isDestroyed() ||
      contents.isLoadingMainFrame() ||
      tab.revision !== revision ||
      contents.getURL() !== url ||
      browserDataOrigin(contents.getURL()) !== origin
    )
      throw new Error("Site changed during inspection")
    tab.siteData = data
    return state(group)
  }
  if (command.op === "clear-site") {
    if (!browserNavigationURL(contents.getURL()) || contents.getURL() === "about:blank" || owner.suspended)
      throw new Error("Invalid site")
    const origin = new URL(contents.getURL()).origin
    owner.suspended++
    layout(owner)
    try {
      const answer = await dialog.showMessageBox(owner.win, {
        type: "warning",
        message: nativeT("desktop.browser.clearSite", { origin }),
        detail: nativeT("desktop.browser.clearSiteDetail"),
        buttons: [nativeT("desktop.browser.cancel"), nativeT("desktop.browser.clearConfirm")],
        defaultId: 0,
        cancelId: 0,
      })
      if (answer.response === 1) {
        await contents.session.clearData({
          origins: [origin],
          originMatchingMode: "origin-in-all-contexts",
          dataTypes: [
            "backgroundFetch",
            "cookies",
            "localStorage",
            "indexedDB",
            "serviceWorkers",
            "cache",
            "fileSystems",
            "webSQL",
          ],
        })
        owners.forEach((entry) =>
          entry.groups.forEach((group) =>
            group.tabs.forEach((other) => {
              if (other.contents.isDestroyed() || new URL(other.contents.getURL() || "about:blank").origin !== origin)
                return
              reloadForPermissions(other)
            }),
          ),
        )
      }
    } finally {
      owner.suspended--
      layout(owner)
    }
    return state(group)
  }
  if (command.op === "find") {
    if (
      typeof command.text !== "string" ||
      command.text.length > 512 ||
      (command.forward !== undefined && typeof command.forward !== "boolean") ||
      (command.next !== undefined && typeof command.next !== "boolean")
    )
      throw new Error("Invalid find query")
    if (!command.text) {
      contents.stopFindInPage("clearSelection")
      tab.find = undefined
      tab.findRequest = undefined
    } else
      tab.findRequest = contents.findInPage(command.text, { forward: command.forward ?? true, findNext: !command.next })
  } else if (command.op === "zoom") {
    if (
      typeof command.factor !== "number" ||
      !Number.isFinite(command.factor) ||
      command.factor < 0.5 ||
      command.factor > 3
    )
      throw new Error("Invalid zoom")
    updateBrowserZoom(contents, command.factor)
  } else if (command.op === "device") {
    const size =
      command.size === undefined ? (tab.deviceSize ?? BROWSER_DEVICE_DEFAULT) : browserDeviceSize(command.size)
    if (typeof command.enabled !== "boolean" || !size) throw new Error(nativeT("desktop.browser.device.invalid"))
    if (
      group.activeID !== tab.id ||
      owner.suspended ||
      tab.loginBusy ||
      tab.agentClose ||
      tab.permissionReloadPhase ||
      contents.isLoadingMainFrame() ||
      browserOperationBusy.has(tab.id) ||
      browserInputFailure(contents)
    )
      throw new Error(nativeT("desktop.browser.tabs.busy"))
    tab.accessConsent?.abort()
    tab.screenshotConsent?.abort()
    tab.diagnosticConsent?.abort()
    tab.siteToolConsent?.abort()
    tab.cancelLoginOffer?.()
    tab.revision++
    invalidateSnapshots(contents)
    cancelPicker(contents)
    // ponytail: per-tab memory only; navigation keeps the preview, recovery creates a fresh baseline tab.
    if (!command.enabled) contents.disableDeviceEmulation()
    tab.deviceSize = size
    tab.device = command.enabled
    layout(owner)
  } else if (command.op === "print") {
    if (group.activeID !== tab.id) throw new Error("Browser tab not active")
    await new Promise<void>((resolve, reject) =>
      contents.print({}, (success, reason) =>
        success || /cancel/i.test(reason) ? resolve() : reject(new Error("Print failed")),
      ),
    )
  } else if (command.op === "contact-fill") {
    if (tab.loginBusy || owner.suspended) throw new Error("A browser dialog or fill operation is already pending")
    const ticket = vaultAccess.require()
    const revision = tab.revision
    const origin = new URL(contents.getURL()).origin
    const contact = readContacts().find((row) => row.id === command.id && row.revision === command.revision)
    if (!contact) throw new Error("Contact changed")
    const check = (attached = false) => {
      vaultAccess.require(ticket)
      if (
        contents.isDestroyed() ||
        contents.isLoadingMainFrame() ||
        tab.revision !== revision ||
        group.activeID !== tab.id ||
        owner.viewport?.sessionID !== group.sessionID ||
        owner.win.isDestroyed() ||
        !owner.win.isVisible() ||
        owner.win.isMinimized() ||
        tab.agentAccess ||
        (attached && (owner.attached !== tab || owner.suspended !== 0)) ||
        !readContacts().some((row) => row.id === contact.id && row.revision === contact.revision)
      )
        throw new Error("Contact fill requires an unchanged active private tab and contact")
    }
    check(true)
    tab.loginBusy = true
    tab.accessRevision = (tab.accessRevision ?? 0) + 1
    const token = randomUUID()
    const expires = Date.now() + Math.min(120_000, vaultAccess.remaining())
    try {
      const keys: string[] = await contents.executeJavaScriptInIsolatedWorld(999, [
        {
          code: prepareContactScript(
            origin,
            token,
            Object.keys(contact.values).filter((key) => contact.values[key as keyof typeof contact.values]?.trim()),
          ),
        },
      ])
      check(true)
      const values = Object.fromEntries(keys.map((key) => [key, contact.values[key as keyof typeof contact.values]!]))
      owner.suspended++
      layout(owner)
      try {
        const answer = await dialog.showMessageBox(owner.win, {
          type: "question",
          message: nativeT("desktop.browser.contacts.preview"),
          detail: nativeT("desktop.browser.contacts.detail", {
            origin,
            label: contact.label,
            fields: keys
              .map(
                (key) => `${nativeT(`desktop.browser.contacts.${key as keyof typeof contact.values}`)}: ${values[key]}`,
              )
              .join("\n"),
          }),
          buttons: [nativeT("desktop.browser.cancel"), nativeT("desktop.browser.contacts.fill")],
          defaultId: 0,
          cancelId: 0,
        })
        check()
        if (answer.response === 1) {
          owner.suspended--
          layout(owner)
          try {
            check(true)
            if (contactDeliveries.has(contact.id)) throw new Error("Contact delivery already pending")
            contactDeliveries.add(contact.id)
            try {
              // Dispatched values cannot be recalled; Chromium rejects execution after this short deadline.
              await contents.executeJavaScriptInIsolatedWorld(999, [
                {
                  code: completeContactScript(
                    origin,
                    token,
                    values,
                    Math.min(expires, Date.now() + Math.min(5000, vaultAccess.remaining())),
                  ),
                },
              ])
              check(true)
            } finally {
              contactDeliveries.delete(contact.id)
            }
          } finally {
            owner.suspended++
          }
        }
      } finally {
        owner.suspended--
        layout(owner)
      }
    } finally {
      tab.loginBusy = false
      tab.revision++
      invalidateSnapshots(contents)
    }
  } else if (command.op === "generate-password") {
    if (tab.loginBusy || owner.suspended || owner.generationCheck)
      throw new Error(nativeT("desktop.browser.generation.failed"))
    await generateBrowserPassword(command, {
      contents,
      begin(validate, revoke) {
        const revision = tab.revision
        const viewport = owner.viewport
        const accessRevision = (tab.accessRevision ?? 0) + 1
        tab.accessRevision = accessRevision
        const check = (attached = false) => {
          validate()
          if (
            contents.isDestroyed() ||
            contents.isLoadingMainFrame() ||
            tab.revision !== revision ||
            tab.accessRevision !== accessRevision ||
            group.activeID !== tab.id ||
            !group.tabs.includes(tab) ||
            owner.groups.get(group.sessionID) !== group ||
            owner.viewport?.sessionID !== group.sessionID ||
            owner.viewport?.lease !== viewport?.lease ||
            owner.win.isDestroyed() ||
            owner.shutting ||
            !owner.win.isVisible() ||
            owner.win.isMinimized() ||
            tab.agentAccess ||
            (attached &&
              (owner.attached !== tab || owner.suspended !== 0 || !owner.win.contentView.children.includes(tab.view)))
          )
            throw new Error("Generation revoked")
        }
        check(true)
        tab.loginBusy = true
        owner.generationCheck = () => {
          try {
            check()
          } catch {
            revoke()
          }
        }
        return {
          check,
          readyLoginOffers: (check) => tab.readyLoginOffers!(check),
          unwatch: () => {
            owner.generationCheck = undefined
          },
          release: () => {
            tab.loginBusy = false
            tab.revision++
            invalidateSnapshots(contents)
          },
        }
      },
      async showDialog(options, check) {
        owner.suspended++
        layout(owner)
        try {
          const answer = await dialog.showMessageBox(owner.win, options)
          check?.()
          return answer
        } finally {
          owner.suspended--
          layout(owner)
        }
      },
      canShowFeedback: () =>
        !owner.suspended &&
        !owner.shutting &&
        !owner.win.isDestroyed() &&
        owner.win.isVisible() &&
        !owner.win.isMinimized(),
    })
  } else if (command.op === "save-login" || command.op === "fill-login") {
    if (
      command.op === "fill-login" &&
      command.revision !== undefined &&
      (!Number.isSafeInteger(command.revision) || command.revision !== tab.revision)
    )
      throw new Error("Login selection expired")
    if (tab.loginBusy || owner.suspended || owner.loginCheck)
      throw new Error("A browser dialog or login operation is already pending")
    await runBrowserLogin(
      { ...command, op: command.op },
      {
        contents,
        begin(validate) {
          const revision = tab.revision
          const viewport = owner.viewport
          // A linked-task switch advances the epoch before any viewport update arrives, so the viewport lease alone cannot
          // bind consent to the task that requested it.
          const epoch = owner.taskEpoch
          let revoked = false
          const check = (attached = false) => {
            validate()
            if (
              revoked ||
              owner.taskEpoch !== epoch ||
              contents.isDestroyed() ||
              contents.isLoadingMainFrame() ||
              tab.revision !== revision ||
              group.activeID !== tab.id ||
              !group.tabs.includes(tab) ||
              owner.groups.get(group.sessionID) !== group ||
              owner.viewport?.sessionID !== group.sessionID ||
              owner.viewport?.lease !== viewport?.lease ||
              owner.win.isDestroyed() ||
              owner.shutting ||
              !owner.win.isVisible() ||
              owner.win.isMinimized() ||
              tab.agentAccess ||
              (attached &&
                (owner.attached !== tab || owner.suspended !== 0 || !owner.win.contentView.children.includes(tab.view)))
            )
              throw new Error("Login requires an unchanged active tab with agent access off")
          }
          check(true)
          tab.loginBusy = true
          // Invalidate any agent-access confirmation already awaiting a response.
          tab.accessRevision = (tab.accessRevision ?? 0) + 1
          owner.loginCheck = () => {
            try {
              check()
            } catch {
              revoked = true
            }
          }
          return {
            check,
            release: () => {
              owner.loginCheck = undefined
              tab.loginBusy = false
              tab.revision++
              invalidateSnapshots(contents)
              publish(owner, group)
            },
          }
        },
        async confirm(options, check) {
          owner.suspended++
          layout(owner)
          try {
            const answer = await dialog.showMessageBox(owner.win, options())
            check()
            return answer.response === 1
          } finally {
            owner.suspended--
            layout(owner)
          }
        },
      },
    )
  } else if (command.op === "select") {
    group.activeID = tab.id
    void tab.restore?.()
    persistGroup(owner, group)
    layout(owner)
  } else if (command.op === "close") {
    cancelBrowserNavigation(contents)
    await runLeaveIntent(owner, tab, () => closeTabAttempt(contents))
  } else if (command.op === "navigate") {
    if (!browserNavigationURL(command.url)) throw new Error("Invalid browser URL")
    await runLeaveIntent(owner, tab, () => navigateBrowser(contents, command.url), true)
  } else if (command.op === "back") {
    if (contents.navigationHistory.canGoBack()) {
      const index = contents.navigationHistory.getActiveIndex() - 1
      await runLeaveIntent(owner, tab, () =>
        runPendingNavigation(contents, () => contents.navigationHistory.goToIndex(index)),
      )
    }
  } else if (command.op === "forward") {
    if (contents.navigationHistory.canGoForward()) {
      const index = contents.navigationHistory.getActiveIndex() + 1
      await runLeaveIntent(owner, tab, () =>
        runPendingNavigation(contents, () => contents.navigationHistory.goToIndex(index)),
      )
    }
  } else if (command.op === "reload") {
    if (tab.permissionReload) reloadForPermissions(tab)
    else await runLeaveIntent(owner, tab, () => runPendingNavigation(contents, () => contents.reload()))
  } else if (command.op === "stop") {
    tab.leaveIntent?.controller.abort()
    cancelBrowserNavigation(contents)
  } else if (command.op === "access") {
    if (command.enabled && browserTaskPaused(sessionID)) throw new Error(nativeT("desktop.browser.taskPaused"))
    if (command.enabled && tab.loginBusy) throw new Error("Login operation pending")
    if (command.enabled && !browserAgentEnabled()) throw new Error("Browser agent access is disabled")
    if (typeof command.enabled !== "boolean") throw new Error("Invalid browser access")
    if (!command.enabled) {
      revokeBrowserAccess(tab)
    } else if (!tab.agentAccess) {
      if (owner.suspended || tab.accessConsent) throw new Error("Browser consent already pending")
      const consent = new AbortController()
      const accessRevision = tab.accessRevision
      const revision = tab.revision
      const url = contents.getURL()
      if (!browserPageURL(url) || url === "about:blank") return state(group)
      const valid = () =>
        !consent.signal.aborted &&
        !contents.isDestroyed() &&
        !contents.isLoadingMainFrame() &&
        !owner.win.isDestroyed() &&
        !owner.win.webContents.isDestroyed() &&
        !owner.shutting &&
        owner.win.isVisible() &&
        !owner.win.isMinimized() &&
        owner.groups.get(sessionID) === group &&
        group.tabs.includes(tab) &&
        tab.ownerID === owner.win.webContents.id &&
        tab.accessConsent === consent &&
        tab.accessRevision === accessRevision &&
        tab.revision === revision &&
        contents.getURL() === url &&
        !tab.loginBusy &&
        browserAgentEnabled()
      tab.accessConsent = consent
      const revoke = () => consent.abort()
      // ponytail: one native grant per owner; do not make its settings window modal.
      // macOS needs a separate sheet owner because unparented message boxes block its event loop.
      const sheet =
        process.platform === "darwin"
          ? new BrowserWindow({
              width: 400,
              height: 160,
              show: false,
              title: nativeT("desktop.browser.access"),
              webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false },
            })
          : undefined
      sheet?.on("close", revoke)
      owner.win.on("close", revoke)
      owner.win.on("hide", revoke)
      owner.win.on("minimize", revoke)
      owner.win.webContents.on("destroyed", revoke)
      owner.win.webContents.on("render-process-gone", revoke)
      owner.win.webContents.on("did-start-navigation", revoke)
      owner.suspended++
      layout(owner)
      try {
        if (!valid()) return state(group)
        sheet?.showInactive()
        const options = {
          type: "warning" as const,
          message: nativeT("desktop.browser.access"),
          detail: nativeT("desktop.browser.tabGrantDetail", { origin: new URL(url).origin }),
          buttons: [nativeT("desktop.browser.cancel"), nativeT("desktop.browser.allow")],
          defaultId: 0,
          cancelId: 0,
          signal: consent.signal,
        }
        const answer = await (sheet ? dialog.showMessageBox(sheet, options) : dialog.showMessageBox(options))
        if (answer.response === 1 && valid()) {
          const related = new Set([tab.id])
          // An existing child can affect its opener and siblings through ordinary page script.
          for (let pass = 0; pass < group.tabs.length; pass++) {
            group.tabs.forEach((entry) => {
              if (!entry.openerID) return
              if (related.has(entry.id)) related.add(entry.openerID)
              if (related.has(entry.openerID)) related.add(entry.id)
            })
          }
          await Promise.all(
            group.tabs
              .filter((entry) => related.has(entry.id))
              .map((entry) => {
                entry.transferGuarded = true
                entry.uploadGuard ??= guardUploads(owner.win, entry, entry.view.webContents)
                return entry.uploadGuard
              }),
          )
          if (valid()) {
            tab.agentAccess = true
            tab.accessRevision = (tab.accessRevision ?? 0) + 1
          }
        }
      } finally {
        owner.win.removeListener("close", revoke)
        owner.win.removeListener("hide", revoke)
        owner.win.removeListener("minimize", revoke)
        owner.win.webContents.removeListener("destroyed", revoke)
        owner.win.webContents.removeListener("render-process-gone", revoke)
        owner.win.webContents.removeListener("did-start-navigation", revoke)
        if (sheet && !sheet.isDestroyed()) sheet.destroy()
        if (tab.accessConsent === consent) tab.accessConsent = undefined
        owner.suspended--
        layout(owner)
      }
    }
  } else throw new Error("Unknown browser command")
  publish(owner, group)
  return state(group)
}

export function browserViewport(
  owner: Owner,
  input: { sessionID: string; lease: string; bounds: BrowserBounds | null },
) {
  if (!input || typeof input.lease !== "string" || input.lease.length > 128) throw new Error("Invalid browser viewport")
  groupFor(owner, input.sessionID)
  if (input.bounds === null) {
    if (owner.viewport?.lease === input.lease && owner.viewport?.sessionID === input.sessionID) {
      advanceOwnerTask(owner)
      owner.viewport = undefined
    }
  } else {
    if (
      !input.bounds ||
      !["x", "y", "width", "height"].every((key) => {
        const value = input.bounds![key as keyof BrowserBounds]
        return typeof value === "number" && Number.isFinite(value) && value >= 0 && value <= 32_768
      })
    )
      throw new Error("Invalid browser bounds")
    if (owner.panelRequest && owner.panelRequest.request.sessionID !== input.sessionID) owner.panelRequest.cancel()
    if (owner.viewport?.sessionID !== input.sessionID || owner.viewport?.lease !== input.lease) {
      advanceOwnerTask(owner)
    }
    owner.viewport = { sessionID: input.sessionID, lease: input.lease, bounds: input.bounds }
  }
  layout(owner)
}

export async function browserPageContext(owner: Owner, sessionID: string, tabID: string, command: unknown) {
  groupFor(owner, sessionID)
  return captureBrowserContext(owner, sessionID, tabID, command)
}

function reloadForPermissions(tab: Tab, request = true) {
  if (tab.contents.isDestroyed()) return
  if (request) {
    tab.permissionReload = true
    tab.permissionReloadQueued = true
  }
  if (tab.permissionReplaceQueued) {
    void replaceForPermissions(tab, false).catch(() => undefined)
    return
  }
  // ponytail: coalesce fresh requests, never replay an attempted obligation after 204/Stop.
  if (!tab.permissionReloadQueued || tab.agentClose || tab.permissionReloadPhase) return
  tab.permissionReloadQueued = false
  tab.permissionReloadPhase = "dispatch"
  try {
    tab.view.webContents.reload()
  } catch (error) {
    tab.permissionReloadPhase = undefined
    throw error
  }
}

async function replaceForPermissions(tab: Tab, request = true) {
  const contents = tab.view.webContents
  if (contents.isDestroyed()) return
  if (request) tab.permissionReplaceQueued = true
  if (!tab.permissionReplaceQueued || tab.permissionReplacing) return
  const history = {
    entries: contents.navigationHistory.getAllEntries(),
    index: contents.navigationHistory.getActiveIndex(),
  }
  tab.permissionReload = true
  tab.permissionReloadQueued = false
  tab.permissionReloadPhase = "dispatch"
  tab.permissionReplacing = true
  contents.stop()
  try {
    await contents.loadURL("about:blank")
  } catch (error) {
    tab.permissionReloadPhase = undefined
    tab.permissionReplacing = false
    if (contents.isDestroyed()) tab.permissionReplaceQueued = false
    throw error
  }
  tab.permissionReplaceQueued = false
  tab.permissionReplacing = false
  if (contents.isDestroyed() || !history.entries.length || history.index < 0) return
  tab.permissionReload = true
  tab.permissionReloadPhase = "dispatch"
  void contents.navigationHistory.restore(history).catch(() => {
    if (contents.isDestroyed()) return
    tab.permissionReload = false
    tab.permissionReloadPhase = undefined
  })
}

function resolveNativeTabAction(sessionID: string, request: TabRequest): NativeTabAction | undefined {
  const current = () =>
    [...owners.values()].filter(
      (entry) =>
        !entry.shutting &&
        !entry.win.isDestroyed() &&
        !entry.win.webContents.isDestroyed() &&
        (entry.linkContext?.sessionID ?? entry.viewport?.sessionID) === sessionID &&
        (!entry.viewport || entry.viewport.sessionID === sessionID),
    )
  const matches = current()
  if (matches.length !== 1) return undefined
  const owner = matches[0]
  if (owner.panelRequest) return undefined
  const ownerID = owner.win.webContents.id
  const epoch = owner.taskEpoch
  const lifecycle = owner.screenshotEpoch
  const group = owner.groups.get(sessionID)
  const activeID = group?.activeID
  const target = request.op === "create_tab" ? undefined : group?.tabs.find((tab) => tab.id === request.tabID)
  if (request.op !== "create_tab" && !target) return undefined
  const check = () => {
    const matches = current()
    if (
      matches.length !== 1 ||
      matches[0] !== owner ||
      owner.panelRequest ||
      owners.get(ownerID) !== owner ||
      owner.taskEpoch !== epoch ||
      owner.screenshotEpoch !== lifecycle ||
      !owner.win.isVisible() ||
      owner.win.isMinimized() ||
      owner.groups.get(sessionID) !== group ||
      group?.activeID !== activeID ||
      (target &&
        (!group?.tabs.includes(target) ||
          target.contents.isDestroyed() ||
          target.ownerID !== ownerID ||
          target.loginBusy ||
          target.permissionReload)) ||
      (request.op === "create_tab" && (group?.tabs.length ?? 0) >= 32)
    )
      throw new Error("Tab owner changed")
    if (request.op === "create_tab" && !group && (savedTabs(sessionID)?.tabs.length ?? 0) >= 32)
      throw new Error("Browser tab limit reached")
  }
  return {
    owner,
    target,
    source: group?.tabs.find((tab) => tab.id === activeID),
    check,
    async confirm(signal) {
      check()
      // Ordinary agent lifecycle uses the task's standing authority. Private targets
      // retain native confirmation and gain no page access from that confirmation.
      if (request.op === "create_tab" || target?.agentAccess) return true
      if (owner.suspended || owner.tabConsent) return false
      const consent = new AbortController()
      owner.tabConsent = consent
      const revoke = () => consent.abort()
      const sheet =
        process.platform === "darwin"
          ? new BrowserWindow({
              width: 400,
              height: 160,
              show: false,
              title: nativeT(`desktop.browser.tabs.${request.op}`),
              webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false },
            })
          : undefined
      sheet?.on("close", revoke)
      signal.addEventListener("abort", revoke, { once: true })
      owner.win.on("close", revoke)
      owner.win.on("hide", revoke)
      owner.win.on("minimize", revoke)
      owner.win.webContents.on("destroyed", revoke)
      owner.win.webContents.on("render-process-gone", revoke)
      owner.win.webContents.on("did-start-navigation", revoke)
      owner.suspended++
      layout(owner)
      try {
        signal.throwIfAborted()
        consent.signal.throwIfAborted()
        check()
        sheet?.showInactive()
        const options = {
          type: "warning" as const,
          message: nativeT(`desktop.browser.tabs.${request.op}`),
          detail: nativeT("desktop.browser.tabs.targetDetail", { task: sessionID, tab: request.tabID }),
          buttons: [nativeT("desktop.browser.cancel"), nativeT("desktop.browser.allow")],
          defaultId: 0,
          cancelId: 0,
          signal: consent.signal,
        }
        const answer = await (sheet ? dialog.showMessageBox(sheet, options) : dialog.showMessageBox(options))
        signal.throwIfAborted()
        consent.signal.throwIfAborted()
        check()
        return answer.response === 1
      } finally {
        signal.removeEventListener("abort", revoke)
        owner.win.removeListener("close", revoke)
        owner.win.removeListener("hide", revoke)
        owner.win.removeListener("minimize", revoke)
        owner.win.webContents.removeListener("destroyed", revoke)
        owner.win.webContents.removeListener("render-process-gone", revoke)
        owner.win.webContents.removeListener("did-start-navigation", revoke)
        if (sheet && !sheet.isDestroyed()) sheet.destroy()
        if (owner.tabConsent === consent) owner.tabConsent = undefined
        owner.suspended--
        layout(owner)
      }
    },
    async run(authority, signal, deadline) {
      authority()
      if (owner.suspended) throw new Error("Browser dialog pending")
      if (request.op === "create_tab") {
        // Adopt URL/history recovery through the normal path. Restored tabs stay
        // private; only the new agent tab gets standing task authority.
        const destination = group ?? groupFor(owner, sessionID)
        const accessEpoch = browserAgentEpoch()
        const taskEpoch = browserTaskEpoch(sessionID)
        const created = createTab(owner, destination, undefined, undefined, undefined, false, true, true)
        try {
          // Blank-tab access is initialized in main, never by page content. Await
          // upload interception before exposing the tab or returning its ID.
          await Promise.all([created.uploadGuard, created.restore?.()])
          signal.throwIfAborted()
          if (
            Date.now() >= deadline ||
            !browserAgentEnabled() ||
            browserAgentEpoch() !== accessEpoch ||
            browserTaskPaused(sessionID) ||
            browserTaskEpoch(sessionID) !== taskEpoch ||
            owner.taskEpoch !== epoch ||
            owner.screenshotEpoch !== lifecycle ||
            owner.shutting ||
            !owner.win.isVisible() ||
            owner.win.isMinimized() ||
            owner.groups.get(sessionID) !== destination ||
            !destination.tabs.includes(created) ||
            created.contents.isDestroyed() ||
            created.contents.getURL() !== "about:blank"
          )
            throw new Error("Browser creation authority changed")
          created.agentAccess = true
          created.accessRevision = (created.accessRevision ?? 0) + 1
        } catch (error) {
          if (!created.contents.isDestroyed()) created.view.webContents.close()
          throw error
        }
        publish(owner, destination)
        await requestDesktopPanel(owner, sessionID, { op: "set_panel", view: "browser", tabID: created.id }, signal, deadline)
        return created.id
      }
      if (!target || !group) throw new Error("Missing tab")
      if (request.op === "select_tab") {
        group.activeID = target.id
        persistGroup(owner, group)
        layout(owner)
        publish(owner, group)
        await requestDesktopPanel(owner, sessionID, { op: "set_panel", view: "browser", tabID: target.id }, signal, deadline)
        return target.id
      }
      const contents = target.view.webContents
      const events: EventEmitter = contents
      return new Promise<string | undefined>((resolve, reject) => {
        let settled = false
        const finish = (closed: boolean) => {
          if (settled) return
          settled = true
          contents.removeListener("destroyed", destroyed)
          events.removeListener("-before-unload-fired", unloaded)
          if (target.agentClose === pending) target.agentClose = undefined
          if (!closed) reloadForPermissions(target, false)
          resolve(closed ? target.id : undefined)
        }
        const destroyed = () => finish(true)
        // Electron 42 emits this close-only acknowledgement after the renderer returns,
        // unlike will-prevent-unload. Revalidate this internal event on Electron upgrades.
        const unloaded = (event: Electron.Event, proceed: boolean) => {
          if (!proceed || event.defaultPrevented) {
            if (pending.retrying) setImmediate(() => finish(contents.isDestroyed()))
            else pending.settled?.()
          }
        }
        const firstSettlement = Promise.withResolvers<void>()
        const pending: NonNullable<Tab["agentClose"]> = {
          check: authority,
          signal,
          deadline,
          settled: firstSettlement.resolve,
          settledPromise: firstSettlement.promise,
          retry: () => contents.close({ waitForBeforeUnload: true }),
          stay: () => finish(false),
        }
        target.agentClose = pending
        contents.once("destroyed", destroyed)
        events.on("-before-unload-fired", unloaded)
        try {
          authority()
          contents.close({ waitForBeforeUnload: true })
        } catch (error) {
          settled = true
          contents.removeListener("destroyed", destroyed)
          events.removeListener("-before-unload-fired", unloaded)
          if (target.agentClose === pending) target.agentClose = undefined
          reject(error)
        }
        // Cancellation only ends the reply, never this native settlement or its busy lease.
      })
    },
  }
}
