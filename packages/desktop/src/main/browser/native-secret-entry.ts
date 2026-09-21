import { existsSync } from "node:fs"
import { join } from "node:path"
import { app, type BrowserWindow } from "electron"

export function nativeSecretEntryName(platform: NodeJS.Platform = process.platform, arch = process.arch) {
  if (platform === "win32") return `windows-entry-${arch}.exe`
  if (platform === "darwin") return `macos-entry-${arch}`
  return undefined
}

export function nativeSecretEntryPath() {
  const name = nativeSecretEntryName()
  if (!name) return undefined
  return app.isPackaged
    ? join(process.resourcesPath, "vault-auth", name)
    : join(app.getAppPath(), "resources", "vault-auth", name)
}

export function nativeSecretEntryAvailable() {
  const path = nativeSecretEntryPath()
  return path !== undefined && existsSync(path)
}

export function nativeSecretEntryWindow(win: BrowserWindow) {
  if (process.platform === "darwin") return "0"
  const handle = win.getNativeWindowHandle()
  return handle.length === 8 ? handle.readBigUInt64LE().toString(16) : handle.readUInt32LE().toString(16)
}
