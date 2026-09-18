import fs from "node:fs"
import { timingSafeEqual } from "node:crypto"
import { basename } from "node:path"
import { dialog, type BrowserWindow } from "electron"
import { nativeT } from "../native-translations"
import { getStore } from "../store"
import { mergeLogins } from "./import-data"
import { readLogins, vaultAvailable, writeLogins } from "./vault"
import { vaultAuthentication } from "./vault-auth"
import { decryptVaultBackup, encryptVaultBackup } from "./vault-backup-format"
import { promptVaultBackupPassphrase, vaultBackupAvailable } from "./vault-backup-passphrase"
import { vaultAccess } from "./vault-session"
import { atomicWriteNewFile } from "./atomic-export"

const MAX_BACKUP_BYTES = 5 * 1024 * 1024
let transferring = false
class VaultBackupUserError extends Error {}

export async function transferVaultBackup(win: BrowserWindow, direction: "export" | "import", ownerCheck: () => void) {
  if (direction !== "export" && direction !== "import") throw new Error(nativeT("desktop.browser.backup.unavailable"))
  if (transferring || !vaultBackupAvailable() || !vaultAvailable())
    throw new Error(nativeT("desktop.browser.backup.unavailable"))
  const ticket = vaultAccess.require()
  const contents = win.webContents
  let invalid = false
  let reason = nativeT("desktop.browser.backup.unavailable")
  const revoke = () => {
    invalid = true
  }
  const check = () => {
    try {
      if (
        invalid ||
        win.isDestroyed() ||
        contents.isDestroyed() ||
        win.webContents !== contents ||
        !win.isVisible() ||
        win.isMinimized() ||
        !vaultAvailable()
      )
        throw new Error()
      ownerCheck()
      vaultAccess.require(ticket)
    } catch {
      invalid = true
      reason = nativeT("desktop.browser.backup.stale")
      throw new Error(reason)
    }
  }
  transferring = true
  win.on("hide", revoke)
  win.on("minimize", revoke)
  win.on("close", revoke)
  win.on("closed", revoke)
  contents.on("did-start-navigation", revoke)
  contents.on("render-process-gone", revoke)
  contents.on("destroyed", revoke)
  try {
    check()
    reason = nativeT("desktop.browser.backup.authentication")
    await vaultAuthentication.verify(win)
    check()
    reason = nativeT(
      direction === "export" ? "desktop.browser.backup.exportFailed" : "desktop.browser.backup.importFailed",
    )
    if (direction === "export") await exportBackup(win, check)
    if (direction === "import") await importBackup(win, check)
  } catch (error) {
    if (error instanceof VaultBackupUserError) throw error
    // Native, file and crypto errors can contain paths or process output; expose only the current safe stage message.
    // oxlint-disable-next-line eslint/preserve-caught-error
    throw new Error(reason)
  } finally {
    win.removeListener("hide", revoke)
    win.removeListener("minimize", revoke)
    win.removeListener("close", revoke)
    win.removeListener("closed", revoke)
    contents.removeListener("did-start-navigation", revoke)
    contents.removeListener("render-process-gone", revoke)
    contents.removeListener("destroyed", revoke)
    transferring = false
  }
}

async function exportBackup(win: BrowserWindow, check: () => void) {
  const passphrase = await promptVaultBackupPassphrase(win)
  check()
  if (passphrase === undefined) return
  const confirmation = await promptVaultBackupPassphrase(win, true)
  check()
  if (confirmation === undefined) return
  const left = Buffer.from(passphrase)
  const right = Buffer.from(confirmation)
  const matches = left.length === right.length && timingSafeEqual(left, right)
  left.fill(0)
  right.fill(0)
  if (!matches) throw new VaultBackupUserError(nativeT("desktop.browser.backup.passphraseMismatch"))
  const chosen = await dialog.showSaveDialog(win, {
    title: nativeT("desktop.browser.backup.exportTitle"),
    defaultPath: `CookieMonster-passwords-${new Date().toISOString().slice(0, 10)}.cmbvault`,
    filters: [{ name: "CookieMonster encrypted password backup", extensions: ["cmbvault"] }],
  })
  check()
  if (chosen.canceled || !chosen.filePath) return
  const backup = await encryptVaultBackup(readLogins(false), passphrase)
  check()
  try {
    atomicWriteNewFile(chosen.filePath, backup)
  } finally {
    backup.fill(0)
  }
  try {
    await dialog.showMessageBox(win, {
      type: "info",
      message: nativeT("desktop.browser.backup.exported"),
      detail: nativeT("desktop.browser.backup.exportedDetail", { file: basename(chosen.filePath) }),
      buttons: [nativeT("desktop.browser.import.close")],
    })
  } catch {
    // The backup is already committed; a result-dialog failure cannot roll it back or redefine success.
  }
}

async function importBackup(win: BrowserWindow, check: () => void) {
  const chosen = await dialog.showOpenDialog(win, {
    title: nativeT("desktop.browser.backup.importTitle"),
    properties: ["openFile"],
    filters: [{ name: "CookieMonster encrypted password backup", extensions: ["cmbvault"] }],
  })
  check()
  if (chosen.canceled || !chosen.filePaths[0]) return
  const bytes = readBackupFile(chosen.filePaths[0])
  const passphrase = await promptVaultBackupPassphrase(win)
  check()
  if (passphrase === undefined) {
    bytes.fill(0)
    return
  }
  const imported = await decryptVaultBackup(bytes, passphrase).finally(() => bytes.fill(0))
  check()
  const before = JSON.stringify([getStore("cm-browser").get("vault"), getStore("cm-browser").get("credentials")])
  const plan = mergeLogins(readLogins(false), imported)
  const answer = await dialog.showMessageBox(win, {
    type: "warning",
    message: nativeT("desktop.browser.backup.review"),
    detail: nativeT("desktop.browser.backup.counts", {
      valid: plan.valid,
      duplicate: plan.duplicate,
      add: plan.add,
      replace: plan.replace,
      unchanged: plan.unchanged,
    }),
    buttons: [nativeT("desktop.browser.cancel"), nativeT("desktop.browser.import.confirm")],
    defaultId: 0,
    cancelId: 0,
  })
  check()
  if (answer.response !== 1) return
  if (JSON.stringify([getStore("cm-browser").get("vault"), getStore("cm-browser").get("credentials")]) !== before)
    throw new VaultBackupUserError(nativeT("desktop.browser.backup.stale"))
  if (plan.add || plan.replace) writeLogins(plan.rows)
  try {
    await dialog.showMessageBox(win, {
      type: "info",
      message: nativeT("desktop.browser.import.result"),
      detail: nativeT("desktop.browser.backup.imported", {
        add: plan.add,
        replace: plan.replace,
        unchanged: plan.unchanged,
        duplicate: plan.duplicate,
      }),
      buttons: [nativeT("desktop.browser.import.close")],
    })
  } catch {
    // The atomic vault write already committed; never report a false no-change result.
  }
}

function readBackupFile(path: string) {
  const descriptor = fs.openSync(path, "r")
  try {
    const stat = fs.fstatSync(descriptor)
    if (!stat.isFile() || stat.size <= 0 || stat.size > MAX_BACKUP_BYTES) throw new Error()
    const bytes = Buffer.alloc(stat.size)
    if (fs.readSync(descriptor, bytes, 0, bytes.length, 0) !== bytes.length) throw new Error()
    return bytes
  } finally {
    fs.closeSync(descriptor)
  }
}
