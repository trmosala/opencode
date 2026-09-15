import { execFile } from "node:child_process"
import { existsSync } from "node:fs"
import { join } from "node:path"
import { app, systemPreferences, type BrowserWindow } from "electron"
import { nativeT } from "../native-translations"

export const vaultAuthentication = {
  async verify(win: BrowserWindow) {
    if (process.platform === "darwin") {
      if (!systemPreferences.canPromptTouchID()) throw new Error("OS authentication unavailable")
      await systemPreferences.promptTouchID(nativeT("desktop.browser.unlockReason"))
      return
    }
    if (process.platform !== "win32") throw new Error("OS authentication unavailable")
    const helper = app.isPackaged
      ? join(process.resourcesPath, "vault-auth", `windows-${process.arch}.exe`)
      : join(app.getAppPath(), "resources", "vault-auth", `windows-${process.arch}.exe`)
    if (!existsSync(helper)) throw new Error("OS authentication helper unavailable")
    const handle = win.getNativeWindowHandle()
    const hwnd = handle.length === 8 ? handle.readBigUInt64LE().toString(16) : handle.readUInt32LE().toString(16)
    await new Promise<void>((resolve, reject) => {
      execFile(
        helper,
        [hwnd, nativeT("desktop.browser.unlockReason")],
        { windowsHide: true, timeout: 120_000, maxBuffer: 1024 },
        (error) => {
          if (error) return reject(new Error("OS authentication was cancelled or unavailable"))
          resolve()
        },
      )
    })
  },
}
