import { execFile } from "node:child_process"
import { constants, type Stats } from "node:fs"
import { lstat, mkdir, mkdtemp, open, readdir, realpath, rename, rm, rmdir, unlink, writeFile } from "node:fs/promises"
import { posix } from "node:path"

export function macCommand(file: string, args: string[], input?: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = execFile(
      file,
      args,
      { encoding: "utf8", timeout: 120_000, maxBuffer: 4 * 1024 * 1024 },
      (error, stdout) => {
        if (error) reject(error)
        else resolve(stdout)
      },
    )
    child.stdin?.on("error", () => {})
    child.stdin?.end(input)
  })
}

export async function diskImageSource(executable: string, run = macCommand) {
  // ponytail: no private translocation APIs; never copy a guessed original bundle.
  if (executable.includes("/AppTranslocation/")) return "manual"
  const source = posix.dirname(posix.dirname(posix.dirname(executable)))
  if (!source.endsWith("/CookieMonster.app")) return "none"
  try {
    const plist = await run("/usr/bin/hdiutil", ["info", "-plist"])
    const info: unknown = JSON.parse(await run("/usr/bin/plutil", ["-convert", "json", "-o", "-", "-"], plist))
    if (!info || typeof info !== "object" || !("images" in info) || !Array.isArray(info.images)) {
      throw new Error("Invalid disk-image information")
    }
    const mounted = info.images.some((image: { "system-entities"?: { "mount-point"?: string }[] }) =>
      image?.["system-entities"]?.some((entity) => {
        const mount = entity["mount-point"]
        return typeof mount === "string" && mount !== "/" && source.startsWith(`${mount}/`)
      }),
    )
    return mounted ? source : "none"
  } catch {
    return source.startsWith("/Volumes/") ? "manual" : "none"
  }
}

export async function copyUserApp(
  source: string,
  applications: string,
  run = macCommand,
  move = rename,
  openDirectory = open,
  remove = rm,
) {
  const destination = posix.join(applications, "CookieMonster.app")
  await mkdir(applications, { recursive: true })
  const existing = await installedApp(destination)
  if (existing && !existing.isDirectory()) throw new Error("Install destination is not a regular directory")
  if (existing && (await realpath(source)) === (await realpath(destination))) {
    throw new Error("Cannot replace the source app")
  }
  // Snapshot completed, owned backups before this install creates any recovery folders.
  const older = (
    existing
      ? await Promise.all(
          (await readdir(applications).catch(() => []))
            .filter((name) => /^CookieMonster Backup-[A-Za-z0-9]{6}$/.test(name))
            .map((name) => readUserAppBackup(posix.join(applications, name)).catch(() => undefined)),
        )
      : []
  ).filter((backup) => backup !== undefined)
  // Copy beside the destination, never merge signed bundles or expose an incomplete app.
  const staging = await mkdtemp(posix.join(applications, "CookieMonster Install-"))
  const incoming = posix.join(staging, "CookieMonster.app")
  await run("/usr/bin/ditto", ["--rsrc", "--extattr", "--acl", source, incoming])
  if (!(await lstat(incoming)).isDirectory()) throw new Error("Copied app is not a regular directory")
  const current = await installedApp(destination)
  if (
    existing
      ? !current || current.dev !== existing.dev || current.ino !== existing.ino || current.mtimeMs !== existing.mtimeMs
      : current
  ) {
    throw new Error("Install destination changed during copying")
  }
  const backup = existing ? await mkdtemp(posix.join(applications, "CookieMonster Backup-")) : undefined
  const record = backup && existing ? userAppBackupRecord(await lstat(backup), existing) : undefined
  try {
    if (backup) await moveUserApp(destination, posix.join(backup, "CookieMonster.app"), move, openDirectory)
    await publishUserApp(incoming, destination, move, openDirectory)
  } catch (error) {
    // Also recover when the backup rename succeeded but handle cleanup failed.
    if (backup) {
      await publishUserApp(posix.join(backup, "CookieMonster.app"), destination, move, openDirectory).catch(() => {})
    }
    throw error
  }
  // Only a fully published replacement makes its previous bundle eligible for later pruning.
  // Metadata and deletion failures must never trigger rollback of a successful publication.
  if (backup && record) {
    await retainUserAppBackup(backup, record, older, openDirectory, remove).catch(() => {})
  }
  await rmdir(staging).catch(() => {})
  return destination
}

function userAppBackupRecord(directory: Stats, app: Stats) {
  return `CookieMonster backup v1\n${directory.dev}:${directory.ino}\n${app.dev}:${app.ino}:${app.mtimeMs}\n`
}

async function retainUserAppBackup(
  path: string,
  record: string,
  older: { path: string; record: string }[],
  openDirectory: typeof open,
  remove: typeof rm,
) {
  const directory = await lstat(path)
  const app = await lstat(posix.join(path, "CookieMonster.app"))
  if (!directory.isDirectory() || !app.isDirectory() || userAppBackupRecord(directory, app) !== record) return
  await writeFile(posix.join(path, ".cookiemonster-backup"), record, { flag: "wx", mode: 0o600 })
  if ((await readUserAppBackup(path))?.record !== record) return
  await Promise.all(older.map((backup) => pruneUserAppBackup(backup, openDirectory, remove).catch(() => {})))
}

async function readUserAppBackup(path: string) {
  const directory = await lstat(path)
  if (!directory.isDirectory()) return undefined
  const entries = await readdir(path)
  if (entries.length !== 2 || !entries.includes("CookieMonster.app") || !entries.includes(".cookiemonster-backup"))
    return undefined
  const app = await lstat(posix.join(path, "CookieMonster.app"))
  if (!app.isDirectory()) return undefined
  const metadata = await lstat(posix.join(path, ".cookiemonster-backup"))
  if (!metadata.isFile() || metadata.size > 256) return undefined
  const marker = await open(
    posix.join(path, ".cookiemonster-backup"),
    constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
  )
  try {
    const info = await marker.stat()
    if (!info.isFile() || info.size > 256) return undefined
    const record = await marker.readFile("utf8")
    if (record !== userAppBackupRecord(directory, app)) return undefined
    return { path, record }
  } finally {
    await marker.close()
  }
}

async function pruneUserAppBackup(
  backup: { path: string; record: string },
  openDirectory: typeof open,
  remove: typeof rm,
) {
  const current = await readUserAppBackup(backup.path)
  if (current?.record !== backup.record) return
  const app = posix.join(backup.path, "CookieMonster.app")
  const directory = await openDirectory(app, constants.O_RDONLY | constants.O_NOFOLLOW)
  try {
    const info = await directory.stat()
    if (userAppBackupRecord(await lstat(backup.path), info) !== backup.record) return
    // As with rename, deleting a read-only bundle root on Darwin requires owner-write.
    try {
      if (!(info.mode & 0o200)) await directory.chmod(info.mode | 0o200)
      await remove(app, { recursive: true })
    } catch (error) {
      if (!(info.mode & 0o200)) await directory.chmod(info.mode).catch(() => {})
      throw error
    }
  } finally {
    await directory.close()
  }
  // Never recursively remove the container: new unrelated entries must survive.
  await unlink(posix.join(backup.path, ".cookiemonster-backup"))
  await rmdir(backup.path)
}

async function installedApp(destination: string) {
  return lstat(destination).catch((error: NodeJS.ErrnoException) => {
    if (error.code !== "ENOENT") throw error
    return undefined
  })
}

async function publishUserApp(source: string, destination: string, move: typeof rename, openDirectory: typeof open) {
  // Refuse an occupied name; plain rename does not protect against later reservation replacement.
  await mkdir(destination)
  const reservation = await lstat(destination)
  try {
    await moveUserApp(source, destination, move, openDirectory)
  } catch (error) {
    const current = await installedApp(destination)
    if (current?.dev === reservation.dev && current.ino === reservation.ino) {
      await rmdir(destination).catch(() => {})
    }
    throw error
  }
}

async function moveUserApp(source: string, destination: string, move: typeof rename, openDirectory: typeof open) {
  const directory = await openDirectory(source, constants.O_RDONLY | constants.O_NOFOLLOW)
  let failed = false
  try {
    const info = await directory.stat()
    if (!info.isDirectory()) throw new Error("App to move is not a regular directory")
    // Darwin requires write access to a moved directory's root. Restore through the handle, not a raced path.
    try {
      if (!(info.mode & 0o200)) await directory.chmod(info.mode | 0o200)
      await move(source, destination)
    } catch (error) {
      failed = true
      throw error
    } finally {
      if (!(info.mode & 0o200)) {
        await directory.chmod(info.mode).catch((error) => {
          if (!failed) throw error
        })
      }
    }
  } catch (error) {
    failed = true
    throw error
  } finally {
    // Cleanup failures must not hide the original move or permission failure.
    await directory.close().catch((error) => {
      if (!failed) throw error
    })
  }
}

type Installer = {
  executable: string
  applications: string
  confirm: (destination: string) => Promise<boolean>
  manual: (destination: string) => Promise<void>
  failed: (destination: string) => Promise<void>
  releaseLock: () => void
  quit: () => void
  run?: typeof macCommand
  copy?: typeof copyUserApp
}

export async function installFromDiskImage(options: Installer) {
  const source = await diskImageSource(options.executable, options.run)
  if (source === "none") return false
  const destination = posix.join(options.applications, "CookieMonster.app")
  if (source === "manual") {
    await options.manual(destination)
    options.quit()
    return true
  }
  if (!(await options.confirm(destination))) {
    options.quit()
    return true
  }
  try {
    await (options.copy ?? copyUserApp)(source, options.applications, options.run)
    // The installed process must acquire the same lock before starting its sidecar.
    options.releaseLock()
    await (options.run ?? macCommand)("/usr/bin/open", ["-n", destination])
  } catch {
    await options.failed(destination)
  }
  options.quit()
  return true
}
