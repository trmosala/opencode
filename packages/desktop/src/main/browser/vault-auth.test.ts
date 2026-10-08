import { afterEach, beforeEach, expect, mock, spyOn, test } from "bun:test"
import childProcess from "node:child_process"
import fs from "node:fs"
import { join } from "node:path"
import { app, BrowserWindow, systemPreferences } from "electron"
import { nativeT } from "../native-translations"
import { createVaultAccess } from "./vault-access"

// Bun module mocks persist across files; isolate the OS boundary from the desktop suite.
if (process.env.CM_VAULT_AUTH_TEST_CHILD !== "1") {
  test("production authentication adapter boundary checks", () => {
    const result = Bun.spawnSync([process.execPath, "test", import.meta.path], {
      cwd: join(import.meta.dir, "../../.."),
      env: { ...process.env, CM_VAULT_AUTH_TEST_CHILD: "1" },
      timeout: 15_000,
      stdout: "pipe",
      stderr: "pipe",
    })
    expect(result.exitCode, Buffer.concat([result.stdout, result.stderr]).toString()).toBe(0)
  }, 20_000)
} else {
  const exists = mock(() => true)
  const spawn = mock(
    (
      _file: string,
      _args: string[],
      _options: object,
      callback: (error: Error | null, out: string, err: string) => void,
    ) => {
      callback(null, "", "")
      return new childProcess.ChildProcess()
    },
  )
  mock.module("node:fs", () => ({ ...fs, existsSync: exists }))
  mock.module("node:child_process", () => ({ ...childProcess, execFile: spawn }))
  const { vaultAuthentication } = await import("./vault-auth")
  const platform = Object.getOwnPropertyDescriptor(process, "platform")!
  const resources = Object.getOwnPropertyDescriptor(process, "resourcesPath")
  const packaged = app.isPackaged

  beforeEach(() => {
    Object.defineProperty(process, "platform", { value: "win32" })
    Object.defineProperty(process, "resourcesPath", { value: "packaged resources", configurable: true })
    app.isPackaged = false
    spyOn(app, "getAppPath").mockReturnValue("development app")
    exists.mockReset().mockReturnValue(true)
    spawn.mockClear().mockImplementation((_file, _args, _options, callback) => {
      callback(null, "", "")
      return new childProcess.ChildProcess()
    })
  })

  afterEach(() => {
    mock.restore()
    Object.defineProperty(process, "platform", platform)
    if (resources) Object.defineProperty(process, "resourcesPath", resources)
    else Reflect.deleteProperty(process, "resourcesPath")
    app.isPackaged = packaged
  })

  function windowWithHandle(handle = Buffer.alloc(8)) {
    const win = new BrowserWindow()
    Object.defineProperty(win, "getNativeWindowHandle", { value: () => handle })
    return win
  }

  test("missing Windows helper rejects without launching a process", async () => {
    exists.mockReturnValue(false)
    const access = createVaultAccess(vaultAuthentication.verify)
    await expect(access.unlock(windowWithHandle())).rejects.toThrow("OS authentication helper unavailable")
    expect(spawn).not.toHaveBeenCalled()
    expect(access.status()).toBe("locked")
    expect(() => access.require()).toThrow()
  })

  test.each([false, true])("Windows helper path and HWND (packaged: %s)", async (isPackaged) => {
    app.isPackaged = isPackaged
    const access = createVaultAccess(vaultAuthentication.verify)
    try {
      for (const handle of [Buffer.from("78563412", "hex"), Buffer.from("efcdab8967452301", "hex")]) {
        await access.unlock(windowWithHandle(handle))
        expect(access.status()).toBe("unlocked")
        expect(spawn).toHaveBeenLastCalledWith(
          join(
            isPackaged ? "packaged resources" : join("development app", "resources"),
            "vault-auth",
            `windows-${process.arch}.exe`,
          ),
          [handle.length === 4 ? "12345678" : "123456789abcdef", nativeT("desktop.browser.unlockReason")],
          { windowsHide: true, timeout: 120_000, maxBuffer: 1024 },
          expect.any(Function),
        )
        access.lock()
      }
    } finally {
      access.lock()
    }
  })

  test.each([
    { code: "ENOENT" },
    { code: 1 },
    { code: "ETIMEDOUT", killed: true },
    { code: "ERR_CHILD_PROCESS_STDIO_MAXBUFFER" },
  ])("helper callback failure %j leaves access locked with a sanitized error", async (failure) => {
    spawn.mockImplementation((_file, _args, _options, callback) => {
      callback(Object.assign(new Error("private helper output"), failure), "private stdout", "private stderr")
      return new childProcess.ChildProcess()
    })
    const access = createVaultAccess(vaultAuthentication.verify)
    await expect(access.unlock(windowWithHandle())).rejects.toEqual(
      new Error("OS authentication was cancelled or unavailable"),
    )
    expect(spawn).toHaveBeenCalledTimes(1)
    expect(access.status()).toBe("locked")
    expect(() => access.require()).toThrow()
  })

  test("late successful helper completion cannot undo a vault lock", async () => {
    const completion = Promise.withResolvers<void>()
    spawn.mockImplementation((_file, _args, _options, callback) => {
      void completion.promise.then(() => callback(null, "", ""))
      return new childProcess.ChildProcess()
    })
    const access = createVaultAccess(vaultAuthentication.verify)
    const pending = access.unlock(windowWithHandle())
    expect(access.status()).toBe("unlocking")
    expect(spawn).toHaveBeenCalledTimes(1)
    access.lock()
    completion.resolve()
    await expect(pending).rejects.toThrow("Vault authentication invalidated")
    expect(access.status()).toBe("locked")
    expect(() => access.require()).toThrow()
  })

  test("missing macOS helper and unsupported platforms fail closed", async () => {
    Object.defineProperty(process, "platform", { value: "darwin" })
    spyOn(systemPreferences, "canPromptTouchID").mockReturnValue(false)
    const prompt = spyOn(systemPreferences, "promptTouchID").mockRejectedValue(new Error("cancelled"))
    const access = createVaultAccess(vaultAuthentication.verify)
    const win = new BrowserWindow()
    exists.mockReturnValue(false)
    await expect(access.unlock(win)).rejects.toThrow("OS authentication helper unavailable")
    expect(prompt).not.toHaveBeenCalled()
    expect(access.status()).toBe("locked")
    Object.defineProperty(process, "platform", { value: "linux" })
    await expect(access.unlock(win)).rejects.toThrow("OS authentication unavailable")
    expect(prompt).not.toHaveBeenCalled()
    expect(spawn).not.toHaveBeenCalled()
    expect(() => access.require()).toThrow()
  })

  test.each([false, true])(
    "macOS uses device-owner authentication without a biometric-only prompt (packaged: %s)",
    async (isPackaged) => {
      Object.defineProperty(process, "platform", { value: "darwin" })
      spyOn(systemPreferences, "canPromptTouchID").mockReturnValue(true)
      const prompt = spyOn(systemPreferences, "promptTouchID").mockResolvedValue(undefined)
      app.isPackaged = isPackaged
      const access = createVaultAccess(vaultAuthentication.verify)
      try {
        await access.unlock(new BrowserWindow())
        expect(access.status()).toBe("unlocked")
        expect(() => access.require()).not.toThrow()
        expect(spawn).toHaveBeenCalledWith(
          join(
            isPackaged ? "packaged resources" : join("development app", "resources"),
            "vault-auth",
            `macos-auth-${process.arch}`,
          ),
          [nativeT("desktop.browser.unlockReason")],
          { windowsHide: true, timeout: 120_000, maxBuffer: 1024 },
          expect.any(Function),
        )
        expect(prompt).not.toHaveBeenCalled()
      } finally {
        access.lock()
      }
    },
  )

  test("macOS cancellation stays locked without trying another authentication method", async () => {
    Object.defineProperty(process, "platform", { value: "darwin" })
    const prompt = spyOn(systemPreferences, "promptTouchID").mockResolvedValue(undefined)
    spawn.mockImplementation((_file, _args, _options, callback) => {
      callback(new Error("cancelled"), "", "")
      return new childProcess.ChildProcess()
    })
    const access = createVaultAccess(vaultAuthentication.verify)
    await expect(access.unlock(new BrowserWindow())).rejects.toThrow("OS authentication was cancelled or unavailable")
    expect(access.status()).toBe("locked")
    expect(spawn).toHaveBeenCalledTimes(1)
    expect(prompt).not.toHaveBeenCalled()
  })
}
