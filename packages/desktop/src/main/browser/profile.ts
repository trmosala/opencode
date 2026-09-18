import { randomUUID } from "node:crypto"
import { open } from "node:fs/promises"
import { dialog, Notification } from "electron"
import type { BrowserWindow, Session, WebContents } from "electron"
import type { BrowserProfile, BrowserClearKind, BrowserClearRange } from "@opencode-ai/app/browser-panel"
import { getStore } from "../store"
import { nativeT } from "../native-translations"
import {
  loginOrigin,
  mergeLogins,
  parseCookieJSON,
  parsePasswordCSV,
  requireLogin,
  type BrowserLogin,
} from "./import-data"
import { browserPreferencesState, downloadDirectory, sitePermissions } from "./preferences"
import { loadAllowlist } from "./allowlist"
import { clearLogins, readLogins, vaultAvailable, writeLogins } from "./vault"
import { prepareLoginScript, completeLoginScript } from "./login-form"
import { vaultAccess } from "./vault-session"
import { historyRows, clearSince, validateClear } from "./browsing-data"
import { clearClosedTabs } from "./tab-recovery"
import { transferRules } from "./transfer-permissions"
import { loginOfferExclusions } from "./login-offers"
import { bookmarks, validateBookmarks, writeBookmarks } from "./bookmarks"
import { loginEntry, loginEntryAvailable } from "./login-entry"
import { contactSummary } from "./contacts"

let editingLogin = false

const store = () => getStore("cm-browser")

function loginSummary() {
  const vaultStatus = vaultAccess.status()
  if (vaultStatus !== "unlocked") return { credentials: [], vaultAvailable: vaultAvailable(), vaultStatus }
  try {
    const ticket = vaultAccess.require()
    const credentials = readLogins(false).map(({ id, origin, username }) => ({ id, origin, username }))
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
    notificationsSupported: Notification.isSupported(),
    agentHosts: loadAllowlist(),
    loginEntryAvailable: loginEntryAvailable(),
    ...loginSummary(),
    ...contactSummary(),
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
  const plan = mergeLogins(readLogins(), logins)
  if (plan.add || plan.replace) writeLogins(plan.rows)
}

export async function editLogin(win: BrowserWindow, input: { origin: string; id?: string }) {
  if (editingLogin) throw new Error("Account entry already pending")
  const ticket = vaultAccess.require()
  if (
    typeof input.origin !== "string" ||
    input.origin.length > 2048 ||
    (input.id !== undefined && typeof input.id !== "string")
  )
    throw new Error("Invalid account")
  const origin = loginOrigin(input.origin)
  const previous = input.id === undefined ? undefined : readLogins().find((row) => row.id === input.id)
  if (input.id !== undefined && (!previous || previous.origin !== origin)) throw new Error("Account changed")
  const check = () => {
    vaultAccess.require(ticket)
    if (win.isDestroyed() || !win.isVisible() || win.isMinimized()) throw new Error("Account window changed")
  }
  check()
  editingLogin = true
  try {
    const entered = await loginEntry.prompt(win, origin, previous?.username ?? "")
    check()
    if (!entered) return
    const login = requireLogin(entered)
    if (login.origin !== origin) throw new Error("Account origin changed")
    const answer = await dialog.showMessageBox(win, {
      type: "question",
      message: nativeT("desktop.browser.account.confirm"),
      detail: nativeT("desktop.browser.account.detail", { origin, username: login.username }),
      buttons: [nativeT("desktop.browser.cancel"), nativeT("desktop.browser.save")],
      defaultId: 0,
      cancelId: 0,
    })
    check()
    if (answer.response !== 1) return
    const current = readLogins()
    const selected = current.find((row) => row.id === previous?.id)
    if (
      previous &&
      (!selected ||
        selected.origin !== previous.origin ||
        selected.username !== previous.username ||
        selected.password !== previous.password)
    )
      throw new Error("Account changed; retry the edit")
    if (current.some((row) => row.id !== previous?.id && row.origin === origin && row.username === login.username))
      throw new Error("Account already exists")
    check()
    writeLogins([{ id: previous?.id ?? randomUUID(), ...login }, ...current.filter((row) => row.id !== previous?.id)])
  } finally {
    editingLogin = false
  }
}

export function forgetLogin(id: string) {
  if (typeof id !== "string") throw new Error("Invalid credential")
  writeLogins(readLogins().filter((row) => row.id !== id))
}

// Use the isolated world and the native input setter; never return passwords to the app renderer or submit forms.
export async function pageLogin(
  contents: WebContents,
  id?: string,
  check = () => {},
  field?: "username" | "password",
  confirm?: () => Promise<boolean>,
) {
  if (field !== undefined && (id === undefined || !["username", "password"].includes(field)))
    throw new Error("Invalid login field")
  const ticket = vaultAccess.require()
  const origin = loginOrigin(contents.getURL())
  if (!vaultAvailable()) throw new Error("Secure storage unavailable")
  const credential = id === undefined ? undefined : readLogins().find((row) => row.id === id && row.origin === origin)
  if (id !== undefined && !credential) throw new Error("Credential origin mismatch")
  const token = randomUUID()
  check()
  try {
    await contents.executeJavaScriptInIsolatedWorld(999, [{ code: prepareLoginScript(origin, token, field) }])
    vaultAccess.require(ticket)
    check()
    // Consent belongs to these fields, not a document discovered after the dialog.
    if (confirm && !(await confirm())) return
    vaultAccess.require(ticket)
    check()
    if (credential) {
      const current = readLogins().find((row) => row.id === id)
      if (
        !current ||
        current.origin !== origin ||
        current.username !== credential.username ||
        current.password !== credential.password
      )
        throw new Error("Account changed")
    }
    check()
    vaultAccess.require(ticket)
    const result = await contents.executeJavaScriptInIsolatedWorld(999, [
      {
        code: completeLoginScript(
          origin,
          token,
          credential,
          Date.now() + Math.min(5000, vaultAccess.remaining()),
          field,
        ),
      },
    ])
    vaultAccess.require(ticket)
    check()
    if (!credential) return requireLogin(result)
  } catch {
    // Page exceptions and execution details must never cross the app IPC boundary.
    throw new Error("Login operation failed")
  } finally {
    if (!contents.isDestroyed())
      await contents
        .executeJavaScriptInIsolatedWorld(999, [
          {
            code: `if (document.__cmLoginTicket?.token === ${JSON.stringify(token)}) { document.__cmLoginTicket.observer.disconnect(); delete document.__cmLoginTicket } true`,
          },
        ])
        .catch(() => undefined)
  }
}

// ponytail: one process-local import at a time; no cross-process or atomic-cookie guarantee.
let importing = false

export async function importBrowserData(
  win: BrowserWindow,
  profile: Session,
  kind: "passwords" | "cookies" | "bookmarks",
  ownerCheck: () => void,
) {
  if (importing || !["passwords", "cookies", "bookmarks"].includes(kind))
    throw new Error(nativeT("desktop.browser.import.unavailable"))
  if (win.isDestroyed()) throw new Error(nativeT("desktop.browser.import.unavailable"))
  const contents = win.webContents
  importing = true
  let invalid = false
  let reason = nativeT("desktop.browser.import.unavailable")
  const revoke = () => {
    invalid = true
  }
  const deadline = performance.now() + 300_000
  win.on("hide", revoke)
  win.on("minimize", revoke)
  win.on("close", revoke)
  win.on("closed", revoke)
  contents.on("did-start-navigation", revoke)
  contents.on("render-process-gone", revoke)
  contents.on("destroyed", revoke)
  try {
    const ticket = kind === "passwords" ? vaultAccess.require() : undefined
    const check = () => {
      try {
        if (
          invalid ||
          performance.now() >= deadline ||
          win.isDestroyed() ||
          contents.isDestroyed() ||
          win.webContents !== contents ||
          !win.isVisible() ||
          win.isMinimized()
        )
          throw new Error()
        ownerCheck()
        if (kind === "passwords") {
          vaultAccess.require(ticket)
          if (!vaultAvailable()) throw new Error()
        }
      } catch {
        invalid = true
        reason = nativeT("desktop.browser.import.stale")
        throw new Error(reason)
      }
    }
    check()
    const title = nativeT(
      kind === "passwords"
        ? "desktop.browser.importPasswords"
        : kind === "cookies"
          ? "desktop.browser.importCookies"
          : "desktop.browser.importBookmarks",
    )
    const extension = kind === "passwords" ? "csv" : kind === "cookies" ? "json" : "html"
    const chosen = await dialog.showOpenDialog(win, {
      title,
      properties: ["openFile"],
      filters: [{ name: extension.toUpperCase(), extensions: kind === "bookmarks" ? ["html", "htm"] : [extension] }],
    })
    check()
    if (chosen.canceled || !chosen.filePaths[0]) return
    reason = nativeT("desktop.browser.import.file")
    const file = await open(chosen.filePaths[0], "r")
    let text = ""
    try {
      check()
      const stat = await file.stat()
      check()
      if (!stat.isFile() || stat.size > 5 * 1024 * 1024) throw new Error()
      const buffer = Buffer.alloc(5 * 1024 * 1024 + 1)
      try {
        let size = 0
        while (size < buffer.length) {
          const result = await file.read(buffer, size, buffer.length - size, null)
          check()
          if (!result.bytesRead) break
          size += result.bytesRead
        }
        if (size === buffer.length) throw new Error()
        text = buffer.toString("utf8", 0, size)
      } finally {
        buffer.fill(0)
      }
    } finally {
      await file.close()
    }
    check()
    reason = nativeT("desktop.browser.import.invalid")
    const counts = { valid: 0, duplicate: 0, add: 0, replace: 0, unchanged: 0, unsupported: 0 }
    let commit: () => void = () => {}
    let cookieRows: ReturnType<typeof parseCookieJSON> = []
    const cookieKey = (row: { domain?: string; url?: string; hostOnly?: boolean; path?: string; name?: string }) =>
      JSON.stringify([
        row.hostOnly === true || !row.domain
          ? new URL(row.url ?? `https://${row.domain}/`).hostname
          : "." + row.domain.replace(/^\./, "").toLowerCase(),
        row.path ?? "/",
        row.name ?? "",
      ])
    const cookieValue = (row: Electron.Cookie | Electron.CookiesSetDetails) =>
      JSON.stringify([
        cookieKey(row),
        row.value,
        row.secure ?? false,
        row.httpOnly ?? false,
        row.sameSite ?? "unspecified",
        row.expirationDate ?? null,
      ])
    let baseline = new Map<string, string>()
    const destination = (rows: Electron.Cookie[]) => {
      const result = new Map<string, string>()
      for (const row of rows) {
        const key = cookieKey(row)
        const value = cookieValue(row)
        // Refuse ambiguous/partitioned destinations instead of overwriting a broader scope.
        if (result.has(key) || "partitionKey" in row) throw new Error()
        result.set(key, value)
      }
      return result
    }
    if (kind === "passwords") {
      const imported = await parsePasswordCSV(text)
      check()
      const before = JSON.stringify([store().get("vault"), store().get("credentials")])
      const plan = mergeLogins(readLogins(false), imported)
      for (const key of Object.keys(counts) as (keyof typeof counts)[]) counts[key] = plan[key]
      commit = () => {
        if (JSON.stringify([store().get("vault"), store().get("credentials")]) !== before) throw new Error()
        if (plan.add || plan.replace) writeLogins(plan.rows)
      }
    }
    if (kind === "bookmarks") {
      const { parseBookmarks } = await import("./bookmark-format")
      check()
      const imported = parseBookmarks(text, counts)
      const current = bookmarks()
      const before = JSON.stringify(store().get("bookmarks"))
      const next = new Map(current.map((row) => [new URL(row.url).href, row]))
      const seen = new Set<string>()
      counts.valid = imported.length
      for (const row of imported) {
        if (seen.has(row.url)) {
          counts.duplicate++
          continue
        }
        seen.add(row.url)
        if (next.has(row.url)) {
          counts.unchanged++
          continue
        }
        next.set(row.url, { ...row, id: randomUUID() })
        counts.add++
      }
      validateBookmarks([...next.values()])
      commit = () => {
        if (JSON.stringify(store().get("bookmarks")) !== before) throw new Error()
        if (counts.add) writeBookmarks([...next.values()])
      }
    }
    if (kind === "cookies") {
      const imported = parseCookieJSON(text)
      const unique = new Map(imported.map((row) => [cookieKey(row), row]))
      counts.valid = imported.length
      counts.duplicate = imported.length - unique.size
      baseline = destination(await profile.cookies.get({}))
      check()
      cookieRows = [...unique.values()]
      for (const row of cookieRows) {
        const previous = baseline.get(cookieKey(row))
        if (previous === cookieValue(row)) counts.unchanged++
        else if (previous !== undefined) counts.replace++
        else counts.add++
      }
    }
    text = ""
    check()
    const answer = await dialog.showMessageBox(win, {
      type: "warning",
      title,
      message: nativeT("desktop.browser.import.review"),
      detail: [
        nativeT("desktop.browser.import.counts", counts),
        nativeT(`desktop.browser.import.${kind}`),
        nativeT("desktop.browser.import.scope"),
      ].join("\n\n"),
      buttons: [nativeT("desktop.browser.cancel"), nativeT("desktop.browser.import.confirm")],
      defaultId: 0,
      cancelId: 0,
    })
    check()
    if (answer.response !== 1) return
    reason = nativeT("desktop.browser.import.stale")
    let detail: string
    if (kind !== "cookies") {
      commit()
      detail = nativeT("desktop.browser.import.saved", { ...counts, successful: counts.add + counts.replace })
    } else {
      let successful = 0
      let failed = 0
      let interrupted = false
      let flush = nativeT("desktop.browser.import.noFlush")
      const pending = cookieRows.filter((row) => baseline.get(cookieKey(row)) !== cookieValue(row))
      try {
        const current = destination(await profile.cookies.get({}))
        check()
        if (cookieRows.some((row) => current.get(cookieKey(row)) !== baseline.get(cookieKey(row)))) throw new Error()
        for (const row of pending) {
          check()
          const current = destination(await profile.cookies.get({ name: row.name, domain: new URL(row.url).hostname }))
          check()
          if (current.get(cookieKey(row)) !== baseline.get(cookieKey(row))) throw new Error()
          try {
            await profile.cookies.set(row)
            successful++
          } catch {
            failed++
            interrupted = true
            break
          }
          check()
        }
      } catch {
        interrupted = true
      } finally {
        // Flush already-applied effects even when consent/ownership is no longer valid.
        if (successful) {
          try {
            await profile.cookies.flushStore()
            flush = nativeT("desktop.browser.import.flushed")
          } catch {
            flush = nativeT("desktop.browser.import.flushFailed")
          }
        }
      }
      try {
        check()
      } catch {
        interrupted = true
      }
      detail = nativeT("desktop.browser.import.cookieResult", {
        successful,
        failed,
        unattempted: pending.length - successful - failed,
        unchanged: counts.unchanged,
        duplicate: counts.duplicate,
        flush,
        status: nativeT(interrupted ? "desktop.browser.import.interrupted" : "desktop.browser.import.finished"),
      })
    }
    const result: Electron.MessageBoxOptions = {
      type: "info",
      title,
      message: nativeT("desktop.browser.import.result"),
      detail,
      buttons: [nativeT("desktop.browser.import.close")],
      defaultId: 0,
      cancelId: 0,
    }
    // Results contain counts only and remain reportable after owner destruction.
    reason = detail
    if (win.isDestroyed()) await dialog.showMessageBox(result)
    else await dialog.showMessageBox(win, result)
  } catch {
    // Never echo native/parser/path errors, including failures to display the result.
    throw new Error(reason)
  } finally {
    win.removeListener("hide", revoke)
    win.removeListener("minimize", revoke)
    win.removeListener("close", revoke)
    win.removeListener("closed", revoke)
    contents.removeListener("did-start-navigation", revoke)
    contents.removeListener("render-process-gone", revoke)
    contents.removeListener("destroyed", revoke)
    importing = false
  }
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
