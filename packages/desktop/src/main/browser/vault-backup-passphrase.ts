import { execFile } from "node:child_process"
import { existsSync } from "node:fs"
import { join } from "node:path"
import { app, type BrowserWindow } from "electron"
import { nativeT } from "../native-translations"
import { vaultAccess } from "./vault-session"

function helperPath() {
  return app.isPackaged
    ? join(process.resourcesPath, "vault-auth", `windows-entry-${process.arch}.exe`)
    : join(app.getAppPath(), "resources", "vault-auth", `windows-entry-${process.arch}.exe`)
}

export function vaultBackupAvailable() {
  return process.platform === "win32" && existsSync(helperPath())
}

export async function promptVaultBackupPassphrase(win: BrowserWindow, confirmation = false) {
  const ticket = vaultAccess.require()
  if (!vaultBackupAvailable()) throw new Error("Native backup passphrase entry unavailable")
  if (win.isDestroyed() || !win.isVisible() || win.isMinimized()) throw new Error("Backup window unavailable")
  const handle = win.getNativeWindowHandle()
  const hwnd = handle.length === 8 ? handle.readBigUInt64LE().toString(16) : handle.readUInt32LE().toString(16)
  return new Promise<string | undefined>((resolve, reject) => {
    const child = execFile(
      helperPath(),
      [
        hwnd,
        "CookieMonster password backup",
        nativeT("desktop.browser.backup.passphraseTitle"),
        nativeT(confirmation ? "desktop.browser.backup.passphraseConfirm" : "desktop.browser.backup.passphrasePrompt"),
        "",
      ],
      {
        encoding: "buffer",
        windowsHide: true,
        timeout: Math.max(1, Math.floor(Math.min(120_000, vaultAccess.remaining()))),
        maxBuffer: 2048,
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
          resolve(decodePassphrase(stdout))
        } catch {
          reject(new Error("Native backup passphrase entry cancelled or unavailable"))
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
}

export function decodePassphrase(bytes: Buffer) {
  if (bytes.length < 8) throw new Error("Invalid native backup response")
  const usernameBytes = bytes.readUInt32LE(0)
  const passwordBytes = bytes.readUInt32LE(4)
  if (
    usernameBytes % 2 ||
    passwordBytes % 2 ||
    usernameBytes > 1026 ||
    passwordBytes < 24 ||
    passwordBytes > 512 ||
    bytes.length !== 8 + usernameBytes + passwordBytes
  )
    throw new Error("Invalid native backup response")
  const passphrase = bytes.subarray(8 + usernameBytes).toString("utf16le")
  if (passphrase.length < 12 || passphrase.length > 256 || passphrase.includes("\0"))
    throw new Error("Invalid native backup response")
  return passphrase
}
