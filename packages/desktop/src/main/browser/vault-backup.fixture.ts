import assert from "node:assert/strict"
import { mkdir, readFile, writeFile, rename } from "node:fs/promises"
import { join } from "node:path"
import { app, BrowserWindow, dialog } from "electron"
import { vaultAuthentication } from "./vault-auth"
import { vaultAccess } from "./vault-session"
import { vaultBackupAvailable, promptVaultBackupPassphrase } from "./vault-backup-passphrase"
import { browserCommand, browserLinkContext, registerBrowserOwner } from "./tabs"
import { readLogins, writeLogins } from "./vault"
import { getStore } from "../store"

export async function vaultBackupSmoke() {
  const directory = process.env.CM_BROWSER_SMOKE_PROFILE
  assert(directory && process.platform === "darwin", "Use the isolated macOS native runner")
  const original = {
    path: app.getAppPath,
    verify: vaultAuthentication.verify,
    save: dialog.showSaveDialog,
    open: dialog.showOpenDialog,
    message: dialog.showMessageBox,
  }
  const helper = join(directory, "resources", "vault-auth", `macos-entry-${process.arch}`)
  const backup = join(directory, "passwords.cmbvault")
  const reply = Buffer.from("synthetic backup passphrase", "utf16le")
  const header = Buffer.alloc(8)
  header.writeUInt32LE(reply.length, 4)
  await mkdir(join(directory, "resources", "vault-auth"), { recursive: true })
  await writeFile(helper + ".response", Buffer.concat([header, reply]))
  // Exercise the real subprocess adapter/protocol, never a physical secure-entry ceremony.
  await writeFile(
    helper,
    '#!/bin/sh\n[ "$#" -eq 8 ] && [ "$1" = 0 ] && [ -z "$5" ] && [ -n "$6" ] && [ -n "$7" ] && [ "$8" = passphrase ] || exit 3\n/bin/cat "$0.response"\n',
    { mode: 0o700 },
  )
  const win = new BrowserWindow({ show: false })
  const owner = registerBrowserOwner(win)
  const command = (direction: "export" | "import") =>
    browserCommand(owner, "backup-smoke", { op: "vault-backup", direction })
  let reviews = 0
  let allow = true
  let invalidate = false
  let authenticated = 0
  try {
    app.getAppPath = () => directory
    vaultAuthentication.verify = async () => {
      authenticated++
    }
    dialog.showSaveDialog = (async () => ({ canceled: false, filePath: backup })) as typeof original.save
    dialog.showOpenDialog = (async () => ({ canceled: false, filePaths: [backup] })) as typeof original.open
    dialog.showMessageBox = (async (_win, options) => {
      if (options?.type === "warning") {
        assert.equal(options.defaultId, 0)
        assert.equal(options.cancelId, 0)
        reviews++
        if (invalidate) vaultAccess.lock()
        return { response: allow ? 1 : 0, checkboxChecked: false }
      }
      return { response: 0, checkboxChecked: false }
    }) as typeof original.message
    await win.loadURL("data:text/html,<title>Isolated backup fixture</title>")
    win.showInactive()
    browserLinkContext(owner, "backup-smoke", "backup-smoke")
    assert(vaultBackupAvailable(), "macOS helper enables backup")
    await vaultAccess.unlock(win)
    const login = {
      id: "00000000-0000-4000-8000-000000000001",
      origin: "https://example.test",
      username: "person",
      password: "synthetic-secret",
    }
    writeLogins([login])
    await command("export")
    assert.equal(authenticated, 2, "Export requires fresh authentication")
    const encrypted = await readFile(backup)
    assert(!encrypted.includes(Buffer.from(login.password)))
    await assert.rejects(command("export"), "Existing backup is never overwritten")
    assert.deepEqual(await readFile(backup), encrypted)
    writeLogins([{ ...login, password: "local-change" }])
    const before = JSON.stringify(getStore("cm-browser").get("vault"))
    allow = false
    await command("import")
    assert.equal(JSON.stringify(getStore("cm-browser").get("vault")), before)
    allow = true
    invalidate = true
    await assert.rejects(command("import"))
    assert.equal(JSON.stringify(getStore("cm-browser").get("vault")), before)
    invalidate = false
    await vaultAccess.unlock(win)
    await command("import")
    assert.deepEqual(readLogins(), [login], "Reviewed collision retains destination ID")
    assert.equal(reviews, 3)
    const completed = JSON.stringify(getStore("cm-browser").get("vault"))
    await writeFile(
      helper + ".response",
      Buffer.concat([header, Buffer.from("incorrect backup password!!", "utf16le")]),
    )
    assert.equal(await promptVaultBackupPassphrase(win), "incorrect backup password!!")
    await assert.rejects(command("import"))
    assert.equal(JSON.stringify(getStore("cm-browser").get("vault")), completed)
    await writeFile(helper + ".response", Buffer.concat([header, reply]))
    const tampered = JSON.parse(encrypted.toString())
    tampered.cipher.data = Buffer.from("tampered").toString("base64")
    await writeFile(backup, JSON.stringify(tampered))
    await assert.rejects(command("import"))
    assert.equal(JSON.stringify(getStore("cm-browser").get("vault")), completed)
    await writeFile(helper + ".response", Buffer.from("malformed"))
    await assert.rejects(promptVaultBackupPassphrase(win))
    await writeFile(helper, "#!/bin/sh\nexit 1\n", { mode: 0o700 })
    assert.equal(await promptVaultBackupPassphrase(win), undefined)
    await writeFile(helper, "#!/bin/sh\nexec /bin/sleep 30\n", { mode: 0o700 })
    const pending = promptVaultBackupPassphrase(win)
    vaultAccess.lock()
    await assert.rejects(pending)
    await vaultAccess.unlock(win)
    await rename(helper, helper + ".missing")
    assert.equal(vaultBackupAvailable(), false)
    await assert.rejects(command("export"))
    console.log(
      "PASS macOS backup: native subprocess protocol, authenticated export/import, collision, cancel, lock, wrong key, tampering and missing helper",
    )
  } finally {
    app.getAppPath = original.path
    vaultAuthentication.verify = original.verify
    dialog.showSaveDialog = original.save
    dialog.showOpenDialog = original.open
    dialog.showMessageBox = original.message
    vaultAccess.lock()
    win.destroy()
    reply.fill(0)
  }
}
