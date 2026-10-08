import { execFile } from "node:child_process"
import { type BrowserWindow } from "electron"
import { nativeT } from "../native-translations"
import { loginOrigin, requireLogin } from "./import-data"
import { nativeSecretEntryAvailable, nativeSecretEntryPath, nativeSecretEntryWindow } from "./native-secret-entry"
import { vaultAccess } from "./vault-session"

export function loginEntryAvailable() {
  return nativeSecretEntryAvailable()
}

export const loginEntry = {
  async prompt(
    win: BrowserWindow,
    origin: string,
    username: string,
    detail = nativeT("desktop.browser.account.entry", { origin }),
    signal?: AbortSignal,
  ) {
    const ticket = vaultAccess.require()
    const helper = nativeSecretEntryPath()
    if (
      !helper ||
      !loginEntryAvailable() ||
      loginOrigin(origin) !== origin ||
      username.length > 4096 ||
      username.includes("\0")
    )
      throw new Error("Native account entry unavailable")
    if (win.isDestroyed() || !win.isVisible() || win.isMinimized()) throw new Error("Account window unavailable")
    if (signal?.aborted) throw new Error("Account entry cancelled")
    return new Promise<ReturnType<typeof requireLogin> | undefined>((resolve, reject) => {
      const child = execFile(
        helper,
        [
          nativeSecretEntryWindow(win),
          origin,
          nativeT("desktop.browser.account.title"),
          detail,
          // Native entry fields are bounded. Allow explicit replacement, never truncate imported usernames.
          username.length <= 513 ? username : "",
          ...(process.platform === "darwin"
            ? [nativeT("desktop.browser.save"), nativeT("desktop.browser.cancel")]
            : []),
        ],
        {
          encoding: "buffer",
          windowsHide: true,
          timeout: Math.max(1, Math.floor(Math.min(120_000, vaultAccess.remaining()))),
          maxBuffer: 8192,
        },
        (error, stdout, stderr) => {
          unsubscribe()
          signal?.removeEventListener("abort", abort)
          try {
            vaultAccess.require(ticket)
            if (signal?.aborted) throw new Error()
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
      const abort = () => child.kill()
      signal?.addEventListener("abort", abort, { once: true })
      if (signal?.aborted) child.kill()
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
