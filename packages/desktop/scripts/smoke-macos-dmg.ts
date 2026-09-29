import assert from "node:assert/strict"
import { createHash } from "node:crypto"
import { constants, createReadStream } from "node:fs"
import { access, lstat, mkdir, mkdtemp, readdir, readlink, realpath, rm, rmdir } from "node:fs/promises"
import { createRequire } from "node:module"
import { homedir } from "node:os"
import { join, resolve } from "node:path"
import { copyUserApp, macCommand } from "../src/main/macos-user-install"

// Run with Bun on macOS after packaging, optionally passing one DMG path.
assert.equal(process.platform, "darwin", "The DMG smoke test requires macOS")
assert(process.getuid!() > 0 && process.geteuid!() > 0, "Run the DMG smoke test as a non-root user")
assert(process.argv.length <= 3, "Usage: bun scripts/smoke-macos-dmg.ts [CookieMonster.dmg]")

const dist = resolve(import.meta.dir, "../dist")
const artifacts = process.argv[2]
  ? [resolve(process.argv[2])]
  : (await readdir(dist)).filter((name) => /^cookiemonster-mac-.*\.dmg$/.test(name)).map((name) => join(dist, name))
assert.equal(artifacts.length, 1, "Expected exactly one cookiemonster-mac-*.dmg in dist; pass a DMG path explicitly")
const dmg = artifacts[0]
assert(dmg && dmg.endsWith(".dmg") && (await lstat(dmg)).isFile(), `Not a DMG file: ${dmg}`)

// Resolve the ASAR reader through the existing electron-builder dependency, including isolated Bun installs.
const builder = createRequire(import.meta.resolve("electron-builder"))
const packaging = createRequire(builder.resolve("app-builder-lib"))
const asar: {
  extractFile: (archive: string, file: string) => Buffer
  listPackage: (archive: string) => string[]
} = packaging("@electron/asar")

const root = await mkdtemp(join(await realpath(homedir()), ".cm-dmg-smoke-"))
const mount = join(root, "DMG Mount")
const applications = join(root, "Applications With Spaces")
const destination = join(applications, "CookieMonster.app")
await mkdir(mount)
try {
  await macCommand("/usr/bin/hdiutil", ["attach", "-readonly", "-nobrowse", "-mountpoint", mount, dmg])
  const source = join(mount, "CookieMonster.app")
  assert((await lstat(source)).isDirectory(), "The DMG must contain CookieMonster.app")
  const expected = await fingerprint(source)

  for (const attempt of [1, 2]) {
    assert.equal(await copyUserApp(source, applications), destination)
    assert.equal(await fingerprint(destination), expected, "Installed bundle differs from the mounted app")
    const resources = join(destination, "Contents", "Resources")
    const cli = join(resources, "opencode-cli")
    assert((await lstat(cli)).isFile(), "The private CLI must remain a regular file")
    await access(cli, constants.X_OK)
    await assert.rejects(lstat(join(resources, "cli")), { code: "ENOENT" })

    const archive = join(resources, "app.asar")
    const metadata = JSON.parse(asar.extractFile(archive, "package.json").toString("utf8"))
    assert.equal(metadata.cmSystemCli, false)
    assert.equal(metadata.cmUserInstall, true)
    assert(
      !asar.listPackage(archive).some((entry) => /^\/resources\/cli(?:\/|$)/.test(entry)),
      "Public CLI found in ASAR",
    )

    const version = (await macCommand(cli, ["--version"])).trim()
    assert(version.length > 0, "The private CLI returned an empty version")
    console.log(`Install ${attempt}: private CLI --version: ${version}`)

    await assert.rejects(copyUserApp(source, applications), { code: "EEXIST" })
    assert.equal(await fingerprint(destination), expected, "Refused reinstall changed the installed bundle")
    await rm(destination, { recursive: true })
    await assert.rejects(lstat(destination), { code: "ENOENT" })
    assert.deepEqual(await readdir(applications), [], "App removal left files in the install directory")
  }
} finally {
  // A failed attach can still leave a mount. If detach fails, retain our directories rather than risk deleting a volume.
  await macCommand("/usr/bin/hdiutil", ["detach", mount]).catch((cause) => {
    throw new Error(`Could not detach ${mount}; retained smoke directory ${root}`, { cause })
  })
  await rm(destination, { recursive: true, force: true })
  await rmdir(applications).catch((error: NodeJS.ErrnoException) => {
    if (error.code !== "ENOENT") throw error
  })
  // Never recursively delete the mountpoint or its parent, even after a successful detach.
  await rmdir(mount).catch((error: NodeJS.ErrnoException) => {
    if (error.code !== "ENOENT") throw error
  })
  await rmdir(root)
}
await assert.rejects(lstat(root), { code: "ENOENT" })
console.log("DMG copy, refusal, removal, recopy and cleanup passed. App startup and WPP were not tested.")

// Include names, modes, file bytes and symlink targets without following bundle symlinks.
async function fingerprint(directory: string): Promise<string> {
  const hash = createHash("sha256")
  for (const name of (await readdir(directory)).sort()) {
    const file = join(directory, name)
    const info = await lstat(file)
    hash.update(JSON.stringify([name, info.mode]))
    if (info.isSymbolicLink()) {
      hash.update(JSON.stringify(await readlink(file)))
      continue
    }
    if (info.isDirectory()) {
      hash.update(await fingerprint(file))
      continue
    }
    assert(info.isFile(), `Unexpected bundle entry: ${file}`)
    const content = createHash("sha256")
    for await (const chunk of createReadStream(file)) content.update(chunk)
    hash.update(content.digest("hex"))
  }
  return hash.digest("hex")
}
