import { randomUUID } from "node:crypto"
import { app, BrowserWindow, dialog, type WebContents } from "electron"
import { nativeT } from "../native-translations"
import { loginEntry, loginEntryAvailable } from "../browser/login-entry"
import { mergeLogins } from "../browser/import-data"
import { initializeVaultLocking, vaultAccess } from "../browser/vault-session"
import { readLogins, writeLogins, vaultAvailable } from "../browser/vault"
import {
  WPP_OKTA_ORIGIN,
  prepareOktaLoginScript,
  completeOktaLoginScript,
  clearOktaLoginScript,
} from "./okta-login-form"

type Action = "fill" | "save" | "manage" | "lock"
const controls = new WeakMap<WebContents, { available(): boolean; run(action: Action): Promise<void> }>()
const listeners = new Set<() => void>()
const changed = () => listeners.forEach((listener) => listener())
vaultAccess.subscribe(changed)

export function subscribeWppLoginMenu(listener: () => void) {
  listeners.add(listener)
  app.on("browser-window-focus", listener)
  app.on("browser-window-blur", listener)
  return () => {
    listeners.delete(listener)
    app.removeListener("browser-window-focus", listener)
    app.removeListener("browser-window-blur", listener)
  }
}

// Called only for the interactive SSO window and its popups, never worker tabs.
export function attachWppLoginControls(win: BrowserWindow) {
  const contents = win.webContents
  if (controls.has(contents)) return
  initializeVaultLocking()
  let busy = false
  let pending: AbortController | undefined
  const available = () =>
    !win.isDestroyed() &&
    !contents.isDestroyed() &&
    win.isVisible() &&
    !win.isMinimized() &&
    URL.parse(contents.getURL())?.origin === WPP_OKTA_ORIGIN
  const cancel = () => {
    pending?.abort()
    changed()
  }
  win.on("hide", cancel)
  win.on("minimize", cancel)
  contents.on("did-start-navigation", (_event, _url, _inPlace, main) => {
    if (main) cancel()
  })
  contents.on("render-process-gone", cancel)
  contents.on("did-navigate", changed)
  contents.on("did-finish-load", changed)
  win.on("show", changed)
  contents.on("did-create-window", (child) => attachWppLoginControls(child))
  win.once("closed", () => {
    cancel()
    controls.delete(contents)
    changed()
  })
  controls.set(contents, {
    available: () => available() && !busy && vaultAvailable(),
    async run(action) {
      if (action === "lock") return vaultAccess.lock()
      if (busy || !available()) return
      busy = true
      changed()
      const consent = new AbortController()
      pending = consent
      const timer = setTimeout(() => consent.abort(), 120_000)
      let ticket: number | undefined
      const unsubscribe = vaultAccess.subscribe(() => {
        if (ticket !== undefined && vaultAccess.status() !== "unlocked") consent.abort()
      })
      const check = () => {
        if (consent.signal.aborted || !available()) throw new Error("WPP login operation cancelled")
        if (ticket !== undefined) vaultAccess.require(ticket)
      }
      try {
        check()
        await vaultAccess.unlock(win)
        check()
        ticket = vaultAccess.require()
        if (action === "save") return await saveWppAccount(win, undefined, check, consent.signal)
        const accounts = readLogins().filter((row) => row.origin === WPP_OKTA_ORIGIN)
        if (!accounts.length) {
          const answer = await dialog.showMessageBox(win, {
            message: nativeT("desktop.wpp.login.empty"),
            buttons: [nativeT("desktop.browser.cancel"), nativeT("desktop.wpp.login.save")],
            defaultId: 0,
            cancelId: 0,
            signal: consent.signal,
          })
          check()
          if (answer.response === 1) await saveWppAccount(win, undefined, check, consent.signal)
          return
        }
        // Native message-box buttons are a bounded chooser, not a second vault UI.
        if (
          accounts.length > 8 ||
          accounts.some(
            (row) => !row.username.trim() || row.username.length > 128 || /[\p{Cc}\p{Cf}]/u.test(row.username),
          )
        ) {
          await dialog.showMessageBox(win, {
            message: nativeT("desktop.wpp.login.browserManage"),
            buttons: [nativeT("desktop.browser.cancel")],
            signal: consent.signal,
          })
          return
        }
        const choice = await dialog.showMessageBox(win, {
          message: nativeT("desktop.wpp.login.choose"),
          detail: WPP_OKTA_ORIGIN,
          buttons: [nativeT("desktop.browser.cancel"), ...accounts.map((row) => row.username)],
          defaultId: 0,
          cancelId: 0,
          signal: consent.signal,
        })
        check()
        const account = accounts[choice.response - 1]
        if (!account) return
        const unchanged = () => {
          check()
          const current = readLogins().find((row) => row.id === account.id)
          if (
            !current ||
            current.origin !== account.origin ||
            current.username !== account.username ||
            current.password !== account.password
          )
            throw new Error("WPP account changed")
        }
        unchanged()
        if (action === "manage") {
          const answer = await dialog.showMessageBox(win, {
            message: nativeT("desktop.wpp.login.manage"),
            detail: nativeT("desktop.browser.account.detail", { origin: account.origin, username: account.username }),
            buttons: [
              nativeT("desktop.browser.cancel"),
              nativeT("desktop.browser.offer.updateButton"),
              nativeT("desktop.wpp.login.forget"),
            ],
            defaultId: 0,
            cancelId: 0,
            signal: consent.signal,
          })
          unchanged()
          if (answer.response === 1) await saveWppAccount(win, account, unchanged, consent.signal)
          if (answer.response === 2) writeLogins(readLogins().filter((row) => row.id !== account.id))
          return
        }
        const token = randomUUID()
        try {
          const field: unknown = await contents.executeJavaScriptInIsolatedWorld(999, [
            { code: prepareOktaLoginScript(token) },
          ])
          unchanged()
          if (field !== "username" && field !== "password") throw new Error("Unsupported Okta step")
          const answer = await dialog.showMessageBox(win, {
            message: nativeT(field === "username" ? "desktop.browser.fillUsername" : "desktop.browser.fillPassword"),
            detail: nativeT("desktop.wpp.login.fillDetail", { username: account.username, origin: account.origin }),
            buttons: [nativeT("desktop.browser.cancel"), nativeT("desktop.browser.fill")],
            defaultId: 0,
            cancelId: 0,
            signal: consent.signal,
          })
          unchanged()
          if (answer.response !== 1) return
          await contents.executeJavaScriptInIsolatedWorld(999, [
            {
              code: completeOktaLoginScript(
                token,
                account,
                field,
                Date.now() + Math.min(5000, vaultAccess.remaining()),
              ),
            },
          ])
          unchanged()
        } finally {
          if (!contents.isDestroyed())
            await contents
              .executeJavaScriptInIsolatedWorld(999, [{ code: clearOktaLoginScript(token) }])
              .catch(() => undefined)
        }
      } catch {
        // Page exceptions and child-process failures may contain secrets. Show fixed copy only.
        if (!consent.signal.aborted && !win.isDestroyed() && win.isVisible())
          await dialog
            .showMessageBox(win, {
              type: "error",
              message: nativeT("desktop.wpp.login.failed"),
              buttons: [nativeT("desktop.browser.cancel")],
            })
            .catch(() => undefined)
      } finally {
        clearTimeout(timer)
        unsubscribe()
        pending = undefined
        busy = false
        changed()
      }
    },
  })
  changed()
}

export function wppLoginMenu(contents?: WebContents, always = false) {
  const current = contents ?? BrowserWindow.getFocusedWindow()?.webContents
  const control = current && controls.get(current)
  if (!control && !always) return []
  return (["fill", "save", "manage", "lock"] as const).map((action) => ({
    label: nativeT(`desktop.wpp.login.${action === "fill" ? "use" : action}`),
    enabled:
      action === "lock"
        ? !!control && vaultAccess.status() === "unlocked"
        : !!control?.available() && (action !== "save" || loginEntryAvailable()),
    click: () => {
      const target = contents ?? BrowserWindow.getFocusedWindow()?.webContents
      return target ? controls.get(target)?.run(action) : undefined
    },
  }))
}

async function saveWppAccount(
  win: BrowserWindow,
  previous: ReturnType<typeof readLogins>[number] | undefined,
  check: () => void,
  signal: AbortSignal,
) {
  check()
  const entered = await loginEntry.prompt(
    win,
    WPP_OKTA_ORIGIN,
    previous?.username ?? "",
    nativeT("desktop.wpp.login.entry"),
    signal,
  )
  check()
  if (!entered) return
  if (!entered.username.trim() || entered.origin !== WPP_OKTA_ORIGIN) throw new Error("Invalid WPP account")
  const before = readLogins()
  const match = before.find((row) => row.origin === entered.origin && row.username === entered.username)
  if (previous && match && match.id !== previous.id) throw new Error("WPP account already exists")
  const answer = await dialog.showMessageBox(win, {
    message: nativeT("desktop.browser.account.confirm"),
    detail: nativeT("desktop.browser.account.detail", { origin: entered.origin, username: entered.username }),
    buttons: [nativeT("desktop.browser.cancel"), nativeT("desktop.browser.save")],
    defaultId: 0,
    cancelId: 0,
    signal,
  })
  check()
  if (answer.response !== 1) return
  const current = readLogins()
  if (JSON.stringify(current) !== JSON.stringify(before)) throw new Error("Saved accounts changed")
  const plan = mergeLogins(previous ? current.filter((row) => row.id !== previous.id) : current, [entered])
  writeLogins(
    previous
      ? plan.rows.map((row) =>
          row.origin === entered.origin && row.username === entered.username ? { ...row, id: previous.id } : row,
        )
      : plan.rows,
  )
}
