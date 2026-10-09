import { afterAll, afterEach, expect, mock, test } from "bun:test"
import { EventEmitter } from "node:events"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { nativeT } from "../native-translations"

// Bun module mocks persist across files; isolate this Electron boundary.
if (process.env.CM_GENERATION_FEEDBACK_TEST !== "1") {
  test("generation recovery feedback through browserCommand", () => {
    const result = Bun.spawnSync([process.execPath, "test", import.meta.path], {
      cwd: join(import.meta.dir, "../../.."),
      env: { ...process.env, CM_GENERATION_FEEDBACK_TEST: "1" },
      stdout: "pipe",
      stderr: "pipe",
      timeout: 20_000,
    })
    expect(result.exitCode, Buffer.concat([result.stdout, result.stderr]).toString()).toBe(0)
  }, 25_000)
} else {
  const directory = mkdtempSync(join(tmpdir(), "cm-generation-feedback-"))
  const app = {
    getPath: () => directory,
    getAppPath: () => directory,
    getVersion: () => "test",
    getName: () => "test",
    commandLine: { hasSwitch: () => false },
    on: () => {},
  }
  const electron = {
    app,
    dialog: {
      showMessageBox: async (_win: unknown, _options: Electron.MessageBoxOptions) => ({
        response: 0,
        checkboxChecked: false,
      }),
    },
    BrowserWindow: () => {
      throw new Error("Unexpected window creation")
    },
    session: {},
    shell: {},
    powerMonitor: { on: () => {} },
    systemPreferences: {},
    safeStorage: { isEncryptionAvailable: () => true, getSelectedStorageBackend: () => "keychain" },
    Notification: { isSupported: () => false },
    WebContentsView: () => {
      throw new Error("Unexpected view creation")
    },
  }
  mock.module("electron", () => ({ ...electron, default: electron }))
  mock.module("electron-context-menu", () => ({ default: () => {} }))
  const { browserCommand } = await import("./tabs")
  const { getStore } = await import("../store")
  const { vaultAccess } = await import("./vault-session")
  const { vaultAuthentication } = await import("./vault-auth")
  const dialog = electron.dialog
  const store = getStore("cm-browser")
  const showMessageBox = dialog.showMessageBox
  const verify = vaultAuthentication.verify.bind(vaultAuthentication)
  vaultAuthentication.verify = async () => {}
  afterEach(() => {
    vaultAccess.lock()
    dialog.showMessageBox = showMessageBox
    store.clear()
  })
  afterAll(() => {
    vaultAuthentication.verify = verify
    rmSync(directory, { recursive: true, force: true })
  })

  async function fixture(
    constraints: unknown = { min: 24, max: 24, hasUsername: true },
    answer: (options: Electron.MessageBoxOptions) => number | Promise<number> = () => 0,
  ) {
    const calls: string[] = []
    const dialogs: Electron.MessageBoxOptions[] = []
    const contents = Object.assign(new EventEmitter(), {
      isDestroyed: () => false,
      isLoadingMainFrame: () => false,
      isLoading: () => false,
      getURL: () => "https://example.test/register",
      getTitle: () => "Register",
      getZoomFactor: () => 1,
      navigationHistory: { canGoBack: () => false, canGoForward: () => false },
      executeJavaScriptInIsolatedWorld: async (_world: number, scripts: { code: string }[]) => {
        calls.push(scripts[0].code)
        if (scripts[0].code.includes("return { min, max, hasUsername:")) {
          if (constraints instanceof Error) throw constraints
          return constraints
        }
        return true
      },
    })
    const view = {
      webContents: contents,
      visible: true,
      setBounds: () => {},
      setVisible: (visible: boolean) => {
        view.visible = visible
      },
    }
    const children = [view]
    const win = {
      isDestroyed: () => false,
      isVisible: () => true,
      isMinimized: () => false,
      getContentBounds: () => ({ width: 800, height: 600 }),
      webContents: { isDestroyed: () => false, getZoomFactor: () => 1, send: () => {} },
      contentView: {
        children,
        removeChildView: () => children.splice(0),
        addChildView: () => children.push(view),
      },
    }
    const tab = {
      id: "tab",
      ownerID: 1,
      sessionID: "session",
      contents,
      view,
      saved: { url: contents.getURL(), title: "Register" },
      loadFailed: false,
      agentAccess: false,
      revision: 1,
      loginBusy: false,
      readyLoginOffers: async () => Date.now() + 5000,
    }
    // Only the Electron members used by this orchestration are implemented by the fixture.
    // oxlint-disable-next-line typescript-eslint/no-unsafe-type-assertion
    const owner = {
      authorityID: "owner",
      win,
      groups: new Map([["session", { sessionID: "session", tabs: [tab], activeID: "tab", closed: [] }]]),
      viewport: { sessionID: "session", lease: "lease", bounds: { x: 0, y: 0, width: 800, height: 600 } },
      attached: tab,
      suspended: 0,
      screenshotEpoch: 0,
      taskEpoch: 0,
    } as unknown as Parameters<typeof browserCommand>[0]
    dialog.showMessageBox = async (_win, options) => {
      dialogs.push(options)
      expect(owner.suspended).toBe(1)
      expect(owner.attached).toBeUndefined()
      expect(view.visible).toBe(false)
      if (options.type === "warning") {
        expect(tab.loginBusy).toBe(false)
        expect(owner.generationCheck).toBeUndefined()
        expect(options.buttons).toEqual([nativeT("desktop.browser.cancel")])
        expect(options.defaultId).toBe(0)
        expect(options.cancelId).toBe(0)
      }
      return { response: await answer(options), checkboxChecked: false }
    }
    await vaultAccess.unlock(owner.win)
    return {
      owner,
      tab,
      contents,
      calls,
      dialogs,
      run: (settings: Record<string, unknown> = {}) =>
        browserCommand(owner, "session", { op: "generate-password", tabID: "tab", ...settings }),
    }
  }

  test("default length outside an exact site range gives guidance, not a generic IPC failure", async () => {
    const f = await fixture()
    await f.run()
    expect(f.dialogs).toHaveLength(1)
    expect(f.dialogs[0].detail).toContain("selected length is 20")
    expect(f.dialogs[0].detail).toContain("24-24")
    expect(f.dialogs[0].detail).toContain("settings were not changed")
    expect(f.calls.some((code) => code.includes("const password = "))).toBe(false)
    expect(f.calls.at(-1)).toContain("delete document.__cmLoginTicket")
    expect(f.owner.suspended).toBe(0)
    expect(f.owner.generationCheck).toBeUndefined()
    expect(f.tab.loginBusy).toBe(false)
  })

  test.each(["disabled", "excluded"])("save offers %s give the existing recovery copy", async (reason) => {
    const f = await fixture()
    if (reason === "disabled") store.set("preferences", { offerSaveLogins: false })
    if (reason === "excluded") store.set("loginOfferExclusions", ["https://example.test"])
    const before = store.store
    await f.run()
    expect(f.dialogs[0].detail).toBe(nativeT("desktop.browser.generation.offers"))
    expect(f.calls).toHaveLength(0)
    expect(store.store).toEqual(before)
  })

  test("invalid settings use native guidance without reflecting the command", async () => {
    const f = await fixture()
    await f.run({ length: "private-secret", symbols: "page-text" })
    expect(f.dialogs[0].detail).toBe(nativeT("desktop.browser.generation.settings"))
    expect(f.calls).toHaveLength(0)
    expect(JSON.stringify(f.dialogs)).not.toContain("private-secret")
  })

  test("page exceptions use fixed recovery guidance and never reach IPC or dialogs", async () => {
    const f = await fixture(new Error("page-text private-secret"))
    const result = await f.run()
    expect(f.dialogs[0].detail).toBe(nativeT("desktop.browser.generation.failed"))
    expect(JSON.stringify([result, f.dialogs])).not.toContain("private-secret")
    expect(f.owner.suspended).toBe(0)
    expect(f.tab.loginBusy).toBe(false)
  })

  test.each([
    { min: "private-secret", max: 64 },
    { min: 16, max: Infinity },
    { min: 16.5, max: 64 },
    { min: 15, max: 64 },
    { min: 16, max: 65 },
    { min: 25, max: 24 },
    { min: NaN, max: 64 },
  ])("invalid bounds %j never become length feedback", async (bounds) => {
    const f = await fixture({ ...bounds, hasUsername: true })
    await f.run()
    expect(f.dialogs).toHaveLength(1)
    expect(f.dialogs[0].detail).toBe(nativeT("desktop.browser.generation.failed"))
    expect(f.calls.some((code) => code.includes("const password = "))).toBe(false)
  })

  test("above-range length is rejected without silently shortening it", async () => {
    const f = await fixture({ min: 16, max: 18, hasUsername: true })
    await f.run({ length: 32 })
    expect(f.dialogs[0].detail).toBe(nativeT("desktop.browser.generation.length", { length: 32, min: 16, max: 18 }))
    expect(f.calls.some((code) => code.includes("const password = "))).toBe(false)
  })

  test("cancelling a valid generation does not show failure feedback", async () => {
    const f = await fixture()
    await f.run({ length: 24 })
    expect(f.dialogs).toHaveLength(1)
    expect(f.dialogs[0].type).toBe("question")
    expect(f.calls.some((code) => code.includes("const password = "))).toBe(false)
    expect(f.calls.at(-1)).toContain("delete document.__cmLoginTicket")
    expect(f.contents.listenerCount("did-start-navigation")).toBe(0)
    expect(f.owner.suspended).toBe(0)
    expect(f.owner.attached?.id).toBe(f.tab.id)
    expect(f.owner.generationCheck).toBeUndefined()
    expect(f.tab.loginBusy).toBe(false)
    expect(f.tab.revision).toBe(2)
  })

  test("confirmed generation arms save offers before delivery and returns the updated tab without its secret", async () => {
    const f = await fixture(undefined, () => 1)
    const events: string[] = []
    const execute = f.contents.executeJavaScriptInIsolatedWorld
    f.tab.readyLoginOffers = async () => {
      expect(f.owner.suspended).toBe(0)
      expect(f.owner.attached?.id).toBe(f.tab.id)
      events.push("offers")
      return Date.now() + 5000
    }
    f.contents.executeJavaScriptInIsolatedWorld = async (world, scripts) => {
      if (scripts[0].code.includes("const password = ")) events.push("delivery")
      return execute(world, scripts)
    }
    const result = await f.run({ length: 24, symbols: false })
    expect(events).toEqual(["offers", "delivery"])
    expect(f.dialogs.map((options) => options.type)).toEqual(["question"])
    const deliveries = f.calls.filter((code) => code.includes("const password = "))
    expect(deliveries).toHaveLength(1)
    const password = JSON.parse(deliveries[0].match(/const password = (".*")/u)![1])
    expect(password).toMatch(/^[A-Za-z0-9]{24}$/u)
    expect(JSON.stringify([result, f.dialogs])).not.toContain(password)
    expect(result.activeID).toBe(f.tab.id)
    expect(result.tabs[0].revision).toBe(2)
    expect(f.calls.at(-1)).toContain("delete document.__cmLoginTicket")
    expect(f.contents.listenerCount("did-start-navigation")).toBe(0)
    expect(f.owner.suspended).toBe(0)
    expect(f.owner.generationCheck).toBeUndefined()
    expect(f.tab.loginBusy).toBe(false)
  })

  test("navigation while inspecting the form prevents consent and delivery", async () => {
    const f = await fixture()
    const execute = f.contents.executeJavaScriptInIsolatedWorld
    f.contents.executeJavaScriptInIsolatedWorld = async (world, scripts) => {
      const result = await execute(world, scripts)
      if (scripts[0].code.includes("return { min, max, hasUsername:")) {
        f.tab.revision++
        f.contents.emit("did-start-navigation")
      }
      return result
    }
    await f.run({ length: 24 })
    expect(f.dialogs.map((options) => options.type)).toEqual(["warning"])
    expect(f.calls.some((code) => code.includes("const password = "))).toBe(false)
    expect(f.contents.listenerCount("did-start-navigation")).toBe(0)
    expect(f.owner.generationCheck).toBeUndefined()
    expect(f.tab.loginBusy).toBe(false)
  })

  test.each(["navigation", "access", "lease", "group", "offers", "exclusion"])(
    "%s changes during native consent prevent secret delivery and restore the panel",
    async (change) => {
      const f = await fixture(undefined, (options) => {
        if (options.type !== "question") return 0
        if (change === "navigation") f.contents.emit("did-start-navigation")
        if (change === "access") f.tab.agentAccess = true
        if (change === "lease") f.owner.viewport = { ...f.owner.viewport!, lease: "replacement" }
        if (change === "group") {
          const group = f.owner.groups.get("session")!
          f.owner.groups.set("session", { ...group })
        }
        if (change === "offers") store.set("preferences", { offerSaveLogins: false })
        if (change === "exclusion") store.set("loginOfferExclusions", ["https://example.test"])
        return 1
      })
      await f.run({ length: 24 })
      expect(f.dialogs.map((options) => options.type)).toEqual(["question", "warning"])
      expect(f.calls.some((code) => code.includes("const password = "))).toBe(false)
      expect(f.calls.at(-1)).toContain("delete document.__cmLoginTicket")
      expect(f.contents.listenerCount("did-start-navigation")).toBe(0)
      expect(f.owner.suspended).toBe(0)
      expect(f.owner.generationCheck).toBeUndefined()
      expect(f.tab.loginBusy).toBe(false)
    },
  )

  test("revocation while waiting for save offers blocks a late delivery", async () => {
    const f = await fixture(undefined, () => 1)
    const capture = Promise.withResolvers<number>()
    const started = Promise.withResolvers<void>()
    f.tab.readyLoginOffers = async () => {
      started.resolve()
      return capture.promise
    }
    const pending = f.run({ length: 24 })
    await started.promise
    expect(f.tab.loginBusy).toBe(true)
    vaultAccess.lock()
    capture.resolve(Date.now() + 5000)
    await pending
    expect(f.dialogs.map((options) => options.type)).toEqual(["question", "warning"])
    expect(f.calls.some((code) => code.includes("const password = "))).toBe(false)
    expect(f.contents.listenerCount("did-start-navigation")).toBe(0)
    expect(f.owner.generationCheck).toBeUndefined()
    expect(f.owner.suspended).toBe(0)
    expect(f.tab.loginBusy).toBe(false)
  })

  test("vault revocation during consent shows recovery only after cleanup", async () => {
    const f = await fixture(undefined, (options) => {
      if (options.type === "question") vaultAccess.lock()
      return 1
    })
    await f.run({ length: 24 })
    expect(f.dialogs.map((options) => options.type)).toEqual(["question", "warning"])
    expect(f.dialogs[1].detail).toBe(nativeT("desktop.browser.generation.failed"))
    expect(f.calls.some((code) => code.includes("const password = "))).toBe(false)
    expect(f.contents.listenerCount("did-start-navigation")).toBe(0)
    expect(f.owner.suspended).toBe(0)
  })

  test("delivery exceptions cannot reflect a generated password through feedback or IPC", async () => {
    const f = await fixture(undefined, () => 1)
    const execute = f.contents.executeJavaScriptInIsolatedWorld
    const passwords: string[] = []
    f.contents.executeJavaScriptInIsolatedWorld = async (world, scripts) => {
      if (scripts[0].code.includes("const password = ")) {
        passwords.push(JSON.parse(scripts[0].code.match(/const password = (".*")/u)![1]))
        throw new Error(scripts[0].code)
      }
      return execute(world, scripts)
    }
    const result = await f.run({ length: 24 })
    expect(passwords).toHaveLength(1)
    expect(f.dialogs.map((options) => options.type)).toEqual(["question", "warning"])
    expect(f.dialogs[1].detail).toBe(nativeT("desktop.browser.generation.failed"))
    expect(JSON.stringify([result, f.dialogs])).not.toContain(passwords[0])
    expect(JSON.stringify([result, f.dialogs])).not.toContain("const password = ")
    expect(f.owner.suspended).toBe(0)
    expect(f.tab.loginBusy).toBe(false)
  })

  test("native dialog failure rejects with fixed copy and restores suspension", async () => {
    const f = await fixture(undefined, () => {
      throw new Error("private-secret native details")
    })
    await expect(f.run()).rejects.toEqual(new Error(nativeT("desktop.browser.generation.failed")))
    expect(f.owner.suspended).toBe(0)
    expect(f.owner.attached?.id).toBe(f.tab.id)
  })

  test("an existing operation is not interrupted by another recovery dialog", async () => {
    const f = await fixture()
    f.tab.loginBusy = true
    await expect(f.run()).rejects.toEqual(new Error(nativeT("desktop.browser.generation.failed")))
    expect(f.dialogs).toHaveLength(0)
    expect(f.calls).toHaveLength(0)
    expect(f.tab.loginBusy).toBe(true)
  })
}
