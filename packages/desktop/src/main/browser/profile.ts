import { randomUUID } from "node:crypto"
import { open } from "node:fs/promises"
import { dialog } from "electron"
import type { BrowserWindow, Session, WebContents } from "electron"
import type { BrowserProfile, BrowserClearKind, BrowserClearRange } from "@opencode-ai/app/browser-panel"
import { getStore } from "../store"
import { nativeT } from "../native-translations"
import { loginOrigin, parseCookieJSON, parsePasswordCSV, requireLogin, type BrowserLogin } from "./import-data"
import { browserPreferencesState, downloadDirectory, sitePermissions } from "./preferences"
import { loadAllowlist } from "./allowlist"
import { clearLogins, readLogins, vaultAvailable, writeLogins } from "./vault"
import { prepareLoginScript, completeLoginScript } from "./login-form"
import { vaultAccess } from "./vault-session"
import { historyRows, clearSince, validateClear } from "./browsing-data"
import { clearClosedTabs } from "./tab-recovery"
import { transferRules } from "./transfer-permissions"
import { loginOfferExclusions } from "./login-offers"
import { bookmarks } from "./bookmarks"

const store = () => getStore("cm-browser")

function loginSummary() {
  const vaultStatus = vaultAccess.status()
  if (vaultStatus !== "unlocked") return { credentials: [], vaultAvailable: vaultAvailable(), vaultStatus }
  try {
    const ticket = vaultAccess.require()
    const credentials = readLogins().map(({ id, origin, username }) => ({ id, origin, username }))
    vaultAccess.require(ticket)
    return {
      credentials,
      vaultAvailable: true,
      vaultStatus,
    }
  } catch {
    return { credentials: [], vaultAvailable: false, vaultStatus: vaultAccess.status() }
  }
}

export function browserProfile(): BrowserProfile {
  return {
    transferRules: transferRules(),
    loginOfferExclusions: loginOfferExclusions(),
    history: historyRows(),
    bookmarks: bookmarks(),
    rememberHistory: store().get("rememberHistory", true) === true,
    preferences: browserPreferencesState(),
    downloadDirectory: downloadDirectory(),
    sites: sitePermissions(),
    agentHosts: loadAllowlist(),
    ...loginSummary(),
  }
}

export function rememberPage(url: string, title: string) {
  if (store().get("rememberHistory", true) !== true || !/^https?:/.test(url)) return
  const rows = historyRows()
  if (rows[0]?.url === url && Date.now() - rows[0].time < 1000) return
  store().set(
    "history",
    [{ id: randomUUID(), url, title: title.slice(0, 512), time: Date.now() }, ...rows].slice(0, 2000),
  )
}

export function browserSettings(rememberHistory: boolean) {
  if (typeof rememberHistory !== "boolean") throw new Error("Invalid settings")
  store().set("rememberHistory", rememberHistory)
}

export function saveLogins(logins: BrowserLogin[]) {
  if (!vaultAvailable()) throw new Error("Secure storage unavailable")
  const batch = logins.map((value) => ({ id: randomUUID(), ...requireLogin(value) }))
  const next = new Map(readLogins().map((row) => [JSON.stringify([row.origin, row.username]), row]))
  batch.forEach((row) => next.set(JSON.stringify([row.origin, row.username]), row))
  if (next.size > 2000) throw new Error("Vault limit reached")
  writeLogins([...next.values()])
}

export function forgetLogin(id: string) {
  if (typeof id !== "string") throw new Error("Invalid credential")
  writeLogins(readLogins().filter((row) => row.id !== id))
}

// Use the isolated world and the native input setter; never return passwords to the app renderer or submit forms.
export async function pageLogin(contents: WebContents, id?: string, check = () => {}, field?: "username" | "password") {
  if (field !== undefined && (id === undefined || !["username", "password"].includes(field)))
    throw new Error("Invalid login field")
  const ticket = vaultAccess.require()
  const origin = loginOrigin(contents.getURL())
  if (!vaultAvailable()) throw new Error("Secure storage unavailable")
  const token = randomUUID()
  await contents.executeJavaScriptInIsolatedWorld(999, [{ code: prepareLoginScript(origin, token, field) }])
  vaultAccess.require(ticket)
  check()
  const credential = id === undefined ? undefined : readLogins().find((row) => row.id === id && row.origin === origin)
  if (id !== undefined && !credential) throw new Error("Credential origin mismatch")
  check()
  vaultAccess.require(ticket)
  const result = await contents.executeJavaScriptInIsolatedWorld(999, [
    {
      code: completeLoginScript(origin, token, credential, Date.now() + Math.min(5000, vaultAccess.remaining()), field),
    },
  ])
  vaultAccess.require(ticket)
  check()
  if (!credential) return requireLogin(result)
}

export async function importBrowserData(win: BrowserWindow, profile: Session, kind: "passwords" | "cookies") {
  if (kind !== "passwords" && kind !== "cookies") throw new Error("Invalid import")
  const ticket = kind === "passwords" ? vaultAccess.require() : undefined
  const answer = await dialog.showOpenDialog(win, {
    title: nativeT(kind === "passwords" ? "desktop.browser.importPasswords" : "desktop.browser.importCookies"),
    properties: ["openFile"],
    filters: [{ name: kind === "passwords" ? "CSV" : "JSON", extensions: [kind === "passwords" ? "csv" : "json"] }],
  })
  if (answer.canceled || !answer.filePaths[0]) return
  if (kind === "passwords") vaultAccess.require(ticket)
  const file = await open(answer.filePaths[0], "r")
  const buffer = Buffer.alloc(5 * 1024 * 1024 + 1)
  const text = await (async () => {
    try {
      if (!(await file.stat()).isFile()) throw new Error("Invalid import file")
      let size = 0
      while (size < buffer.length) {
        const result = await file.read(buffer, size, buffer.length - size, null)
        if (!result.bytesRead) break
        size += result.bytesRead
      }
      if (size === buffer.length) throw new Error("Import too large")
      return buffer.toString("utf8", 0, size)
    } finally {
      buffer.fill(0)
      await file.close()
    }
  })()
  if (kind === "passwords") {
    const logins = await parsePasswordCSV(text)
    vaultAccess.require(ticket)
    saveLogins(logins)
    return
  }
  const cookies = parseCookieJSON(text)
  // Validation precedes mutation. Chromium remains authoritative for cookie validity.
  for (const cookie of cookies) await profile.cookies.set(cookie)
  await profile.cookies.flushStore()
}

export async function clearBrowserData(profile: Session, kind: BrowserClearKind, range: BrowserClearRange = "all") {
  validateClear([kind], range)
  if (kind === "downloads" || kind === "history") {
    if (kind === "history") clearClosedTabs(clearSince(range))
    const rows = kind === "history" ? historyRows() : (store().get("downloads", []) as { time?: number }[])
    store().set(kind, range === "all" ? [] : rows.filter((row) => !row.time || row.time < clearSince(range)))
    return
  }
  if (kind === "passwords") return clearLogins()
  if (kind === "cache") return profile.clearCache()
  if (kind !== "cookies") throw new Error("Invalid data type")
  await profile.clearStorageData()
  await profile.clearAuthCache()
}
