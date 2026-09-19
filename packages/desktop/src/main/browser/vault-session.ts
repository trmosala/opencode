import { app, powerMonitor, safeStorage, type BrowserWindow } from "electron"
import { nativeT } from "../native-translations"
import { createVaultAccess } from "./vault-access"
import { vaultAuthentication } from "./vault-auth"

export const vaultAccess = createVaultAccess(async (win: BrowserWindow) => {
  if (!vaultAvailable()) throw new Error(nativeT("desktop.browser.tabs.unavailable"))
  if (win.isDestroyed() || !win.isVisible() || win.isMinimized()) throw new Error("Vault requires a visible window")
  await vaultAuthentication.verify(win)
  if (!vaultAvailable()) throw new Error(nativeT("desktop.browser.tabs.unavailable"))
  if (win.isDestroyed() || !win.isVisible() || win.isMinimized()) throw new Error("Vault window changed")
})

export function vaultAvailable() {
  const available =
    !app.commandLine.hasSwitch("remote-debugging-port") &&
    !app.commandLine.hasSwitch("remote-debugging-pipe") &&
    safeStorage.isEncryptionAvailable() &&
    (process.platform !== "linux" || !["basic_text", "unknown"].includes(safeStorage.getSelectedStorageBackend()))
  // Lock before notifying subscribers; profile publication synchronously checks capability again.
  if (!available && vaultAccess.status() !== "locked") vaultAccess.lock()
  return available
}

let initialized = false
export function initializeVaultLocking() {
  if (initialized) return
  initialized = true
  powerMonitor.on("lock-screen", vaultAccess.lock)
  powerMonitor.on("suspend", vaultAccess.lock)
  app.on("before-quit", vaultAccess.lock)
}
