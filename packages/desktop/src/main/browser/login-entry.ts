import { execFile } from "node:child_process"
import { existsSync } from "node:fs"
import { join } from "node:path"
import { app, type BrowserWindow } from "electron"
import { nativeT } from "../native-translations"
import { loginOrigin, requireLogin } from "./import-data"
import { vaultAccess } from "./vault-session"

function helperPath() {
  return app.isPackaged
    ? join(process.resourcesPath, "vault-auth", `windows-entry-${process.arch}.exe`)
    : join(app.getAppPath(), "resources", "vault-auth", `windows-entry-${process.arch}.exe`)
}

export function loginEntryAvailable() {
  return process.platform === "win32" && existsSync(helperPath())
}

export const loginEntry = {
  async prompt(win: BrowserWindow, origin: string, username: string) {
    const ticket = vaultAccess.require()
    if (!loginEntryAvailable() || loginOrigin(origin) !== origin || username.length > 4096 || username.includes("\0"))
      throw new Error("Native account entry unavailable")
    if (win.isDestroyed() || !win.isVisible() || win.isMinimized()) throw new Error("Account window unavailable")
    const handle = win.getNativeWindowHandle()
    const hwnd = handle.length === 8 ? handle.readBigUInt64LE().toString(16) : handle.readUInt32LE().toString(16)
    return new Promise<ReturnType<typeof requireLogin> | undefined>((resolve, reject) => {
      const child = execFile(
        helperPath(),
        [
          hwnd,
          origin,
          nativeT("desktop.browser.account.title"),
          nativeT("desktop.browser.account.entry", { origin }),
          // CredUI cannot represent longer imported usernames. Allow explicit replacement, never truncate.
          username.length <= 513 ? username : "",
        ],
        {
          encoding: "buffer",
          windowsHide: true,
          timeout: Math.max(1, Math.floor(Math.min(120_000, vaultAccess.remaining()))),
          maxBuffer: 8192,
        },
        (error, stdout, stderr) => {
          unsubscribe()
          try {
            vaultAccess.require(ticket)
            if (win.isDestroyed() || !win.isVisible() || win.isMinimized()) throw new Error()
            if (error) {
              if (error.code === 1) return resolve(undefined)
              throw new Error()
            }
            resolve(decodeLoginEntry(origin, stdout))
          } catch {
            // Child-process errors can carry stdout. Never propagate them across renderer IPC.
            reject(new Error("Native account entry cancelled or unavailable"))
          } finally {
            stdout.fill(0)
            stderr.fill(0)
          }
        },
      )
      const unsubscribe = vaultAccess.subscribe(() => {
        if (vaultAccess.status() !== "unlocked") child.kill()
      })
    })
  },
}

export function decodeLoginEntry(origin: string, bytes: Buffer) {
  if (bytes.length < 8) throw new Error("Invalid native account response")
  const userBytes = bytes.readUInt32LE(0)
  const passwordBytes = bytes.readUInt32LE(4)
  if (
    userBytes % 2 ||
    passwordBytes % 2 ||
    userBytes > 1026 ||
    !passwordBytes ||
    passwordBytes > 512 ||
    bytes.length !== 8 + userBytes + passwordBytes
  )
    throw new Error("Invalid native account response")
  return requireLogin({
    origin,
    username: bytes.subarray(8, 8 + userBytes).toString("utf16le"),
    password: bytes.subarray(8 + userBytes).toString("utf16le"),
  })
}
