import { execFile } from "node:child_process"
import { existsSync } from "node:fs"
import { join } from "node:path"
import { app, type BrowserWindow } from "electron"
import { nativeT } from "../native-translations"

export const vaultAuthentication = {
  async verify(win: BrowserWindow) {
    // macOS uses device-owner authentication so the OS can offer its password
    // fallback even on a Mac that has Touch ID. Cancellation never starts a second prompt.
    if (process.platform !== "win32" && process.platform !== "darwin") throw new Error("OS authentication unavailable")
    const name = process.platform === "darwin" ? `macos-auth-${process.arch}` : `windows-${process.arch}.exe`
    const helper = app.isPackaged
      ? join(process.resourcesPath, "vault-auth", name)
      : join(app.getAppPath(), "resources", "vault-auth", name)
    if (!existsSync(helper)) throw new Error("OS authentication helper unavailable")
    const args = [nativeT("desktop.browser.unlockReason")]
    if (process.platform === "win32") {
      const handle = win.getNativeWindowHandle()
      args.unshift(handle.length === 8 ? handle.readBigUInt64LE().toString(16) : handle.readUInt32LE().toString(16))
    }
    await new Promise<void>((resolve, reject) => {
      execFile(helper, args, { windowsHide: true, timeout: 120_000, maxBuffer: 1024 }, (error) => {
        if (error) return reject(new Error("OS authentication was cancelled or unavailable"))
        resolve()
      })
    })
  },
}
