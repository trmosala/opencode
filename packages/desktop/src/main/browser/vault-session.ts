import { app, powerMonitor, type BrowserWindow } from "electron"
import { createVaultAccess } from "./vault-access"
import { vaultAuthentication } from "./vault-auth"

export const vaultAccess = createVaultAccess(async (win: BrowserWindow) => {
  if (win.isDestroyed() || !win.isVisible() || win.isMinimized()) throw new Error("Vault requires a visible window")
  await vaultAuthentication.verify(win)
  if (win.isDestroyed() || !win.isVisible() || win.isMinimized()) throw new Error("Vault window changed")
})

let initialized = false
export function initializeVaultLocking() {
  if (initialized) return
  initialized = true
  powerMonitor.on("lock-screen", vaultAccess.lock)
  powerMonitor.on("suspend", vaultAccess.lock)
  app.on("before-quit", vaultAccess.lock)
}
