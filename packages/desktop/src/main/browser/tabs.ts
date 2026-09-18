import { randomUUID } from "node:crypto"
import type { EventEmitter } from "node:events"
import { trackDownload } from "./download-records"
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
} from "@opencode-ai/app/browser-panel"
import { browserShortcut, browserDeviceSize, BROWSER_DEVICE_DEFAULT } from "@opencode-ai/app/browser-panel"
import { nativeT } from "../native-translations"
import { browserPreferences, browserURL, browserPageURL, BROWSER_PARTITION } from "./policy"
import {
  registerBrowserTab,
  setBrowserAgentEnabled,
  browserAgentEnabled,
  browserOperationBusy,
  browserRegistration,
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
  sitePermissionsRevision,
} from "./preferences"
import { siteOrigin } from "./site-permissions"
import { updateAgentHost, allowed } from "./allowlist"
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
import { saveBookmark, deleteBookmark, transferBookmarks } from "./bookmarks"
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
  pageLogin,
  rememberPage,
  saveLogins,
} from "./profile"

import { watchLoginOffers, allowLoginOffers, loginOfferExclusions } from "./login-offers"
import { loginOrigin } from "./import-data"
import { readLogins } from "./vault"
import {
  passwordOptions,
  generatePassword,
  prepareGenerationScript,
  completeGenerationScript,
  clearGenerationScript,
} from "./password-generation"
import { agentHistory } from "./agent-history"
import { createTabHandler, TabRecoveryRequired, type NativeTabAction } from "./agent-tabs"
import { setBrowserTabHandler } from "./registry"
import { failure, hasFrameTarget, type TabRequest } from "@cookiemonster/cm-browser/protocol"
import { allowDownload, guardUploads, saveTransferRule } from "./transfer-permissions"

type Tab = BrowserRegistration & {
  agentClose?: { check: () => void }
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
  cancelLoginOffer?: () => void
  readyLoginOffers?: (check: () => void) => Promise<number>
  loginBusy?: boolean
}
type Group = {
  sessionID: string
  tabs: Tab[]
  activeID?: string
  downloads?: BrowserDownload[]
  closed: ClosedTab[]
  restoring?: boolean
}
type Owner = {
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
let profileReady = false
vaultAccess.subscribe(() => owners.forEach((owner) => owner.groups.forEach((group) => publish(owner, group))))

export function registerBrowserOwner(win: BrowserWindow) {
  initializeVaultLocking()
  setBrowserAgentEnabled(browserPreferencesState().agentEnabled)
  const existing = owners.get(win.webContents.id)
  if (existing) return existing
  const owner: Owner = { win, groups: new Map(), suspended: 0, screenshotEpoch: 0, taskEpoch: 0 }
  const id = win.webContents.id
  owners.set(id, owner)
  const hide = () => {
    if (owner.viewport) {
      owner.taskEpoch++
      owner.tabConsent?.abort()
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
      vaultAccess.lock()
      hide()
    }
  })
  win.webContents.on("render-process-gone", () => {
    owner.screenshotEpoch++
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
    owner.taskEpoch++
    owner.tabConsent?.abort()
  }
  if (sessionID !== null) owner.linkContext = { sessionID, lease }
  if (sessionID === null && owner.linkContext?.lease === lease) owner.linkContext = undefined
  owner.captureChecks?.forEach((check) => check())
}

export async function openBrowserLink(win: BrowserWindow, value: string, destination?: "browser" | "external") {
  const url = typeof value === "string" && resolveExternalURL(value)
  if (
    !url ||
    url.length > 2048 ||
    (destination !== undefined && destination !== "browser" && destination !== "external")
  )
    throw new Error("Invalid link")
  const owner = owners.get(win.webContents.id)
  const sessionID = owner?.linkContext?.sessionID
  if (
    !owner ||
    !sessionID ||
    !browserURL(url) ||
    (destination ?? linkDestination(url, browserPreferencesState())) === "external"
  ) {
    await shell.openExternal(url)
    return
  }
  createTab(owner, groupFor(owner, sessionID), undefined, { url, title: "" })
  win.webContents.send("browser-opened", sessionID)
}

export function browserLinkMenu(contents: WebContents, url: string) {
  if (!browserURL(url) || url === "about:blank") return []
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
    saved.tabs.slice(0, 32).forEach((tab) => createTab(owner, group, undefined, tab))
    group.activeID = group.tabs[saved.active]?.id ?? group.tabs[0]?.id
  }
  group.restoring = false
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
  if (kind !== "history") return
  const since = clearSince(range)
  owners.forEach((owner) =>
    owner.groups.forEach((group) => {
      group.closed = group.closed.filter((tab) => tab.time < since)
    }),
  )
}

function state(group: Group): BrowserTabs {
  const profile = browserProfile()
  return {
    sessionID: group.sessionID,
    activeID: group.activeID,
    recentlyClosed: group.closed,
    downloads: [
      ...(group.downloads ?? []).filter((entry) => entry.state === "saving"),
      ...downloadHistory().filter((entry) => !transfers.has(entry.id)),
    ],
    profile,
    tabs: group.tabs
      .filter((tab) => !tab.view.webContents.isDestroyed())
      .map((tab) => {
        const contents = tab.view.webContents
        const url = contents.getURL()
        const rule = transferRule(profile.transferRules ?? [], url)
        return {
          id: tab.id,
          revision: tab.revision,
          openerID: tab.openerID,
          agentAccess: tab.agentAccess,
          // ponytail: report main's policy for the live URL, never the saved/display fallback.
          access: {
            loading: contents.isLoadingMainFrame(),
            hostAllowed: browserPageURL(url) && allowed(url),
            blank: url === "about:blank",
            transferGuarded: tab.transferGuarded === true,
            transferRule: rule,
            transferSource: !/^https?:/.test(url) ? "unavailable" : rule.origin === "*" ? "default" : "exception",
          },
          loadFailed: tab.loadFailed,
          loadError: tab.loadFailed && tab.recovery?.restoring ? nativeT("desktop.browser.recovery.failed") : undefined,
          connection: tab.loadFailed
            ? "error"
            : contents.isLoadingMainFrame()
              ? "unknown"
              : contents.getURL().startsWith("https:")
                ? "https"
                : contents.getURL().startsWith("http:")
                  ? "http"
                  : "unknown",
          zoom: contents.getZoomFactor(),
          device: tab.device,
          deviceSize: tab.deviceSize ?? BROWSER_DEVICE_DEFAULT,
          find: tab.find,
          url: contents.getURL() || tab.saved.url,
          title: contents.getTitle().slice(0, 512) || tab.saved.title,
          loading: contents.isLoading(),
          canGoBack: contents.navigationHistory.canGoBack(),
          canGoForward: contents.navigationHistory.canGoForward(),
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
    owner.win.contentView.removeChildView(owner.attached.view)
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
    if (owner.attached) owner.win.contentView.removeChildView(owner.attached.view)
    owner.attached = undefined
    owner.captureChecks?.forEach((check) => check())
    return
  }
  tab.view.setBounds({ x, y, width, height })
  if (tab.device) contentsDevice(tab, width, height)
  if (owner.attached !== tab) {
    owner.win.contentView.addChildView(tab.view)
    owner.attached = tab
  }
}

function contentsDevice(tab: Tab, width: number, height: number) {
  tab.view.webContents.enableDeviceEmulation(deviceEmulation(tab.deviceSize ?? BROWSER_DEVICE_DEFAULT, width, height))
}

const notificationPrompts = new WeakSet<Owner>()

function notificationTarget(contents: WebContents | null, requested: string, main: boolean) {
  if (!contents || contents.isDestroyed() || main !== true || !Notification.isSupported()) return
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

function requestNotification(
  contents: WebContents | null,
  callback: (allowed: boolean) => void,
  details: { requestingUrl: string; isMainFrame: boolean },
) {
  const target = notificationTarget(contents, details.requestingUrl, details.isMainFrame)
  if (!target || !contents || details.requestingUrl !== target.url || notificationPrompts.has(target.owner)) {
    callback(false)
    return
  }
  const permission = notificationPermission(target.origin)
  if (permission !== "ask") {
    callback(permission === "allow")
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
    const current = notificationTarget(contents, url, true)
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
      notificationPermission(origin) === "ask"
    )
  }
  const finish = (allow: boolean) => {
    if (settled) return
    settled = true
    clearTimeout(timer)
    checks.delete(check)
    listeners.forEach(([emitter, event]) => emitter.removeListener(event, revoke))
    notificationPrompts.delete(owner)
    consent.abort()
    let granted = false
    try {
      if (allow && valid()) {
        // Persist before granting: Electron rechecks permission on property/show paths.
        saveSitePermission(origin, undefined, undefined, "allow")
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
  const timer = setTimeout(revoke, 30_000)
  notificationPrompts.add(owner)
  checks.add(check)
  listeners.forEach(([emitter, event]) => emitter.on(event, revoke))
  try {
    void dialog
      .showMessageBox(owner.win, {
        type: "question",
        message: nativeT("desktop.browser.notifications.title", { origin }),
        detail: nativeT("desktop.browser.notifications.detail", { task: tab.sessionID, tab: tab.id }),
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
) {
  if (group.tabs.length >= 32) throw new Error("Browser tab limit reached")
  if (!profileReady) {
    const profile = session.fromPartition(BROWSER_PARTITION)
    // Electron-created popups ignore per-WebContents/session UA overrides on their
    // first navigation (electron/electron#45897). Keep its fallback Chromium-based too.
    app.userAgentFallback = app.userAgentFallback.replace(/\s(?:Electron|OpenCodeDev|OpenCode|CookieMonster)\/\S+/g, "")
    profile.setUserAgent(app.userAgentFallback)
    profile.setPermissionCheckHandler((contents, permission, requested, details) => {
      if (permission === "notifications") {
        const target = notificationTarget(contents, requested, details.isMainFrame)
        return !!target && details.requestingUrl === target.url && notificationPermission(target.origin) === "allow"
      }
      if (!contents || permission !== "media") return false
      const origin = mediaOrigin(contents.getURL(), requested, details.isMainFrame)
      if (!origin) return false
      if (details.mediaType === "audio" || details.mediaType === "video")
        return mediaPermission(origin, details.mediaType) === "allow"
      return mediaPermission(origin, "audio") === "allow" && mediaPermission(origin, "video") === "allow"
    })
    profile.setPermissionRequestHandler((contents, permission, callback, details) => {
      if (permission === "notifications") {
        requestNotification(contents, callback, details)
        return
      }
      const origin = contents && mediaOrigin(contents.getURL(), details.requestingUrl, details.isMainFrame)
      const media = "mediaTypes" in details ? details.mediaTypes : undefined
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
          (answer) =>
            callback(
              answer.response === 1 &&
                !contents.isDestroyed() &&
                mediaOrigin(contents.getURL(), origin, true) === origin &&
                media.every((type) => mediaPermission(origin, type) !== "block"),
            ),
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
      trackDownload(event, item, download, {
        save: (row, path) => recordDownload(row, new Set(transfers.keys()), path),
        start: () => {
          // Admission is durable before any destination is reserved or configured.
          item.setSaveDialogOptions({
            title: nativeT("desktop.browser.saveDownload"),
            defaultPath: join(downloadDirectory(), download.filename),
          })
          if (!browserPreferencesState().askDownloadLocation) {
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
        release: () => transfers.delete(download.id),
        publish: () => publish(target.owner, target.group),
      })
    })
    profileReady = true
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
    transferGuarded: group.tabs.some((tab) => tab.id === popup?.openerID && tab.transferGuarded),
    revision: 0,
    openerID: popup?.openerID,
    loadFailed: false,
  }
  tab.confirmScreenshot = async (url, signal) => {
    if (
      owner.suspended ||
      owner.shutting ||
      owner.win.isDestroyed() ||
      !owner.win.isVisible() ||
      owner.win.isMinimized() ||
      !group.tabs.includes(tab)
    )
      return false
    const consent = tab.screenshotConsent
    if (!consent || consent.signal !== signal || signal.aborted) return false
    const epoch = owner.screenshotEpoch
    const revoke = () => consent.abort()
    const sheet =
      process.platform === "darwin"
        ? new BrowserWindow({
            width: 400,
            height: 160,
            show: false,
            title: nativeT("desktop.browser.screenshotConsent"),
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
      signal.throwIfAborted()
      sheet?.showInactive()
      const options = {
        type: "warning" as const,
        message: nativeT("desktop.browser.screenshotConsent"),
        detail: nativeT("desktop.browser.screenshotDetail", { task: tab.sessionID, tab: tab.id, url }),
        buttons: [nativeT("desktop.browser.cancel"), nativeT("desktop.browser.allow")],
        defaultId: 0,
        cancelId: 0,
        signal,
      }
      const answer = await (sheet ? dialog.showMessageBox(sheet, options) : dialog.showMessageBox(options))
      if (answer.response !== 1) return false
      // Retain the original owner epoch through disclosure, not just native consent.
      return () => {
        signal.throwIfAborted()
        if (
          owner.screenshotEpoch !== epoch ||
          owner.shutting ||
          owner.win.isDestroyed() ||
          owner.win.webContents.isDestroyed() ||
          !owner.win.isVisible() ||
          owner.win.isMinimized() ||
          owners.get(tab.ownerID) !== owner ||
          owner.groups.get(tab.sessionID) !== group ||
          !group.tabs.includes(tab)
        )
          throw new Error("Screenshot owner changed")
      }
    } finally {
      owner.win.removeListener("close", revoke)
      owner.win.removeListener("hide", revoke)
      owner.win.removeListener("minimize", revoke)
      owner.win.webContents.removeListener("destroyed", revoke)
      owner.win.webContents.removeListener("render-process-gone", revoke)
      owner.win.webContents.removeListener("did-start-navigation", revoke)
      if (sheet && !sheet.isDestroyed()) sheet.destroy()
      owner.suspended--
      layout(owner)
    }
  }
  if (tab.transferGuarded) {
    tab.uploadGuard = guardUploads(owner.win, tab, contents)
    void tab.uploadGuard.catch(() => {
      if (!contents.isDestroyed()) contents.close()
    })
  }
  group.tabs.push(tab)
  group.activeID = tab.id
  const unregister = registerBrowserTab(tab)
  const offers = watchLoginOffers(
    owner.win,
    contents,
    () => owner.attached === tab && owner.win.contentView.children.includes(tab.view) && !tab.agentAccess,
    () => !tab.loginBusy && !owner.suspended,
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
    tab.accessConsent?.abort()
    tab.screenshotConsent?.abort()
    tab.revision++
    invalidateSnapshots(contents)
    cancelPicker(contents)
  }
  contents.on("will-frame-navigate", (event) => {
    if (event.isMainFrame && (tab.agentClose || !browserURL(event.url) || tab.navigationAllowed?.(event.url) === false))
      event.preventDefault()
  })
  contents.on("will-redirect", (event, url, _inPlace, main) => {
    if (main && (!browserURL(url) || tab.navigationAllowed?.(url) === false)) event.preventDefault()
  })
  contents.on("did-start-navigation", (_event, _url, inPlace, main) => {
    if (!main) return
    // Supersede the callback, not the last recoverable snapshot; a retry may fail or stop.
    if (tab.recovery?.started) tab.recovery = undefined
    if (tab.recovery) tab.recovery.started = true
    if (!inPlace && tab.permissionReloadPhase) tab.permissionReloadPhase = "loading"
    tab.loadFailed = false
    tab.find = undefined
    tab.findRequest = undefined
    invalidate()
    changed()
  })
  contents.on("dom-ready", () => {
    invalidate()
    if (tab.device) {
      // A new document can reset Chromium's emulation while the per-tab preview stays enabled.
      const bounds = tab.view.getBounds()
      contentsDevice(tab, bounds.width, bounds.height)
    }
    changed()
  })
  contents.on("did-fail-load", (_event, code, _description, _url, main) => {
    if (!main || code === -3) return
    tab.loadFailed = true
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
        navigation,
      })!
      persistGroup(owner, group)
    }
    changed()
  }
  contents.on("did-navigate", () => {
    // A main-frame document commit covers all prior requests, including ones queued before this commit.
    tab.permissionReload = false
    tab.permissionReloadQueued = false
    invalidate()
    navigated()
  })
  contents.on("did-navigate-in-page", (_event, _url, main) => {
    if (main) navigated()
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
  contents.on("render-process-gone", () => {
    tab.agentAccess = false
    invalidate()
    changed()
  })
  contents.on("will-prevent-unload", (event) => {
    const pending = tab.agentClose
    // A site cannot keep capturing by vetoing the reload after its permission is revoked.
    if (tab.permissionReloadPhase && !pending) {
      event.preventDefault()
      return
    }
    if (pending) {
      try {
        pending.check()
      } catch {
        return
      }
    }
    owner.suspended++
    layout(owner)
    try {
      const answer = dialog.showMessageBoxSync(owner.win, {
        type: "warning",
        message: nativeT("desktop.browser.leave"),
        detail: nativeT("desktop.browser.leaveDetail"),
        buttons: [nativeT("desktop.browser.stay"), nativeT("desktop.browser.leaveConfirm")],
        defaultId: 0,
        cancelId: 0,
      })
      if (answer !== 1) return
      // The sync dialog blocks timers; check the same absolute deadline after its answer.
      if (pending) {
        try {
          pending.check()
        } catch {
          return
        }
      }
      event.preventDefault()
    } finally {
      owner.suspended--
      layout(owner)
    }
  })
  contents.setWindowOpenHandler(({ url }) => {
    if (!browserURL(url || "about:blank") || group.tabs.length >= 32) return { action: "deny" }
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
    contents.setZoomLevel(
      input.key === "0" ? 0 : Math.max(-5, Math.min(5, contents.getZoomLevel() + (input.key === "-" ? -1 : 1))),
    )
    changed()
  })
  contents.once("destroyed", () => {
    tab.recovery = undefined
    unregister()
    if (owner.attached === tab) {
      if (!owner.win.isDestroyed()) owner.win.contentView.removeChildView(view)
      owner.attached = undefined
    }
    const index = group.tabs.indexOf(tab)
    if (!owner.shutting && !owner.win.isDestroyed())
      group.closed = [{ ...tab.saved, id: randomUUID(), time: Date.now() }, ...group.closed].slice(0, 20)
    group.tabs.splice(index, 1)
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
  if (!popup) {
    const recovery = { started: false, restoring: group.restoring || !!tab.saved.navigation }
    tab.recovery = recovery
    // Only URL/title projections reach Electron; never serialize or replay native pageState.
    void (
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
  }
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
      !browserURL(command.url) ||
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
    if (command.action === "cancel") transfer.item.cancel()
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
      "site-permission",
      "agent-host",
      "transfer-rule",
      "bookmark-save",
      "bookmark-delete",
      "bookmark-import",
      "bookmark-export",
    ].includes(command.op)
  ) {
    owner.suspended++
    layout(owner)
    try {
      if (command.op === "allow-login-offers") allowLoginOffers(command.origin)
      if (command.op === "transfer-rule") saveTransferRule(command.rule, command.remove)
      if (command.op === "bookmark-save") saveBookmark(command)
      if (command.op === "bookmark-delete") deleteBookmark(command.id)
      if (command.op === "bookmark-export") await transferBookmarks(owner.win)
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
      if (command.op === "settings") browserSettings(command.rememberHistory)
      if (command.op === "agent-host") {
        updateAgentHost(command.host, command.remove)
        owners.forEach((entry) =>
          entry.groups.forEach((group) =>
            group.tabs.forEach((tab) => {
              if (allowed(tab.contents.getURL())) return
              tab.accessConsent?.abort()
              tab.screenshotConsent?.abort()
              tab.agentAccess = false
              tab.accessRevision = (tab.accessRevision ?? 0) + 1
              tab.revision++
              invalidateSnapshots(tab.contents)
            }),
          ),
        )
      }
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
      if (command.op === "site-permission") {
        const update = saveSitePermission(command.origin, command.camera, command.microphone, command.notifications)
        owners.forEach((entry) => entry.captureChecks?.forEach((check) => check()))
        if (update.mediaChanged)
          owners.forEach((entry) =>
            entry.groups.forEach((group) =>
              group.tabs.forEach((tab) => {
                if (!tab.contents.isDestroyed() && mediaOrigin(tab.contents.getURL(), update.origin, true)) {
                  reloadForPermissions(tab)
                }
              }),
            ),
          )
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
    (tab.agentClose ||
      (tab.permissionReloadPhase &&
        !(command.op === "stop" && tab.permissionReloadPhase === "loading" && contents.isLoadingMainFrame()))) &&
    ["close", "navigate", "back", "forward", "reload", "stop"].includes(command.op)
  )
    throw new Error(nativeT("desktop.browser.tabs.busy"))
  if (command.op === "clear-site") {
    if (!browserURL(contents.getURL()) || contents.getURL() === "about:blank" || owner.suspended)
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
          dataTypes: ["cookies", "localStorage", "indexedDB", "serviceWorkers", "cache", "fileSystems", "webSQL"],
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
    contents.setZoomFactor(command.factor)
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
    const options = (() => {
      try {
        return passwordOptions(command)
      } catch {
        throw new Error(nativeT("desktop.browser.generation.settings"))
      }
    })()
    if (
      !browserPreferencesState().offerSaveLogins ||
      loginOfferExclusions().includes(new URL(contents.getURL()).origin)
    )
      throw new Error(nativeT("desktop.browser.generation.offers"))
    try {
      const ticket = vaultAccess.require()
      const origin = loginOrigin(contents.getURL())
      const revision = tab.revision
      const viewport = owner.viewport
      const consent = new AbortController()
      const expires = Date.now() + Math.min(120_000, vaultAccess.remaining())
      const accessRevision = (tab.accessRevision ?? 0) + 1
      tab.accessRevision = accessRevision
      const check = (attached = false) => {
        vaultAccess.require(ticket)
        if (
          consent.signal.aborted ||
          Date.now() >= expires ||
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
          loginOrigin(contents.getURL()) !== origin ||
          !browserPreferencesState().offerSaveLogins ||
          loginOfferExclusions().includes(origin) ||
          (attached &&
            (owner.attached !== tab || owner.suspended !== 0 || !owner.win.contentView.children.includes(tab.view)))
        )
          throw new Error("Generation revoked")
      }
      check(true)
      tab.loginBusy = true
      const token = randomUUID()
      const revoke = () => consent.abort()
      const unsubscribe = vaultAccess.subscribe(revoke)
      const timer = setTimeout(revoke, Math.max(0, expires - Date.now()))
      contents.on("did-start-navigation", revoke)
      owner.generationCheck = () => {
        try {
          check()
        } catch {
          revoke()
        }
      }
      try {
        const constraints = await contents.executeJavaScriptInIsolatedWorld(999, [
          { code: prepareGenerationScript(origin, token, expires) },
        ])
        check(true)
        if (
          !constraints ||
          typeof constraints !== "object" ||
          typeof constraints.min !== "number" ||
          typeof constraints.max !== "number" ||
          typeof constraints.hasUsername !== "boolean"
        )
          throw new Error("Invalid constraints")
        passwordOptions(options, constraints.min, constraints.max)
        if (!constraints.hasUsername) {
          const accounts = readLogins().filter((row) => row.origin === origin)
          if (
            !accounts.length ||
            accounts.length > 5 ||
            new Set(accounts.map((row) => row.username)).size !== accounts.length ||
            accounts.some(
              (row) => !row.username.trim() || row.username.length > 80 || /[\p{Cc}\p{Cf}]/u.test(row.username),
            )
          )
            throw new Error("No usable saved account")
        }
        owner.suspended++
        layout(owner)
        try {
          const answer = await dialog.showMessageBox(owner.win, {
            type: "question",
            message: nativeT("desktop.browser.generation.title"),
            detail: nativeT("desktop.browser.generation.detail", {
              origin,
              length: options.length,
              min: constraints.min,
              max: constraints.max,
              characters: nativeT(
                options.symbols ? "desktop.browser.generation.symbols" : "desktop.browser.generation.alphanumeric",
              ),
            }),
            buttons: [nativeT("desktop.browser.cancel"), nativeT("desktop.browser.generation.fill")],
            defaultId: 0,
            cancelId: 0,
            signal: consent.signal,
          })
          check()
          if (answer.response === 1) {
            owner.suspended--
            layout(owner)
            try {
              check(true)
              const captureUntil = await tab.readyLoginOffers!(() => check(true))
              check(true)
              // Arm before fields become submittable; never outlive the acknowledged capture grant.
              // Dispatched code still cannot be recalled. No generated-secret cache is retained.
              await contents.executeJavaScriptInIsolatedWorld(999, [
                {
                  code: completeGenerationScript(
                    origin,
                    token,
                    generatePassword(options),
                    Math.min(expires, captureUntil, Date.now() + Math.min(5000, vaultAccess.remaining())),
                  ),
                },
              ])
              check(true)
            } finally {
              owner.suspended++
            }
          }
        } finally {
          owner.suspended--
          layout(owner)
        }
      } finally {
        clearTimeout(timer)
        unsubscribe()
        contents.removeListener("did-start-navigation", revoke)
        owner.generationCheck = undefined
        try {
          if (!contents.isDestroyed())
            await contents.executeJavaScriptInIsolatedWorld(999, [{ code: clearGenerationScript(token) }])
        } catch {
          // A departed document already discarded its ticket.
        } finally {
          tab.loginBusy = false
          tab.revision++
          invalidateSnapshots(contents)
        }
      }
    } catch {
      // Never forward a page exception or secret-bearing execution details to app IPC.
      throw new Error(nativeT("desktop.browser.generation.failed"))
    }
  } else if (command.op === "save-login" || command.op === "fill-login") {
    if (
      command.op === "fill-login" &&
      command.revision !== undefined &&
      (!Number.isSafeInteger(command.revision) || command.revision !== tab.revision)
    )
      throw new Error("Login selection expired")
    if (tab.loginBusy || owner.suspended || owner.loginCheck)
      throw new Error("A browser dialog or login operation is already pending")
    const ticket = vaultAccess.require()
    const revision = tab.revision
    const viewport = owner.viewport
    let revoked = false
    const check = (attached = false) => {
      vaultAccess.require(ticket)
      if (
        revoked ||
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
    try {
      const login =
        command.op === "save-login"
          ? await pageLogin(contents, undefined, check)
          : browserProfile().credentials.find(
              (row) => "id" in command && row.id === command.id && row.origin === new URL(contents.getURL()).origin,
            )
      if (!login) throw new Error("No matching login")
      check(true)
      const confirm = async () => {
        check(true)
        owner.suspended++
        layout(owner)
        try {
          const answer = await dialog.showMessageBox(owner.win, {
            type: "question",
            message: nativeT(
              command.op === "save-login"
                ? "desktop.browser.saveLogin"
                : "field" in command && command.field === "username"
                  ? "desktop.browser.fillUsername"
                  : "field" in command && command.field === "password"
                    ? "desktop.browser.fillPassword"
                    : "desktop.browser.fillLogin",
            ),
            detail: nativeT(
              command.op === "save-login" ? "desktop.browser.saveLoginDetail" : "desktop.browser.fillLoginDetail",
              { origin: login.origin, username: login.username },
            ),
            buttons: [
              nativeT("desktop.browser.cancel"),
              nativeT(command.op === "save-login" ? "desktop.browser.save" : "desktop.browser.fill"),
            ],
            defaultId: 0,
            cancelId: 0,
          })
          check()
          return answer.response === 1
        } finally {
          owner.suspended--
          layout(owner)
        }
      }
      if (command.op === "fill-login") await pageLogin(contents, command.id, () => check(true), command.field, confirm)
      else if (await confirm()) {
        check(true)
        if ("password" in login) saveLogins([login])
      }
    } finally {
      owner.loginCheck = undefined
      tab.loginBusy = false
      tab.revision++
      invalidateSnapshots(contents)
      publish(owner, group)
    }
  } else if (command.op === "select") {
    group.activeID = tab.id
    persistGroup(owner, group)
    layout(owner)
  } else if (command.op === "close") contents.close({ waitForBeforeUnload: true })
  else if (command.op === "navigate") {
    if (!browserURL(command.url)) throw new Error("Invalid browser URL")
    await contents.loadURL(command.url)
  } else if (command.op === "back") {
    if (contents.navigationHistory.canGoBack()) contents.navigationHistory.goBack()
  } else if (command.op === "forward") {
    if (contents.navigationHistory.canGoForward()) contents.navigationHistory.goForward()
  } else if (command.op === "reload") {
    if (tab.permissionReload) reloadForPermissions(tab)
    else contents.reload()
  } else if (command.op === "stop") contents.stop()
  else if (command.op === "access") {
    if (command.enabled && tab.loginBusy) throw new Error("Login operation pending")
    if (command.enabled && !browserAgentEnabled()) throw new Error("Browser agent access is disabled")
    if (typeof command.enabled !== "boolean") throw new Error("Invalid browser access")
    if (!command.enabled) {
      tab.accessConsent?.abort()
      tab.screenshotConsent?.abort()
      tab.agentAccess = false
      tab.accessRevision = (tab.accessRevision ?? 0) + 1
      tab.revision++
      invalidateSnapshots(contents)
    } else if (!tab.agentAccess) {
      if (owner.suspended || tab.accessConsent) throw new Error("Browser consent already pending")
      const consent = new AbortController()
      const accessRevision = tab.accessRevision
      const revision = tab.revision
      const url = contents.getURL()
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
          detail: nativeT("desktop.browser.accessDetail"),
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
          if (valid()) tab.agentAccess = true
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
    if (owner.viewport?.lease === input.lease) {
      owner.taskEpoch++
      owner.tabConsent?.abort()
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
    if (owner.viewport?.sessionID !== input.sessionID || owner.viewport?.lease !== input.lease) {
      owner.taskEpoch++
      owner.tabConsent?.abort()
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
    if (request.op === "create_tab" && !group) {
      // ponytail: require manual restoration rather than merging unloaded recovery into a live group.
      const recovery = savedTabs(sessionID)
      if (recovery && (recovery.tabs.length || recovery.closed.length)) throw new TabRecoveryRequired()
    }
  }
  return {
    owner,
    target,
    source: group?.tabs.find((tab) => tab.id === activeID),
    check,
    async confirm(signal) {
      check()
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
          detail:
            request.op === "create_tab"
              ? nativeT("desktop.browser.tabs.createDetail", { task: sessionID })
              : nativeT("desktop.browser.tabs.targetDetail", { task: sessionID, tab: request.tabID }),
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
    run(authority) {
      authority()
      if (owner.suspended) throw new Error("Browser dialog pending")
      if (request.op === "create_tab") {
        // Do not restore saved tabs as a side effect of an agent's single-tab creation.
        const destination = group ?? { sessionID, tabs: [], closed: [] }
        if (!group) owner.groups.set(sessionID, destination)
        const created = createTab(owner, destination)
        owner.win.webContents.send("browser-opened", sessionID)
        return created.id
      }
      if (!target || !group) throw new Error("Missing tab")
      if (request.op === "select_tab") {
        group.activeID = target.id
        persistGroup(owner, group)
        layout(owner)
        publish(owner, group)
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
          if (!proceed || event.defaultPrevented) setImmediate(() => finish(contents.isDestroyed()))
        }
        const pending = { check: authority }
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
