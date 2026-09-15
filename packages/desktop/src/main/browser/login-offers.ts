import { randomUUID } from "node:crypto"
import { dialog, type BrowserWindow, type WebContents } from "electron"
import { nativeT } from "../native-translations"
import { getStore } from "../store"
import { vaultAccess } from "./vault-session"
import { readLogins, writeLogins, vaultAvailable } from "./vault"
import { loginOrigin, requireLogin, type BrowserLogin } from "./import-data"
import { browserPreferencesState } from "./preferences"
import { loginOfferScript, loginOfferSucceeded } from "./login-offer-script"

export function loginOfferExclusions(): string[] {
  const value = getStore("cm-browser").get("loginOfferExclusions", [])
  return Array.isArray(value) ? value.filter((entry): entry is string => typeof entry === "string").slice(0, 200) : []
}
export function allowLoginOffers(origin: string) {
  getStore("cm-browser").set(
    "loginOfferExclusions",
    loginOfferExclusions().filter((entry) => entry !== loginOrigin(origin)),
  )
}

export function watchLoginOffers(
  win: BrowserWindow,
  contents: WebContents,
  active: () => boolean,
  available: () => boolean,
  busy: (value: boolean) => void,
  changed: () => void,
) {
  const binding = `cmLoginOffer${randomUUID().replaceAll("-", "")}`
  const world = `CookieMonster login offers ${randomUUID()}`
  let revision = 0
  let context: number | undefined
  let installing = false
  let checking = false
  let candidate: { login: BrowserLogin; newPassword: boolean; ticket: number; time: number } | undefined
  let username: { origin: string; value: string; time: number } | undefined
  let prompt: AbortController | undefined
  const releaseInput = () => {
    if (context && !contents.isDestroyed() && contents.debugger.isAttached())
      void contents.debugger
        .sendCommand("Runtime.evaluate", {
          contextId: context,
          expression: "if (globalThis.__cmOffers) globalThis.__cmOffers.input = null",
        })
        .catch(() => undefined)
  }
  const clear = () => {
    revision++
    releaseInput()
    candidate = undefined
    username = undefined
    prompt?.abort()
  }
  const permitted = () =>
    !win.isDestroyed() &&
    !contents.isDestroyed() &&
    win.isVisible() &&
    !win.isMinimized() &&
    active() &&
    browserPreferencesState().offerSaveLogins &&
    vaultAccess.status() === "unlocked" &&
    vaultAvailable()
  const disable = () => {
    clear()
    if (context && !contents.isDestroyed() && contents.debugger.isAttached())
      void contents.debugger
        .sendCommand("Runtime.evaluate", {
          contextId: context,
          expression: "if (globalThis.__cmOffers) globalThis.__cmOffers.until = 0",
        })
        .catch(() => undefined)
  }
  const unsubscribe = vaultAccess.subscribe(() => {
    if (vaultAccess.status() !== "unlocked") disable()
  })
  const tick = async () => {
    if (!permitted()) {
      disable()
      return
    }
    if (prompt || checking || installing || !available() || contents.isLoading()) return
    checking = true
    try {
      const origin = loginOrigin(contents.getURL())
      if (loginOfferExclusions().includes(origin)) {
        disable()
        return
      }
      if (!context) {
        installing = true
        if (!contents.debugger.isAttached()) contents.debugger.attach("1.3")
        const frame = await contents.debugger.sendCommand("Page.getFrameTree")
        const created = await contents.debugger.sendCommand("Page.createIsolatedWorld", {
          frameId: frame.frameTree.frame.id,
          worldName: world,
        })
        if (!permitted()) return
        context = created.executionContextId
        await contents.debugger.sendCommand("Runtime.addBinding", { name: binding, executionContextId: context })
        await contents.debugger.sendCommand("Runtime.enable")
        await contents.debugger.sendCommand("Runtime.evaluate", {
          contextId: context,
          expression: loginOfferScript(binding),
        })
      }
      if (!permitted()) return
      await contents.debugger.sendCommand("Runtime.evaluate", {
        contextId: context,
        expression: `globalThis.__cmOffers.until = ${Date.now() + Math.min(1000, vaultAccess.remaining())}`,
      })
      const attempt = candidate
      if (!attempt) return
      if (attempt.login.origin !== origin || performance.now() - attempt.time > 60_000) {
        clear()
        return
      }
      vaultAccess.require(attempt.ticket)
      if (performance.now() - attempt.time < 1500) return
      const observedRevision = revision
      const ready = await contents.debugger.sendCommand("Runtime.evaluate", {
        contextId: context,
        expression: loginOfferSucceeded,
        returnByValue: true,
      })
      if (!ready.result.value || !permitted() || candidate !== attempt || revision !== observedRevision) return
      const accounts = readLogins().filter((row) => row.origin === origin)
      clear()
      const matches = accounts.filter((row) => row.username === attempt.login.username)
      if (attempt.login.username && matches.length > 1) return
      let existing = attempt.login.username ? matches[0] : undefined
      if (existing?.password === attempt.login.password) return
      // ponytail: a small native chooser; larger or unreadable lists require manual account editing.
      if (
        !attempt.login.username &&
        (!accounts.length ||
          accounts.length > 5 ||
          new Set(accounts.map((row) => row.username)).size !== accounts.length ||
          accounts.some(
            (row) => !row.username.trim() || row.username.length > 80 || /[\p{Cc}\p{Cf}]/u.test(row.username),
          ))
      )
        return
      const consent = new AbortController()
      prompt = consent
      const timer = setTimeout(() => prompt?.abort(), Math.min(60_000, vaultAccess.remaining()))
      busy(true)
      try {
        if (!attempt.login.username) {
          const selection = await dialog.showMessageBox(win, {
            type: "question",
            message: nativeT("desktop.browser.offer.update"),
            detail: nativeT("desktop.browser.offer.chooseAccount", {
              origin,
              accounts: accounts.map((row, index) => `${index + 1}. ${row.username}`).join("\n"),
            }),
            buttons: [nativeT("desktop.browser.offer.notNow"), ...accounts.map((_row, index) => String(index + 1))],
            defaultId: 0,
            cancelId: 0,
            signal: consent.signal,
          })
          vaultAccess.require(attempt.ticket)
          if (consent.signal.aborted || !permitted() || loginOrigin(contents.getURL()) !== origin) return
          if (!Number.isInteger(selection.response) || selection.response < 1 || selection.response > accounts.length)
            return
          existing = accounts[selection.response - 1]
          attempt.login.username = existing.username
          if (existing.password === attempt.login.password) return
        }
        const answer = await dialog.showMessageBox(win, {
          type: "question",
          message: nativeT(existing ? "desktop.browser.offer.update" : "desktop.browser.offer.save"),
          detail: nativeT(
            attempt.newPassword ? "desktop.browser.offer.passwordDetail" : "desktop.browser.offer.detail",
            {
              origin,
              username: attempt.login.username,
            },
          ),
          buttons: [
            nativeT("desktop.browser.offer.notNow"),
            nativeT(existing ? "desktop.browser.offer.updateButton" : "desktop.browser.save"),
            nativeT("desktop.browser.offer.never"),
          ],
          defaultId: 0,
          cancelId: 0,
          signal: prompt.signal,
        })
        vaultAccess.require(attempt.ticket)
        if (consent.signal.aborted || !permitted() || loginOrigin(contents.getURL()) !== origin) return
        if (answer.response === 2) {
          getStore("cm-browser").set(
            "loginOfferExclusions",
            [...new Set([...loginOfferExclusions(), origin])].slice(-200),
          )
        }
        if (answer.response !== 1) return
        const current = readLogins()
        const matches = current.filter((row) => row.origin === origin && row.username === attempt.login.username)
        const match = matches[0]
        // Compare against the pre-selection snapshot, not a refreshed credential after choosing.
        if (matches.length > 1 || match?.password !== existing?.password || match?.id !== existing?.id) return
        try {
          writeLogins([
            { id: match?.id ?? randomUUID(), ...attempt.login },
            ...current.filter((row) => row.id !== match?.id),
          ])
        } catch {
          void dialog
            .showMessageBox(win, {
              type: "error",
              message: nativeT("desktop.browser.offer.failed"),
              buttons: [nativeT("desktop.browser.cancel")],
            })
            .catch(() => undefined)
        }
      } finally {
        clearTimeout(timer)
        prompt = undefined
        busy(false)
        changed()
      }
    } catch {
      clear()
      context = undefined
    } finally {
      checking = false
      installing = false
    }
  }
  contents.debugger.on("message", (_event, method, params) => {
    if (
      method !== "Runtime.bindingCalled" ||
      params.name !== binding ||
      params.executionContextId !== context ||
      !permitted()
    )
      return
    try {
      if (prompt || typeof params.payload !== "string" || params.payload.length > 24000) {
        clear()
        return
      }
      const value = JSON.parse(params.payload)
      const origin = loginOrigin(contents.getURL())
      if (!value || value.origin !== origin || loginOfferExclusions().includes(origin)) {
        clear()
        return
      }
      revision++
      candidate = undefined
      if (!value.password) {
        if (typeof value.username !== "string" || !value.username || value.username.length > 4096) {
          clear()
          return
        }
        username = { origin, value: value.username, time: performance.now() }
        return
      }
      const login = requireLogin({
        ...value,
        // A new-password form must select its own account, never inherit an earlier login step.
        username: value.newPassword
          ? value.username
          : value.username ||
            (username?.origin === origin && performance.now() - username.time < 60_000 ? username.value : ""),
      })
      if (!login.username && value.newPassword !== true) {
        clear()
        return
      }
      candidate = {
        login,
        newPassword: value.newPassword === true,
        ticket: vaultAccess.require(),
        time: performance.now(),
      }
    } catch {
      clear()
    }
  })
  contents.on("did-start-navigation", (_event, url, _inPlace, main) => {
    if (!main) return
    revision++
    releaseInput()
    context = undefined
    prompt?.abort()
    if (!URL.canParse(url) || new URL(url).origin !== candidate?.login.origin) candidate = undefined
    if (!URL.canParse(url) || new URL(url).origin !== username?.origin) username = undefined
  })
  contents.on("did-navigate", (_event, _url, status) => {
    if (status >= 400) clear()
  })
  contents.on("did-fail-load", () => clear())
  contents.debugger.on("detach", () => {
    context = undefined
    clear()
  })
  const timer = setInterval(() => void tick(), 400)
  contents.once("destroyed", () => {
    clearInterval(timer)
    unsubscribe()
    clear()
  })
  return disable
}
