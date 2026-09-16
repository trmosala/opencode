import assert from "node:assert/strict"
import fs from "node:fs"
import { join } from "node:path"
import { syncBuiltinESMExports } from "node:module"
import { BrowserWindow, safeStorage } from "electron"
import { getStore } from "../store"
import { readLogins, writeLogins, vaultAvailable } from "./vault"
import { vaultAccess } from "./vault-session"
import { vaultAuthentication } from "./vault-auth"
import { persistenceRenameFault } from "./persistence-fault.fixture"

export async function persistenceReopen(profile: string) {
  const phase = process.env.CM_BROWSER_PERSISTENCE_PHASE
  const storage = getStore("cm-browser")
  const file = join(profile, "profile", "cm-browser")
  assert.equal(storage.path, file)
  const win = new BrowserWindow({ show: false })
  const verify = vaultAuthentication.verify
  const rows = (version: string) => [
    {
      id: "00000000-0000-4000-8000-000000000034",
      origin: "https://fixture.example",
      username: `fixture-${version}`,
      password: `synthetic-${version}-secret`,
    },
  ]
  const oldFile = join(profile, "old-store.json")
  const newFile = join(profile, "new-store.json")
  const legacyFile = join(profile, "legacy-store.json")
  try {
    win.showInactive()
    vaultAuthentication.verify = async () => {}
    await vaultAccess.unlock(win)
    assert(vaultAvailable(), "Native secure storage must be available; do not bypass encryption")

    if (phase === "seed") {
      storage.store = {
        preferences: { showFullURL: true },
        bookmarks: [{ id: "fixture", url: "https://fixture.example", title: "Keep" }],
        futureField: { version: 34, nested: [null, true, "unknown"] },
      }
      writeLogins(rows("old"))
      fs.writeFileSync(oldFile, fs.readFileSync(file))
      storage.set("preferences", { showFullURL: false })
      writeLogins(rows("new"))
      fs.writeFileSync(newFile, fs.readFileSync(file))
      storage.store = JSON.parse(fs.readFileSync(oldFile, "utf8"))
      assert.deepEqual(readLogins(), rows("old"))
      assert(!fs.readFileSync(newFile, "utf8").includes("synthetic-new-secret"))
      return
    }

    if (phase === "interrupt-before" || phase === "interrupt-after") {
      const rename = fs.renameSync
      fs.renameSync = (source, target) => {
        if (String(target) !== file) return rename(source, target)
        assert.equal(fs.readFileSync(String(source), "utf8"), fs.readFileSync(newFile, "utf8"))
        if (phase === "interrupt-after") rename(source, target)
        const checkpoint = join(profile, "checkpoint.json")
        fs.writeFileSync(`${checkpoint}.tmp`, JSON.stringify({ pid: process.pid, phase }), { flag: "wx" })
        rename(`${checkpoint}.tmp`, checkpoint)
        // The owning runner SIGKILLs this child handle; no catch/finally/app.exit runs.
        Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0)
        throw new Error("Interruption checkpoint unexpectedly resumed")
      }
      syncBuiltinESMExports()
      storage.store = JSON.parse(fs.readFileSync(newFile, "utf8"))
      throw new Error("Rename checkpoint was not reached")
    }

    if (phase === "reopen-old" || phase === "reopen-new") {
      const expected = fs.readFileSync(phase === "reopen-old" ? oldFile : newFile)
      assert(fs.readFileSync(file).equals(expected), "Whole store, including settings and unknown fields, survives")
      assert.deepEqual(readLogins(), rows(phase === "reopen-old" ? "old" : "new"))
      const leftovers = fs.readdirSync(join(profile, "profile")).filter((name) => name.startsWith("cm-browser."))
      assert.equal(leftovers.length, 1, "Before-rename orphan is neither recovered nor swept")
      assert(fs.readFileSync(join(profile, "profile", leftovers[0])).equals(fs.readFileSync(newFile)))
      console.log(`PASS ${phase}: complete encrypted vault/settings; one untouched exclusive temp`)
      return
    }

    if (phase === "faults") {
      const before = fs.readFileSync(file)
      const original = storage.store
      for (const mode of ["close-open", "close-closed", "collision"]) {
        const open = fs.openSync
        const close = fs.closeSync
        const fault = Object.assign(new Error(`fixture ${mode}`), { code: "EIO" })
        let descriptor: number | undefined
        let replacement: number | undefined
        let temporary = ""
        let reached = false
        try {
          fs.openSync = (target, flags, permissions) => {
            if (!String(target).startsWith(`${file}.`) || flags !== "wx") return open(target, flags, permissions)
            temporary = String(target)
            if (mode === "collision") {
              const competitor = open(temporary, "wx")
              try {
                fs.writeFileSync(competitor, "not owned by this store invocation")
              } finally {
                close(competitor)
              }
              reached = true
              return open(target, flags, permissions)
            }
            descriptor = open(target, flags, permissions)
            return descriptor
          }
          fs.closeSync = (fd) => {
            if (fd !== descriptor) return close(fd)
            reached = true
            if (mode === "close-closed") {
              close(fd)
              descriptor = undefined
              replacement = open(join(profile, "unrelated-descriptor"), "w+")
            }
            throw fault
          }
          syncBuiltinESMExports()
          assert.throws(
            () => storage.set("interrupted", true),
            (error) =>
              mode === "collision"
                ? !!error && typeof error === "object" && "code" in error && error.code === "EEXIST"
                : error === fault,
          )
          assert(reached)
          assert(fs.readFileSync(file).equals(before))
          assert.deepEqual(storage.store, original)
          if (replacement !== undefined) assert(fs.fstatSync(replacement).isFile(), "Never re-close an ambiguous fd")
          if (mode === "collision")
            assert.equal(fs.readFileSync(temporary, "utf8"), "not owned by this store invocation")
          console.log(`PASS ${mode}: original preserved; no unowned file/descriptor cleanup`)
        } finally {
          fs.openSync = open
          fs.closeSync = close
          syncBuiltinESMExports()
          if (descriptor !== undefined) close(descriptor)
          if (replacement !== undefined) close(replacement)
          // Exact paths created by this fixture only, including the deliberate collision.
          if (temporary && fs.existsSync(temporary)) fs.unlinkSync(temporary)
        }
      }
      return
    }

    if (phase === "seed-legacy") {
      const current = storage.store
      delete current.vault
      storage.store = {
        ...current,
        credentials: rows("legacy").map(({ origin, username, password }) => ({
          origin,
          username,
          encrypted: safeStorage.encryptString(password).toString("base64"),
        })),
      }
      fs.writeFileSync(legacyFile, fs.readFileSync(file))
      return
    }

    if (phase === "migration-fail" || phase === "reopen-legacy") {
      const before = fs.readFileSync(legacyFile)
      assert(fs.readFileSync(file).equals(before))
      assert.equal(storage.has("vault"), false)
      const legacy = storage.get("credentials") as { encrypted: string }[]
      assert.equal(safeStorage.decryptString(Buffer.from(legacy[0].encrypted, "base64")), rows("legacy")[0].password)
      // Keep readLogins from silently migrating while checking the failed/reopened legacy state.
      persistenceRenameFault.path = file
      persistenceRenameFault.attempts = 0
      try {
        assert.throws(
          () => readLogins(),
          (error) => !!error && typeof error === "object" && "code" in error && error.code === "EXDEV",
        )
        assert.equal(persistenceRenameFault.attempts, 1)
      } finally {
        persistenceRenameFault.path = ""
      }
      assert(fs.readFileSync(file).equals(before), "Failed migration preserves all legacy ciphertext and settings")
      console.log(`PASS ${phase}: real migration rejected; complete legacy/settings preserved`)
      return
    }

    if (phase === "migrate" || phase === "reopen-migrated") {
      const rowsRead = readLogins()
      assert.equal(rowsRead.length, 1)
      assert.deepEqual(
        rowsRead.map(({ origin, username, password }) => ({ origin, username, password })),
        rows("legacy").map(({ origin, username, password }) => ({ origin, username, password })),
      )
      assert.equal(storage.has("credentials"), false)
      assert.equal((storage.get("vault") as { version: number }).version, 1)
      const { vault, ...settings } = storage.store
      const { credentials, ...legacySettings } = JSON.parse(fs.readFileSync(legacyFile, "utf8"))
      assert.deepEqual(settings, legacySettings)
      assert(!fs.readFileSync(file, "utf8").includes("synthetic-legacy-secret"))
      const migrated = join(profile, "migrated-store.json")
      if (phase === "migrate") fs.writeFileSync(migrated, fs.readFileSync(file))
      else
        assert(fs.readFileSync(file).equals(fs.readFileSync(migrated)), "Reopening never rewrites the migrated vault")
      console.log(`PASS ${phase}: authenticated new vault, no legacy, unchanged settings`)
      return
    }
    throw new Error(`Unknown persistence phase: ${phase}`)
  } finally {
    persistenceRenameFault.restore()
    vaultAccess.lock()
    vaultAuthentication.verify = verify
    win.destroy()
  }
}
