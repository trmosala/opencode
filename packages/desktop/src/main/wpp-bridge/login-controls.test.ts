import { afterEach, beforeEach, expect, mock, spyOn, test } from "bun:test"
import { EventEmitter } from "node:events"
import { join } from "node:path"
import { app, BrowserWindow, dialog } from "electron"
import { createVaultAccess } from "../browser/vault-access"
import { WPP_OKTA_ORIGIN } from "./okta-login-form"
import { nativeT } from "../native-translations"

// Isolate mocks of native dialogs/OS verification/storage from the desktop suite.
// Field safety is exercised separately in a real Electron isolated-world fixture.
if (process.env.CM_WPP_LOGIN_TEST_CHILD !== "1") {
  test("WPP login controls enforce native consent and lifecycle cancellation", () => {
    const result = Bun.spawnSync([process.execPath, "test", import.meta.path], {
      cwd: join(import.meta.dir, "../../.."),
      env: { ...process.env, CM_WPP_LOGIN_TEST_CHILD: "1" },
      timeout: 15_000,
      stdout: "pipe",
      stderr: "pipe",
    })
    expect(result.exitCode, Buffer.concat([result.stdout, result.stderr]).toString()).toBe(0)
  }, 20_000)
} else {
  const account = {
    id: "00000000-0000-0000-0000-000000000001",
    origin: WPP_OKTA_ORIGIN,
    username: "fixture@wpp.test",
    password: "fixture-secret",
  }
  let rows = [account]
  const verify = mock(async () => {})
  const access = createVaultAccess(verify)
  const entry = mock(async () => ({ origin: account.origin, username: account.username, password: account.password }))
  const write = mock((next: typeof rows) => {
    rows = structuredClone(next)
  })
  mock.module("../browser/vault-session", () => ({
    vaultAccess: access,
    vaultAvailable: () => true,
    initializeVaultLocking: () => {},
  }))
  mock.module("../browser/vault", () => ({
    readLogins: () => structuredClone(rows),
    writeLogins: write,
    vaultAvailable: () => true,
  }))
  mock.module("../browser/login-entry", () => ({ loginEntry: { prompt: entry }, loginEntryAvailable: () => true }))
  const { attachWppLoginControls, subscribeWppLoginMenu, wppLoginMenu } = await import("./login-controls")

  beforeEach(() => {
    rows = [structuredClone(account)]
    access.lock()
    verify.mockClear()
    entry.mockClear().mockImplementation(async () => ({
      origin: account.origin,
      username: account.username,
      password: account.password,
    }))
    write.mockClear()
  })
  afterEach(() => {
    access.lock()
    mock.restore()
  })

  function window() {
    const win = new BrowserWindow()
    const events = new EventEmitter()
    const contents = new EventEmitter()
    const execute = mock(async (_world: number, scripts: { code: string }[]) =>
      scripts[0].code.includes("return field") ? "password" : true,
    )
    Object.defineProperties(win.webContents, {
      getURL: { configurable: true, value: () => `${WPP_OKTA_ORIGIN}/oauth2/v1/authorize` },
      executeJavaScriptInIsolatedWorld: { configurable: true, value: execute },
      on: { configurable: true, value: contents.on.bind(contents) },
      once: { configurable: true, value: contents.once.bind(contents) },
    })
    Object.defineProperties(win, {
      isVisible: { configurable: true, value: () => true },
      isMinimized: { configurable: true, value: () => false },
      on: { configurable: true, value: events.on.bind(events) },
      once: { configurable: true, value: events.once.bind(events) },
    })
    attachWppLoginControls(win)
    return { win, events, contents, execute }
  }
  async function click(win: BrowserWindow, index = 0) {
    await wppLoginMenu(win.webContents)[index].click?.(undefined!, win, undefined!)
  }

  test("native menu observers update on focus, navigation and locking, and unsubscribe on menu rebuild", async () => {
    const listen = spyOn(app, "on")
    const remove = spyOn(app, "removeListener")
    const update = mock(() => {})
    const stop = subscribeWppLoginMenu(update)
    const current = window()
    const before = update.mock.calls.length
    current.contents.emit("did-navigate")
    expect(update.mock.calls.length).toBe(before + 1)
    await access.unlock(current.win)
    expect(update.mock.calls.length).toBeGreaterThan(before + 1)
    expect(listen).toHaveBeenCalledWith("browser-window-focus", update)
    expect(listen).toHaveBeenCalledWith("browser-window-blur", update)
    stop()
    const stopped = update.mock.calls.length
    current.contents.emit("did-navigate")
    access.lock()
    expect(update.mock.calls.length).toBe(stopped)
    expect(remove).toHaveBeenCalledWith("browser-window-focus", update)
    expect(remove).toHaveBeenCalledWith("browser-window-blur", update)
  })

  test("workers and unrelated origins have no usable credential controls", async () => {
    expect(wppLoginMenu(new BrowserWindow().webContents)).toEqual([])
    const current = window()
    Object.defineProperty(current.win.webContents, "getURL", { value: () => "https://wpp.okta.com.other.test" })
    expect(wppLoginMenu(current.win.webContents)[0].enabled).toBe(false)
    await click(current.win)
    expect(verify).not.toHaveBeenCalled()
    expect(current.execute).not.toHaveBeenCalled()
    expect(write).not.toHaveBeenCalled()
  })
  test("fills only after vault unlock, account choice and field-specific consent", async () => {
    const current = window()
    const show = spyOn(dialog, "showMessageBox").mockResolvedValue({ response: 1, checkboxChecked: false })
    await click(current.win)
    expect(verify).toHaveBeenCalledTimes(1)
    expect(show).toHaveBeenCalledTimes(2)
    expect(show.mock.calls[0][1]?.buttons).toEqual([nativeT("desktop.browser.cancel"), account.username])
    expect(show.mock.calls[1][1]?.message).toBe(nativeT("desktop.browser.fillPassword"))
    expect(current.execute).toHaveBeenCalledTimes(3)
    expect(current.execute.mock.calls[1][1][0].code).toContain(account.password)
    expect(write).not.toHaveBeenCalled()
  })
  test("cancelling fill consent only prepares and cleans up fields", async () => {
    const current = window()
    spyOn(dialog, "showMessageBox")
      .mockResolvedValueOnce({ response: 1, checkboxChecked: false })
      .mockResolvedValueOnce({ response: 0, checkboxChecked: false })
    await click(current.win)
    expect(current.execute).toHaveBeenCalledTimes(2)
    expect(
      current.execute.mock.calls.flatMap((call) => call[1]).some((script) => script.code.includes(account.password)),
    ).toBe(false)
  })
  test.each(["navigation", "hide", "minimize", "lock", "close"])(
    "%s during fill confirmation prevents secret delivery",
    async (change) => {
      const current = window()
      const pending = Promise.withResolvers<{ response: number; checkboxChecked: boolean }>()
      const started = Promise.withResolvers<void>()
      spyOn(dialog, "showMessageBox")
        .mockResolvedValueOnce({ response: 1, checkboxChecked: false })
        .mockImplementationOnce(async () => {
          started.resolve()
          return pending.promise
        })
      const filling = click(current.win)
      await started.promise
      if (change === "navigation") current.contents.emit("did-start-navigation", {}, "https://other.test", false, true)
      if (change === "hide" || change === "minimize") current.events.emit(change)
      if (change === "close") current.events.emit("closed")
      if (change === "lock") access.lock()
      pending.resolve({ response: 1, checkboxChecked: false })
      await filling
      expect(
        current.execute.mock.calls.flatMap((call) => call[1]).some((script) => script.code.includes(account.password)),
      ).toBe(false)
      expect(write).not.toHaveBeenCalled()
    },
  )
  test("account edits during consent prevent delivery", async () => {
    const current = window()
    const show = spyOn(dialog, "showMessageBox")
      .mockResolvedValueOnce({ response: 1, checkboxChecked: false })
      .mockImplementationOnce(async () => {
        rows[0].password = "new-secret"
        return { response: 1, checkboxChecked: false }
      })
      .mockResolvedValue({ response: 0, checkboxChecked: false })
    await click(current.win)
    expect(current.execute).toHaveBeenCalledTimes(2)
    expect(show.mock.calls.at(-1)?.[1]?.message).toBe(nativeT("desktop.wpp.login.failed"))
    expect(show.mock.calls.at(-1)?.[1]?.message).not.toContain("secret")
  })
  test("native account entry requires explicit save consent", async () => {
    const current = window()
    rows = []
    spyOn(dialog, "showMessageBox").mockResolvedValue({ response: 1, checkboxChecked: false })
    await click(current.win, 1)
    expect(entry).toHaveBeenCalledTimes(1)
    expect(rows).toHaveLength(1)
    expect(rows[0].password).toBe(account.password)
    expect(current.execute).not.toHaveBeenCalled()
  })
  test("cancelling native save confirmation leaves the vault untouched", async () => {
    const current = window()
    spyOn(dialog, "showMessageBox").mockResolvedValue({ response: 0, checkboxChecked: false })
    await click(current.win, 1)
    expect(write).not.toHaveBeenCalled()
  })
  test("navigation during native entry cancels its signal and prevents saving", async () => {
    const current = window()
    const pending = Promise.withResolvers<{ origin: string; username: string; password: string }>()
    const started = Promise.withResolvers<void>()
    entry.mockImplementation(async () => {
      started.resolve()
      return pending.promise
    })
    const saving = click(current.win, 1)
    await started.promise
    current.contents.emit("did-start-navigation", {}, "https://other.test", false, true)
    pending.resolve(account)
    await saving
    expect(write).not.toHaveBeenCalled()
  })
  test("forget removes only the chosen WPP account", async () => {
    const current = window()
    rows.push({ ...account, id: "00000000-0000-0000-0000-000000000002", origin: "https://other.test" })
    spyOn(dialog, "showMessageBox")
      .mockResolvedValueOnce({ response: 1, checkboxChecked: false })
      .mockResolvedValueOnce({ response: 2, checkboxChecked: false })
    await click(current.win, 2)
    expect(rows).toHaveLength(1)
    expect(rows[0].origin).toBe("https://other.test")
  })
  test("updating a saved WPP account retains its ID", async () => {
    const current = window()
    entry.mockImplementation(async () => ({
      origin: account.origin,
      username: account.username,
      password: "replacement-secret",
    }))
    spyOn(dialog, "showMessageBox").mockResolvedValue({ response: 1, checkboxChecked: false })
    await click(current.win, 2)
    expect(rows).toEqual([{ ...account, password: "replacement-secret" }])
  })
}
