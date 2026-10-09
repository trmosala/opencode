import { afterAll, afterEach, expect, mock, test } from "bun:test"
import { EventEmitter } from "node:events"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { nativeT } from "../native-translations"

// Electron mocks are process-global in Bun. Keep this command boundary isolated from other suites.
if (process.env.CM_LOGIN_COMMAND_TEST !== "1") {
  test("save and fill login behavior through browserCommand", () => {
    const result = Bun.spawnSync([process.execPath, "test", import.meta.path], {
      cwd: join(import.meta.dir, "../../.."),
      env: { ...process.env, CM_LOGIN_COMMAND_TEST: "1" },
      stdout: "pipe",
      stderr: "pipe",
      timeout: 20_000,
    })
    expect(result.exitCode, Buffer.concat([result.stdout, result.stderr]).toString()).toBe(0)
  }, 25_000)
} else {
  const directory = mkdtempSync(join(tmpdir(), "cm-login-command-"))
  const electron = {
    app: {
      getPath: () => directory,
      getAppPath: () => directory,
      getVersion: () => "test",
      getName: () => "test",
      commandLine: { hasSwitch: () => false },
      on: () => {},
    },
    dialog: {
      showMessageBox: async (_win: unknown, _options: Electron.MessageBoxOptions) => ({
        response: 0,
        checkboxChecked: false,
      }),
    },
    BrowserWindow: () => {
      throw new Error("Unexpected window creation")
    },
    WebContentsView: () => {
      throw new Error("Unexpected view creation")
    },
    session: {},
    shell: {},
    powerMonitor: { on: () => {} },
    systemPreferences: {},
    safeStorage: {
      isEncryptionAvailable: () => true,
      getSelectedStorageBackend: () => "keychain",
      encryptString: (value: string) => Buffer.from(value),
      decryptString: (value: Buffer) => value.toString(),
    },
    Notification: { isSupported: () => false },
  }
  mock.module("electron", () => ({ ...electron, default: electron }))
  mock.module("electron-context-menu", () => ({ default: () => {} }))
  const { browserCommand } = await import("./tabs")
  const { getStore } = await import("../store")
  const { saveLogins } = await import("./profile")
  const { vaultAccess } = await import("./vault-session")
  const { vaultAuthentication } = await import("./vault-auth")
  const store = getStore("cm-browser")
  const showMessageBox = electron.dialog.showMessageBox
  const verify = vaultAuthentication.verify.bind(vaultAuthentication)
  // This is the OS authentication boundary; the vault and its ticket checks remain real.
  vaultAuthentication.verify = async () => {}
  const origin = "https://example.test"
  const saved = { origin, username: "saved@example.test", password: "fixture-saved-secret" }
  const entered = { origin, username: "new@example.test", password: "fixture-entered-secret" }
  afterEach(() => {
    vaultAccess.lock()
    electron.dialog.showMessageBox = showMessageBox
    store.clear()
  })
  afterAll(() => {
    vaultAuthentication.verify = verify
    rmSync(directory, { recursive: true, force: true })
  })

  async function fixture(answer: (options: Electron.MessageBoxOptions) => number | Promise<number> = () => 1) {
    const calls: string[] = []
    const deliveries: { username?: string; password?: string }[] = []
    const dialogs: Electron.MessageBoxOptions[] = []
    const messages: unknown[] = []
    const contents = Object.assign(new EventEmitter(), {
      isDestroyed: () => false,
      isLoadingMainFrame: () => false,
      isLoading: () => false,
      getURL: () => `${origin}/login`,
      getTitle: () => "Login",
      getZoomFactor: () => 1,
      navigationHistory: { canGoBack: () => false, canGoForward: () => false },
      executeJavaScriptInIsolatedWorld: async (_world: number, scripts: { code: string }[]) => {
        calls.push(scripts[0].code)
        // Observe the isolated-world delivery at the Chromium boundary, without mocking pageLogin.
        const fill = scripts[0].code.match(/const fill = (.+)/u)
        if (!fill) return true
        const value = JSON.parse(fill[1])
        if (value === null) return entered
        deliveries.push(value)
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
      webContents: {
        isDestroyed: () => false,
        getZoomFactor: () => 1,
        send: (topic: string, value: unknown) => messages.push({ topic, value }),
      },
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
      saved: { url: contents.getURL(), title: "Login" },
      loadFailed: false,
      agentAccess: false,
      revision: 1,
      loginBusy: false,
    }
    // The fixture implements only the native members this public command needs.
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
    electron.dialog.showMessageBox = async (_win, options) => {
      dialogs.push(options)
      expect(owner.suspended).toBe(1)
      expect(owner.attached).toBeUndefined()
      expect(view.visible).toBe(false)
      expect(options.defaultId).toBe(0)
      expect(options.cancelId).toBe(0)
      return { response: await answer(options), checkboxChecked: false }
    }
    await vaultAccess.unlock(owner.win)
    saveLogins([saved])
    const initial = await browserCommand(owner, "session", { op: "state" })
    const id = initial.profile!.credentials.find((row) => row.username === saved.username)!.id
    messages.splice(0)
    return {
      owner,
      tab,
      win,
      view,
      contents,
      calls,
      deliveries,
      dialogs,
      messages,
      id,
      state: () => browserCommand(owner, "session", { op: "state" }),
      run: (op: "save-login" | "fill-login", values: Record<string, unknown> = {}) =>
        browserCommand(owner, "session", { op, tabID: tab.id, ...(op === "fill-login" ? { id } : {}), ...values }),
    }
  }

  function expectReleased(f: Awaited<ReturnType<typeof fixture>>, revision = 2) {
    expect(f.owner.suspended).toBe(0)
    expect(f.owner.loginCheck).toBeUndefined()
    expect(f.tab.loginBusy).toBe(false)
    expect(f.tab.revision).toBe(revision)
    expect(f.owner.attached?.id).toBe(f.tab.id)
    expect(f.view.visible).toBe(true)
    if (f.calls.length) expect(f.calls.at(-1)).toContain("delete document.__cmLoginTicket")
  }

  test("confirmed save publishes account metadata and the saved account can subsequently fill the page", async () => {
    const f = await fixture()
    const result = await f.run("save-login")
    const account = result.profile!.credentials.find((row) => row.username === entered.username)!
    expect(account).toEqual({ id: expect.any(String), origin, username: entered.username })
    expect(f.dialogs[0].message).toBe(nativeT("desktop.browser.saveLogin"))
    expect(f.deliveries).toHaveLength(0)
    expect(JSON.stringify([result, f.dialogs, f.messages])).not.toContain(entered.password)
    expectReleased(f)
    await f.run("fill-login", { id: account.id, revision: 2 })
    expect(f.deliveries).toEqual([{ username: entered.username, password: entered.password }])
    expectReleased(f, 3)
  })

  const fills = [
    {
      field: undefined,
      label: "both fields",
      values: { username: saved.username, password: saved.password },
      message: "desktop.browser.fillLogin",
    },
    {
      field: "username",
      label: "username",
      values: { username: saved.username },
      message: "desktop.browser.fillUsername",
    },
    {
      field: "password",
      label: "password",
      values: { password: saved.password },
      message: "desktop.browser.fillPassword",
    },
  ] as const
  fills.forEach((fill) => {
    test(`confirmed ${fill.label} fill delivers only the selected values`, async () => {
      const f = await fixture()
      const result = await f.run("fill-login", { field: fill.field, revision: 1 })
      expect(f.deliveries).toEqual([fill.values])
      expect(f.dialogs[0].message).toBe(nativeT(fill.message))
      expect(JSON.stringify([result, f.dialogs, f.messages])).not.toContain(saved.password)
      expectReleased(f)
    })
  })

  test.each(["save-login", "fill-login"] as const)(
    "cancelling %s leaves the saved accounts unchanged and delivers no credentials",
    async (op) => {
      const f = await fixture(() => 0)
      const result = await f.run(op)
      expect(result.profile!.credentials).toEqual([{ id: f.id, origin, username: saved.username }])
      expect(f.deliveries).toHaveLength(0)
      expect(f.dialogs).toHaveLength(1)
      expectReleased(f)
    },
  )

  const authorityChanges = [
    "task",
    "task-return",
    "navigation",
    "lease",
    "group",
    "access",
    "vault",
    "vault-reunlock",
  ] as const
  const operations = ["save-login", "fill-login"] as const
  operations.forEach((op) => {
    test.each(authorityChanges)(`${op} rejects %s changes during consent before saving or filling`, async (change) => {
      const f = await fixture(async () => {
        if (change === "task") f.owner.taskEpoch++
        if (change === "task-return") {
          f.owner.taskEpoch++
          f.owner.loginCheck?.()
          f.owner.taskEpoch--
        }
        if (change === "navigation") {
          f.tab.revision++
          f.contents.getURL = () => `${origin}/other-page`
        }
        if (change === "lease") f.owner.viewport = { ...f.owner.viewport!, lease: "replacement" }
        if (change === "group") f.owner.groups.set("session", { ...f.owner.groups.get("session")! })
        if (change === "access") f.tab.agentAccess = true
        if (change === "vault" || change === "vault-reunlock") vaultAccess.lock()
        if (change === "vault-reunlock") await vaultAccess.unlock(f.owner.win)
        return 1
      })
      await expect(f.run(op)).rejects.toThrow()
      expect(f.deliveries).toHaveLength(0)
      expect(f.dialogs).toHaveLength(1)
      expectReleased(f, change === "navigation" ? 3 : 2)
      await vaultAccess.unlock(f.owner.win)
      const state = await f.state()
      expect(state.profile!.credentials).toEqual([{ id: f.id, origin, username: saved.username }])
      expect(JSON.stringify([state, f.dialogs, f.messages])).not.toContain(saved.password)
      expect(JSON.stringify([state, f.dialogs, f.messages])).not.toContain(entered.password)
    })

    test(`${op} rejects a task switch while the native form inspection is still pending`, async () => {
      const f = await fixture()
      const started = Promise.withResolvers<void>()
      const inspected = Promise.withResolvers<void>()
      const execute = f.contents.executeJavaScriptInIsolatedWorld
      f.contents.executeJavaScriptInIsolatedWorld = async (world, scripts) => {
        const result = await execute(world, scripts)
        if (scripts[0].code.includes("document.__cmLoginTicket = ticket")) {
          started.resolve()
          await inspected.promise
        }
        return result
      }
      const pending = f.run(op)
      await started.promise
      expect(f.tab.loginBusy).toBe(true)
      f.owner.taskEpoch++
      inspected.resolve()
      await expect(pending).rejects.toEqual(new Error("Login operation failed"))
      expect(f.dialogs).toHaveLength(0)
      expect(f.deliveries).toHaveLength(0)
      expectReleased(f)
      expect((await f.state()).profile!.credentials).toEqual([{ id: f.id, origin, username: saved.username }])
    })

    test.each(["prepare", "complete"])(
      `${op} hides native page exceptions during %s and releases the operation`,
      async (phase) => {
        const f = await fixture()
        const execute = f.contents.executeJavaScriptInIsolatedWorld
        f.contents.executeJavaScriptInIsolatedWorld = async (world, scripts) => {
          if (
            (phase === "prepare" && scripts[0].code.includes("document.__cmLoginTicket = ticket")) ||
            (phase === "complete" && scripts[0].code.includes("const fill = "))
          )
            throw new Error("fixture-secret native page details")
          return execute(world, scripts)
        }
        await expect(f.run(op)).rejects.toEqual(new Error("Login operation failed"))
        expect(f.deliveries).toHaveLength(0)
        expect(JSON.stringify([f.dialogs, f.messages])).not.toContain("fixture-secret")
        expectReleased(f)
      },
    )

    test(`${op} restores the panel after the native confirmation dialog fails`, async () => {
      const f = await fixture(() => {
        throw new Error("Native dialog unavailable")
      })
      await expect(f.run(op)).rejects.toThrow()
      expect(f.deliveries).toHaveLength(0)
      expectReleased(f)
      expect((await f.state()).profile!.credentials).toEqual([{ id: f.id, origin, username: saved.username }])
    })
  })

  test.each([0, 2, 1.5, NaN, "1"])(
    "stale or invalid revision %s is rejected before any native operation",
    async (revision) => {
      const f = await fixture()
      await expect(f.run("fill-login", { revision })).rejects.toEqual(new Error("Login selection expired"))
      expect(f.calls).toHaveLength(0)
      expect(f.dialogs).toHaveLength(0)
      expectReleased(f, 1)
    },
  )

  test("a legacy fill request without a revision still fills the selected account", async () => {
    const f = await fixture()
    await f.run("fill-login")
    expect(f.deliveries).toEqual([{ username: saved.username, password: saved.password }])
    expectReleased(f)
  })

  test.each(["foreign", "missing"])(
    "a %s account is rejected before any page inspection or confirmation",
    async (kind) => {
      const f = await fixture()
      saveLogins([{ origin: "https://other.test", username: "other", password: "fixture-foreign-secret" }])
      const foreign = (await f.state()).profile!.credentials.find((row) => row.origin === "https://other.test")!
      await expect(f.run("fill-login", { id: kind === "foreign" ? foreign.id : "missing" })).rejects.toThrow()
      expect(f.calls).toHaveLength(0)
      expect(f.dialogs).toHaveLength(0)
      expect(f.deliveries).toHaveLength(0)
      expectReleased(f)
    },
  )

  test("a saved account edited while confirmation is open is never delivered", async () => {
    const f = await fixture(() => {
      saveLogins([{ ...saved, password: "fixture-replacement-secret" }])
      return 1
    })
    await expect(f.run("fill-login")).rejects.toEqual(new Error("Login operation failed"))
    expect(f.deliveries).toHaveLength(0)
    expectReleased(f)
  })

  test.each(["save-login", "fill-login"] as const)("a locked vault blocks %s before reserving the tab", async (op) => {
    const f = await fixture()
    vaultAccess.lock()
    await expect(f.run(op)).rejects.toThrow()
    expect(f.calls).toHaveLength(0)
    expect(f.dialogs).toHaveLength(0)
    expectReleased(f, 1)
  })

  test.each(["save-login", "fill-login"] as const)("Agent Access blocks %s before reserving the tab", async (op) => {
    const f = await fixture()
    f.tab.agentAccess = true
    await expect(f.run(op)).rejects.toThrow()
    expect(f.calls).toHaveLength(0)
    expect(f.dialogs).toHaveLength(0)
    expectReleased(f, 1)
  })

  test.each(["busy-tab", "dialog", "login-check"])(
    "an existing %s operation is preserved when another login is requested",
    async (kind) => {
      const f = await fixture()
      const check = () => {}
      if (kind === "busy-tab") f.tab.loginBusy = true
      if (kind === "dialog") f.owner.suspended = 1
      if (kind === "login-check") f.owner.loginCheck = check
      await expect(f.run("fill-login")).rejects.toThrow()
      expect(f.calls).toHaveLength(0)
      expect(f.dialogs).toHaveLength(0)
      expect(f.tab.loginBusy).toBe(kind === "busy-tab")
      expect(f.owner.suspended).toBe(kind === "dialog" ? 1 : 0)
      expect(f.owner.loginCheck).toBe(kind === "login-check" ? check : undefined)
      expect(f.tab.revision).toBe(1)
    },
  )

  test("invalid field selection does not reach the page or display confirmation", async () => {
    const f = await fixture()
    await expect(f.run("fill-login", { field: "address" })).rejects.toThrow()
    expect(f.calls).toHaveLength(0)
    expect(f.dialogs).toHaveLength(0)
    expectReleased(f)
  })

  test("a pending native fill retains the reservation until settlement and rejects a late response after a task switch", async () => {
    const f = await fixture()
    const started = Promise.withResolvers<void>()
    const delivered = Promise.withResolvers<void>()
    const execute = f.contents.executeJavaScriptInIsolatedWorld
    f.contents.executeJavaScriptInIsolatedWorld = async (world, scripts) => {
      const result = await execute(world, scripts)
      if (scripts[0].code.includes("const fill = ")) {
        started.resolve()
        await delivered.promise
      }
      return result
    }
    const pending = f.run("fill-login")
    await started.promise
    expect(f.tab.loginBusy).toBe(true)
    expect(f.deliveries).toHaveLength(1)
    await expect(f.run("fill-login")).rejects.toThrow()
    expect(f.tab.loginBusy).toBe(true)
    expect(f.deliveries).toHaveLength(1)
    f.owner.taskEpoch++
    delivered.resolve()
    await expect(pending).rejects.toEqual(new Error("Login operation failed"))
    expectReleased(f)
    expect(JSON.stringify(f.messages)).not.toContain(saved.password)
  })
}
