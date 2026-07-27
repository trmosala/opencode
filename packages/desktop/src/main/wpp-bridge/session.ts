// Isolated session + worker-window factory for the WPP assistant pool.
//
// All WPP traffic lives in a dedicated persistent partition so SSO cookies survive restarts
// (the "one-time login" requirement) and stay fully isolated from the oc://renderer session.
// Worker windows are created hidden; they are shown only for the first-run interactive SSO login,
// or for debugging when O1_CODE_SHOW_WORKERS=1 (the pool calls showInactive on spawn).

import { BrowserWindow, session, type Session } from "electron"
import { WPP_COOKIE_MONSTER_PROJECT_URL } from "./proxy/wppProject.mjs"

export const WPP_PARTITION = "persist:wpp"

// Origins the assistant is reachable on (mirrors extension/manifest.json host_permissions and
// background.js ASSISTANT_ORIGINS / WORKSPACE_ORIGIN).
export const WPP_WORKSPACE_ORIGIN = "https://ogilvy.os.wpp.com"
export const WPP_ASSISTANT_ORIGINS = [
  "https://open-web-agents-cs.wpp.ai",
  "https://open-web-assistant-cs.wpp.ai",
  "https://open-web-deeplink-cs.wpp.ai",
]

const configuredSessions = new WeakSet<Session>()
const recoveredWebContents = new Set<number>()

export function wppSession(): Session {
  const current = session.fromPartition(WPP_PARTITION)
  if (configuredSessions.has(current)) return current
  configuredSessions.add(current)

  current.webRequest.onResponseStarted((details) => {
    if (!isExpiredWppSession(details) || !details.webContents || recoveredWebContents.has(details.webContents.id)) {
      return
    }

    recoveredWebContents.add(details.webContents.id)
    console.warn("cookiemonster: expired WPP session detected; returning to sign-in")
    void current
      .clearStorageData({ origin: WPP_WORKSPACE_ORIGIN, storages: ["cookies", "localstorage"] })
      .then(() => {
        if (!details.webContents?.isDestroyed()) details.webContents.reloadIgnoringCache()
      })
      .catch((error) => console.error("cookiemonster: failed to reset expired WPP session", error))
  })

  return current
}

// One offscreen worker window hosting a single authenticated WPP assistant page. Replaces one
// "owned tab" from the MV3 background.js tab pool. Hidden by default; the pool manager (next
// phase) owns lifecycle, LRU reuse, and per-agent affinity across N of these.
export function createWorkerWindow({ show = false } = {}): BrowserWindow {
  const current = wppSession()
  return new BrowserWindow({
    show,
    width: 1440,
    height: 1000,
    webPreferences: {
      session: current,
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  })
}

let loginWindow: BrowserWindow | null = null

export function openWppLogin(url = WPP_COOKIE_MONSTER_PROJECT_URL) {
  if (loginWindow && !loginWindow.isDestroyed()) {
    loginWindow.focus()
    return loginWindow
  }
  const win = createWorkerWindow({ show: true })
  win.webContents.setWindowOpenHandler(() => ({
    action: "allow",
    overrideBrowserWindowOptions: { webPreferences: { partition: WPP_PARTITION } },
  }))
  win.on("closed", () => { if (loginWindow === win) loginWindow = null })
  void win.loadURL(url)
  loginWindow = win
  return win
}

// View-menu toggle: close the login window if it's open, else open it.
export function toggleWppLogin(url = WPP_COOKIE_MONSTER_PROJECT_URL) {
  if (loginWindow && !loginWindow.isDestroyed()) {
    loginWindow.close()
    return
  }
  openWppLogin(url)
}

function isExpiredWppSession(details: { statusCode: number; url: string }) {
  if (details.statusCode !== 401) return false
  try {
    const url = new URL(details.url)
    return url.origin === WPP_WORKSPACE_ORIGIN && url.pathname === "/api/users/me"
  } catch {
    return false
  }
}
