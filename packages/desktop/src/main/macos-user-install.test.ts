import { expect, test } from "bun:test"
import {
  chmod,
  cp,
  lstat,
  mkdtemp,
  mkdir,
  open,
  readdir,
  readFile,
  readlink,
  rename,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { copyUserApp, diskImageSource, installFromDiskImage } from "./macos-user-install"

const executable = "/Volumes/CM/CookieMonster.app/Contents/MacOS/CookieMonster"
const info = JSON.stringify({ images: [{ "system-entities": [{ "mount-point": "/Volumes/CM" }] }] })
const run = async () => info

test("only identifies actual disk-image mounts, with path boundaries", async () => {
  expect(await diskImageSource(executable, run)).toBe("/Volumes/CM/CookieMonster.app")
  expect(await diskImageSource(executable.replace("/CM/", "/CM-other/"), run)).toBe("none")
  expect(await diskImageSource("/Users/me/Applications/CookieMonster.app/Contents/MacOS/CookieMonster", run)).toBe(
    "none",
  )
  expect(await diskImageSource(executable, async () => '{"images":[]}')).toBe("none")
  expect(await diskImageSource(executable, async () => "invalid")).toBe("manual")
  for (const result of ["invalid", "{}"]) {
    expect(
      await diskImageSource(
        "/Users/me/Applications/CookieMonster.app/Contents/MacOS/CookieMonster",
        async () => result,
      ),
    ).toBe("none")
  }
  expect(
    await diskImageSource("/private/var/AppTranslocation/id/d/CookieMonster.app/Contents/MacOS/CookieMonster", run),
  ).toBe("manual")
})

test("confirmation, failure handling and lock handoff precede launch", async () => {
  for (const scenario of ["success", "cancel", "copy-fails", "open-fails", "manual", "installed"]) {
    const events: string[] = []
    const handled = await installFromDiskImage({
      executable:
        scenario === "manual"
          ? "/private/var/AppTranslocation/id/d/CookieMonster.app/Contents/MacOS/CookieMonster"
          : scenario === "installed"
            ? executable.replace("/Volumes/CM", "/Applications")
            : executable,
      applications: "/Users/me/Applications",
      confirm: async () => {
        events.push("confirm")
        return scenario !== "cancel"
      },
      manual: async () => {
        events.push("manual")
      },
      failed: async () => {
        events.push("failed")
      },
      releaseLock: () => {
        events.push("release")
      },
      quit: () => {
        events.push("quit")
      },
      copy: async () => {
        events.push("copy")
        if (scenario === "copy-fails") throw new Error("copy")
        return "/Users/me/Applications/CookieMonster.app"
      },
      run: async (file, args) => {
        if (file !== "/usr/bin/open") return info
        expect(args).toEqual(["-n", "/Users/me/Applications/CookieMonster.app"])
        events.push("open")
        if (scenario === "open-fails") throw new Error("open")
        return ""
      },
    })
    expect(handled).toBe(scenario !== "installed")
    expect(events).toEqual(
      scenario === "installed"
        ? []
        : scenario === "manual"
          ? ["manual", "quit"]
          : scenario === "cancel"
            ? ["confirm", "quit"]
            : scenario === "copy-fails"
              ? ["confirm", "copy", "failed", "quit"]
              : scenario === "open-fails"
                ? ["confirm", "copy", "release", "open", "failed", "quit"]
                : ["confirm", "copy", "release", "open", "quit"],
    )
  }
})

test("replaces the whole app, retains the previous bundle and preserves unrelated data", async () => {
  const root = await mkdtemp(join(tmpdir(), "cm-install-test-"))
  const source = join(root, "Source", "CookieMonster.app")
  const applications = join(root, "Applications With Spaces")
  const destination = join(applications, "CookieMonster.app")
  const calls: string[][] = []
  try {
    await mkdir(source, { recursive: true })
    await writeFile(join(source, "version"), "new")
    const copy = async (file: string, args: string[]) => {
      calls.push([file, ...args])
      await cp(args[3], args[4], { recursive: true })
      return ""
    }
    expect(await copyUserApp(source, applications, copy)).toBe(destination)
    expect(calls[0]?.slice(0, 5)).toEqual(["/usr/bin/ditto", "--rsrc", "--extattr", "--acl", source])
    expect(calls[0]?.[5]).not.toBe(destination)
    await writeFile(join(destination, "version"), "old")
    await writeFile(join(destination, "sentinel"), "existing")
    await writeFile(join(applications, "settings"), "untouched")
    expect(await copyUserApp(source, applications, copy)).toBe(destination)
    expect(await readFile(join(destination, "version"), "utf8")).toBe("new")
    await expect(lstat(join(destination, "sentinel"))).rejects.toMatchObject({ code: "ENOENT" })
    const backups = (await readdir(applications)).filter((name) => name.startsWith("CookieMonster Backup-"))
    expect(backups).toHaveLength(1)
    expect(await readFile(join(applications, backups[0], "CookieMonster.app", "version"), "utf8")).toBe("old")
    expect(await readFile(join(applications, backups[0], "CookieMonster.app", "sentinel"), "utf8")).toBe("existing")
    expect(await readFile(join(applications, "settings"), "utf8")).toBe("untouched")
    expect((await readdir(applications)).some((name) => name.startsWith("CookieMonster Install-"))).toBe(false)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test("moves read-only bundle roots and restores their modes without changing the source", async () => {
  const root = await mkdtemp(join(tmpdir(), "cm-install-test-"))
  const source = join(root, "Source")
  const destination = join(root, "CookieMonster.app")
  try {
    await mkdir(source)
    await writeFile(join(source, "version"), "new")
    await chmod(source, 0o555)
    for (const attempt of [1, 2, 3, 4]) {
      await writeFile(join(source, "version"), String(attempt))
      const moves: string[] = []
      await copyUserApp(
        source,
        root,
        async (_file, args) => {
          await cp(args[3], args[4], { recursive: true })
          await chmod(args[4], 0o555)
          return ""
        },
        async (from, to) => {
          expect((await lstat(from)).mode & 0o777).toBe(0o755)
          moves.push(String(from))
          await rename(from, to)
        },
      )
      expect(moves).toHaveLength(attempt === 1 ? 1 : 2)
      expect((await lstat(source)).mode & 0o777).toBe(0o555)
      expect((await lstat(destination)).mode & 0o777).toBe(0o555)
      expect(await readFile(join(destination, "version"), "utf8")).toBe(String(attempt))
      const backups = (await readdir(root)).filter((name) => name.startsWith("CookieMonster Backup-"))
      expect(backups).toHaveLength(attempt === 1 ? 0 : 1)
      if (attempt > 1) {
        expect(await readFile(join(root, backups[0], "CookieMonster.app", "version"), "utf8")).toBe(String(attempt - 1))
        expect((await lstat(join(root, backups[0], "CookieMonster.app"))).mode & 0o777).toBe(0o555)
      }
    }
    const backup = (await readdir(root)).find((name) => name.startsWith("CookieMonster Backup-"))
    if (!backup) throw new Error("Missing previous bundle")
    expect((await lstat(join(root, backup, "CookieMonster.app"))).mode & 0o777).toBe(0o555)
  } finally {
    await chmod(source, 0o755)
    await chmod(destination, 0o755).catch(() => {})
    for (const name of (await readdir(root)).filter((name) => /CookieMonster (?:Backup|Install)-/.test(name))) {
      await chmod(join(root, name, "CookieMonster.app"), 0o755).catch(() => {})
    }
    await rm(root, { recursive: true, force: true })
  }
})

test("backup cleanup is best-effort and retries after a later successful replacement", async () => {
  const root = await mkdtemp(join(tmpdir(), "cm-install-test-"))
  const source = join(root, "Source")
  const destination = join(root, "CookieMonster.app")
  const copy = async (_file: string, args: string[]) => {
    await cp(args[3], args[4], { recursive: true })
    await chmod(args[4], 0o555)
    return ""
  }
  try {
    await mkdir(source)
    await writeFile(join(source, "version"), "1")
    await copyUserApp(source, root, copy)
    await writeFile(join(source, "version"), "2")
    await copyUserApp(source, root, copy)
    const older = (await readdir(root)).find((name) => name.startsWith("CookieMonster Backup-"))
    if (!older) throw new Error("Missing older backup")
    const cleanup: { path: string; backupMode: number; installedMode: number; installedVersion: string }[] = []
    await writeFile(join(source, "version"), "3")
    expect(
      await copyUserApp(source, root, copy, rename, open, async (path) => {
        cleanup.push({
          path: String(path),
          backupMode: (await lstat(path)).mode & 0o777,
          installedMode: (await lstat(destination)).mode & 0o777,
          installedVersion: await readFile(join(destination, "version"), "utf8"),
        })
        throw new Error("cleanup denied")
      }),
    ).toBe(destination)
    expect(cleanup).toEqual([
      {
        path: join(root, older, "CookieMonster.app"),
        backupMode: 0o755,
        installedMode: 0o555,
        installedVersion: "3",
      },
    ])
    expect((await readdir(root)).filter((name) => name.startsWith("CookieMonster Backup-"))).toHaveLength(2)
    expect((await lstat(join(root, older, "CookieMonster.app"))).mode & 0o777).toBe(0o555)
    expect(await readFile(join(root, older, "CookieMonster.app", "version"), "utf8")).toBe("1")
    await writeFile(join(source, "version"), "4")
    await copyUserApp(source, root, copy)
    const backups = (await readdir(root)).filter((name) => name.startsWith("CookieMonster Backup-"))
    expect(backups).toHaveLength(1)
    expect(await readFile(join(root, backups[0], "CookieMonster.app", "version"), "utf8")).toBe("3")
  } finally {
    await chmod(destination, 0o755).catch(() => {})
    for (const name of (await readdir(root)).filter((name) => name.startsWith("CookieMonster Backup-"))) {
      await chmod(join(root, name, "CookieMonster.app"), 0o755).catch(() => {})
    }
    await rm(root, { recursive: true, force: true })
  }
})

test("pruning leaves unowned, changed, symlinked and unrelated backup candidates alone", async () => {
  for (const change of [
    "unmarked",
    "extra",
    "record",
    "marker-directory",
    "oversized",
    "marker-link",
    "app-link",
    "container-link",
    "during-copy",
    "bundle-changed",
  ]) {
    const root = await mkdtemp(join(tmpdir(), "cm-install-test-"))
    const source = join(root, "Source")
    const copy = async (_file: string, args: string[]) => {
      await cp(args[3], args[4], { recursive: true })
      return ""
    }
    try {
      await mkdir(source)
      await writeFile(join(source, "version"), "1")
      await copyUserApp(source, root, copy)
      await writeFile(join(source, "version"), "2")
      await copyUserApp(source, root, copy)
      const name = (await readdir(root)).find((name) => name.startsWith("CookieMonster Backup-"))
      if (!name) throw new Error("Missing backup candidate")
      const candidate = join(root, name)
      const marker = join(candidate, ".cookiemonster-backup")
      const target = join(root, "Private")
      await mkdir(target)
      await writeFile(join(target, "sentinel"), "unrelated")
      await mkdir(join(root, "CookieMonster Install-private"))
      await writeFile(join(root, "CookieMonster Install-private", "partial"), "staging")
      if (change === "unmarked") await rm(marker)
      if (change === "extra") await writeFile(join(candidate, "sentinel"), "user")
      if (change === "record") await writeFile(marker, "not an ownership record")
      if (change === "oversized") await writeFile(marker, "x".repeat(257))
      if (change === "marker-directory") {
        await rm(marker)
        await mkdir(marker)
      }
      if (change === "marker-link") {
        await rename(marker, join(target, "marker"))
        await symlink(join(target, "marker"), marker)
      }
      if (change === "app-link") {
        await rename(join(candidate, "CookieMonster.app"), join(target, "CookieMonster.app"))
        await symlink(join(target, "CookieMonster.app"), join(candidate, "CookieMonster.app"))
      }
      if (change === "container-link") {
        await rename(candidate, join(target, "Backup"))
        await symlink(join(target, "Backup"), candidate)
      }
      await writeFile(join(source, "version"), "3")
      await copyUserApp(source, root, async (file, args) => {
        await copy(file, args)
        if (change === "during-copy") await writeFile(join(candidate, "sentinel"), "user")
        if (change === "bundle-changed") {
          await rename(join(candidate, "CookieMonster.app"), join(target, "Original.app"))
          await cp(join(target, "Original.app"), join(candidate, "CookieMonster.app"), { recursive: true })
        }
        return ""
      })
      expect((await readdir(root)).filter((entry) => entry.startsWith("CookieMonster Backup-"))).toHaveLength(2)
      expect(await readFile(join(target, "sentinel"), "utf8")).toBe("unrelated")
      expect(await readFile(join(root, "CookieMonster Install-private", "partial"), "utf8")).toBe("staging")
      expect(await readFile(join(candidate, "CookieMonster.app", "version"), "utf8")).toBe("1")
      if (change === "container-link") expect((await lstat(candidate)).isSymbolicLink()).toBe(true)
      if (change === "app-link") expect((await lstat(join(candidate, "CookieMonster.app"))).isSymbolicLink()).toBe(true)
      if (change === "marker-link") expect((await lstat(marker)).isSymbolicLink()).toBe(true)
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  }
})

test("backup ownership-write failure leaves older backups without failing the published install", async () => {
  const root = await mkdtemp(join(tmpdir(), "cm-install-test-"))
  const source = join(root, "Source")
  const destination = join(root, "CookieMonster.app")
  const copy = async (_file: string, args: string[]) => {
    await cp(args[3], args[4], { recursive: true })
    return ""
  }
  try {
    await mkdir(source)
    await writeFile(join(source, "version"), "1")
    await copyUserApp(source, root, copy)
    await writeFile(join(source, "version"), "2")
    await copyUserApp(source, root, copy)
    const older = (await readdir(root)).find((name) => name.startsWith("CookieMonster Backup-"))
    if (!older) throw new Error("Missing completed backup")
    await writeFile(join(source, "version"), "3")
    expect(
      await copyUserApp(source, root, copy, async (from, to) => {
        await rename(from, to)
        if (String(to).includes("CookieMonster Backup-")) {
          await writeFile(join(String(to), "..", ".cookiemonster-backup"), "user data")
        }
      }),
    ).toBe(destination)
    expect(await readFile(join(destination, "version"), "utf8")).toBe("3")
    expect(await readFile(join(root, older, "CookieMonster.app", "version"), "utf8")).toBe("1")
    const backups = (await readdir(root)).filter((name) => name.startsWith("CookieMonster Backup-"))
    expect(backups).toHaveLength(2)
    const latest = backups.find((name) => name !== older)
    if (!latest) throw new Error("Missing immediately previous backup")
    expect(await readFile(join(root, latest, ".cookiemonster-backup"), "utf8")).toBe("user data")
    expect(await readFile(join(root, latest, "CookieMonster.app", "version"), "utf8")).toBe("2")
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test("failed staging, moves, permission cleanup and recovery never prune completed backups", async () => {
  for (const failure of ["staging", "backup", "publication", "recovery", "chmod", "close"]) {
    const root = await mkdtemp(join(tmpdir(), "cm-install-test-"))
    const source = join(root, "Source")
    const destination = join(root, "CookieMonster.app")
    const copy = async (_file: string, args: string[]) => {
      await cp(args[3], args[4], { recursive: true })
      await chmod(args[4], 0o555)
      return ""
    }
    const removed: string[] = []
    try {
      await mkdir(source)
      await writeFile(join(source, "version"), "1")
      await copyUserApp(source, root, copy)
      await writeFile(join(source, "version"), "2")
      await copyUserApp(source, root, copy)
      const older = (await readdir(root)).find((name) => name.startsWith("CookieMonster Backup-"))
      if (!older) throw new Error("Missing completed backup")
      await writeFile(join(source, "version"), "3")
      await expect(
        copyUserApp(
          source,
          root,
          async (file, args) => {
            await copy(file, args)
            if (failure === "staging") throw new Error(failure)
            return ""
          },
          async (from, to) => {
            if (failure === "backup" && String(from) === destination) throw new Error(failure)
            if (["publication", "recovery"].includes(failure) && String(from).includes("CookieMonster Install-")) {
              throw new Error(failure)
            }
            if (failure === "recovery" && String(from).includes("CookieMonster Backup-")) throw new Error(failure)
            await rename(from, to)
          },
          async (path, flags, mode) => {
            const directory = await open(path, flags, mode)
            if (!String(path).includes("CookieMonster Install-")) return directory
            const applyMode = directory.chmod.bind(directory)
            const close = directory.close.bind(directory)
            directory.chmod = async (mode) => {
              if (failure === "chmod" && !(Number(mode) & 0o200)) throw new Error(failure)
              await applyMode(mode)
            }
            directory.close = async () => {
              await close()
              if (failure === "close") throw new Error(failure)
            }
            return directory
          },
          async (path, options) => {
            removed.push(String(path))
            await rm(path, options)
          },
        ),
      ).rejects.toThrow(failure)
      expect(removed).toEqual([])
      expect(await readFile(join(root, older, "CookieMonster.app", "version"), "utf8")).toBe("1")
      expect((await lstat(join(root, older, "CookieMonster.app"))).mode & 0o777).toBe(0o555)
      const recovery = (await readdir(root)).filter(
        (name) => name.startsWith("CookieMonster Backup-") && name !== older,
      )
      for (const name of recovery) {
        await expect(lstat(join(root, name, ".cookiemonster-backup"))).rejects.toMatchObject({ code: "ENOENT" })
      }
      // Even a later successful replacement must leave failed-install recovery bundles unmarked and intact.
      if (failure === "recovery") {
        const saved = join(root, recovery[0], "CookieMonster.app")
        expect(await readFile(join(saved, "version"), "utf8")).toBe("2")
        await copyUserApp(source, root, copy)
        await writeFile(join(source, "version"), "4")
        await copyUserApp(source, root, copy)
        expect(await readFile(join(saved, "version"), "utf8")).toBe("2")
      }
    } finally {
      await chmod(destination, 0o755).catch(() => {})
      for (const name of (await readdir(root)).filter((name) => /CookieMonster (?:Backup|Install)-/.test(name))) {
        await chmod(join(root, name, "CookieMonster.app"), 0o755).catch(() => {})
      }
      await rm(root, { recursive: true, force: true })
    }
  }
})

test("backup handle cleanup failures restore the moved app before reporting failure", async () => {
  for (const failure of ["chmod", "close"]) {
    const root = await mkdtemp(join(tmpdir(), "cm-install-test-"))
    const source = join(root, "Source")
    const destination = join(root, "CookieMonster.app")
    const moves: string[] = []
    try {
      await mkdir(source)
      await writeFile(join(source, "version"), "new")
      await mkdir(destination)
      await writeFile(join(destination, "version"), "old")
      await chmod(destination, 0o555)
      await expect(
        copyUserApp(
          source,
          root,
          async (_file, args) => {
            await cp(args[3], args[4], { recursive: true })
            return ""
          },
          async (from, to) => {
            moves.push(String(from))
            await rename(from, to)
          },
          async (path, flags, mode) => {
            const directory = await open(path, flags, mode)
            if (String(path) !== destination) return directory
            const applyMode = directory.chmod.bind(directory)
            const close = directory.close.bind(directory)
            directory.chmod = async (mode) => {
              if (failure === "chmod" && !(Number(mode) & 0o200)) throw new Error("mode restore failed")
              await applyMode(mode)
            }
            directory.close = async () => {
              await close()
              if (failure === "close") throw new Error("handle close failed")
            }
            return directory
          },
        ),
      ).rejects.toThrow(failure === "chmod" ? "mode restore failed" : "handle close failed")
      expect(moves).toHaveLength(2)
      expect(moves[1]).toContain("CookieMonster Backup-")
      expect(await readFile(join(destination, "version"), "utf8")).toBe("old")
      // A failed fchmod can leave owner-write enabled; recovery must still restore the bundle.
      expect((await lstat(destination)).mode & 0o777).toBe(failure === "chmod" ? 0o755 : 0o555)
      const backup = (await readdir(root)).find((name) => name.startsWith("CookieMonster Backup-"))
      const staging = (await readdir(root)).find((name) => name.startsWith("CookieMonster Install-"))
      if (!backup || !staging) throw new Error("Missing recovery folders")
      await expect(lstat(join(root, backup, "CookieMonster.app"))).rejects.toMatchObject({ code: "ENOENT" })
      expect(await readFile(join(root, staging, "CookieMonster.app", "version"), "utf8")).toBe("new")
    } finally {
      await chmod(destination, 0o755).catch(() => {})
      await rm(root, { recursive: true, force: true })
    }
  }
})

test("publication handle cleanup failures retain the complete new app and any previous backup", async () => {
  for (const existing of [false, true]) {
    for (const failure of ["chmod", "close"]) {
      const root = await mkdtemp(join(tmpdir(), "cm-install-test-"))
      const source = join(root, "Source")
      const destination = join(root, "CookieMonster.app")
      try {
        await mkdir(source)
        await writeFile(join(source, "version"), "new")
        if (existing) {
          await mkdir(destination)
          await writeFile(join(destination, "version"), "old")
          await chmod(destination, 0o555)
        }
        await expect(
          copyUserApp(
            source,
            root,
            async (_file, args) => {
              await cp(args[3], args[4], { recursive: true })
              await chmod(args[4], 0o555)
              return ""
            },
            rename,
            async (path, flags, mode) => {
              const directory = await open(path, flags, mode)
              if (!String(path).includes("CookieMonster Install-")) return directory
              const applyMode = directory.chmod.bind(directory)
              const close = directory.close.bind(directory)
              directory.chmod = async (mode) => {
                if (failure === "chmod" && !(Number(mode) & 0o200)) throw new Error("mode restore failed")
                await applyMode(mode)
              }
              directory.close = async () => {
                await close()
                if (failure === "close") throw new Error("handle close failed")
              }
              return directory
            },
          ),
        ).rejects.toThrow(failure === "chmod" ? "mode restore failed" : "handle close failed")
        expect(await readFile(join(destination, "version"), "utf8")).toBe("new")
        expect((await lstat(destination)).mode & 0o777).toBe(failure === "chmod" ? 0o755 : 0o555)
        const backups = (await readdir(root)).filter((name) => name.startsWith("CookieMonster Backup-"))
        expect(backups).toHaveLength(existing ? 1 : 0)
        if (existing) {
          expect(await readFile(join(root, backups[0], "CookieMonster.app", "version"), "utf8")).toBe("old")
          expect((await lstat(join(root, backups[0], "CookieMonster.app"))).mode & 0o777).toBe(0o555)
        }
      } finally {
        await chmod(destination, 0o755).catch(() => {})
        for (const name of (await readdir(root)).filter((name) => name.startsWith("CookieMonster Backup-"))) {
          await chmod(join(root, name, "CookieMonster.app"), 0o755).catch(() => {})
        }
        await rm(root, { recursive: true, force: true })
      }
    }
  }
})

test("permission and move failures are not masked by mode restoration or handle close failures", async () => {
  for (const failure of ["chmod", "rename"]) {
    const root = await mkdtemp(join(tmpdir(), "cm-install-test-"))
    const source = join(root, "Source")
    const destination = join(root, "CookieMonster.app")
    const modes: number[] = []
    const moves: string[] = []
    const closed: string[] = []
    try {
      await mkdir(source)
      await writeFile(join(source, "version"), "new")
      await mkdir(destination)
      await writeFile(join(destination, "version"), "old")
      await chmod(destination, 0o555)
      await expect(
        copyUserApp(
          source,
          root,
          async (_file, args) => {
            await cp(args[3], args[4], { recursive: true })
            return ""
          },
          async (from) => {
            moves.push(String(from))
            throw new Error("rename failed")
          },
          async (path, flags, mode) => {
            const directory = await open(path, flags, mode)
            const applyMode = directory.chmod.bind(directory)
            const close = directory.close.bind(directory)
            directory.chmod = async (mode) => {
              modes.push(Number(mode) & 0o777)
              if (!(Number(mode) & 0o200)) throw new Error("mode restore failed")
              if (failure === "chmod") throw new Error("make writable failed")
              await applyMode(mode)
            }
            directory.close = async () => {
              await close()
              closed.push(String(path))
              throw new Error("handle close failed")
            }
            return directory
          },
        ),
      ).rejects.toThrow(failure === "chmod" ? "make writable failed" : "rename failed")
      expect(modes).toEqual([0o755, 0o555])
      expect(moves).toHaveLength(failure === "chmod" ? 0 : 1)
      expect(closed).toEqual([destination])
      expect(await readFile(join(destination, "version"), "utf8")).toBe("old")
    } finally {
      await chmod(destination, 0o755).catch(() => {})
      await rm(root, { recursive: true, force: true })
    }
  }
})

test("failed staging copies leave the installed app intact and can be retried", async () => {
  const root = await mkdtemp(join(tmpdir(), "cm-install-test-"))
  const source = join(root, "Source")
  const destination = join(root, "CookieMonster.app")
  try {
    await mkdir(source)
    await writeFile(join(source, "version"), "new")
    await mkdir(destination)
    await writeFile(join(destination, "version"), "old")
    await expect(
      copyUserApp(source, root, async (_file, args) => {
        await mkdir(args[4])
        await writeFile(join(args[4], "partial"), "incomplete")
        throw new Error("disk full")
      }),
    ).rejects.toThrow("disk full")
    expect(await readFile(join(destination, "version"), "utf8")).toBe("old")
    expect((await readdir(root)).some((name) => name.startsWith("CookieMonster Backup-"))).toBe(false)
    await copyUserApp(source, root, async (_file, args) => {
      await cp(args[3], args[4], { recursive: true })
      return ""
    })
    expect(await readFile(join(destination, "version"), "utf8")).toBe("new")
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test("rejects files, live and dangling symlinks without following or changing them", async () => {
  const root = await mkdtemp(join(tmpdir(), "cm-install-test-"))
  const destination = join(root, "CookieMonster.app")
  const target = join(root, "Target")
  try {
    await mkdir(target)
    await writeFile(join(target, "sentinel"), "untouched")
    await writeFile(destination, "not an app")
    await expect(copyUserApp(target, root, run)).rejects.toThrow("not a regular directory")
    expect(await readFile(destination, "utf8")).toBe("not an app")
    await rm(destination)
    for (const link of [target, join(root, "Missing")]) {
      await symlink(link, destination)
      await expect(copyUserApp(target, root, run)).rejects.toThrow("not a regular directory")
      expect(await readlink(destination)).toBe(link)
      await rm(destination)
    }
    expect(await readFile(join(target, "sentinel"), "utf8")).toBe("untouched")
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test("rejects self-replacement and destinations changed while copying", async () => {
  const root = await mkdtemp(join(tmpdir(), "cm-install-test-"))
  const source = join(root, "Source")
  const destination = join(root, "CookieMonster.app")
  try {
    await mkdir(source)
    await mkdir(destination)
    await expect(copyUserApp(destination, root, run)).rejects.toThrow("Cannot replace the source app")
    for (const existing of [true, false]) {
      await expect(
        copyUserApp(source, root, async (_file, args) => {
          await cp(args[3], args[4], { recursive: true })
          if (existing) await rm(destination, { recursive: true })
          await symlink(source, destination)
          return ""
        }),
      ).rejects.toThrow("changed during copying")
      expect(await readlink(destination)).toBe(source)
      await rm(destination)
    }
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test("concurrent first installs publish only one complete bundle", async () => {
  const root = await mkdtemp(join(tmpdir(), "cm-install-test-"))
  const source = join(root, "Source")
  const destination = join(root, "CookieMonster.app")
  try {
    await mkdir(source)
    await writeFile(join(source, "version"), "complete")
    const results = await Promise.allSettled(
      [1, 2].map(() =>
        copyUserApp(source, root, async (_file, args) => {
          await cp(args[3], args[4], { recursive: true })
          return ""
        }),
      ),
    )
    expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1)
    expect(results.filter((result) => result.status === "rejected")).toHaveLength(1)
    expect(await readFile(join(destination, "version"), "utf8")).toBe("complete")
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test("publication failures restore the old app or retain its backup without overwriting concurrent data", async () => {
  for (const scenario of ["restore", "restore-fails", "concurrent-destination"]) {
    const root = await mkdtemp(join(tmpdir(), "cm-install-test-"))
    const source = join(root, "Source")
    const destination = join(root, "CookieMonster.app")
    try {
      await mkdir(source)
      await writeFile(join(source, "version"), "new")
      await mkdir(destination)
      await writeFile(join(destination, "version"), "old")
      await chmod(destination, 0o555)
      await expect(
        copyUserApp(
          source,
          root,
          async (_file, args) => {
            await cp(args[3], args[4], { recursive: true })
            return ""
          },
          async (from, to) => {
            expect((await lstat(from)).mode & 0o200).toBe(0o200)
            if (String(from).includes("CookieMonster Install-")) {
              if (scenario === "concurrent-destination") await writeFile(join(destination, "sentinel"), "concurrent")
              throw new Error("publication failed")
            }
            if (scenario === "restore-fails" && String(from).includes("CookieMonster Backup-")) {
              throw new Error("restoration failed")
            }
            await rename(from, to)
          },
        ),
      ).rejects.toThrow("publication failed")
      const backup = (await readdir(root)).find((name) => name.startsWith("CookieMonster Backup-"))
      expect(backup).toBeDefined()
      if (!backup) throw new Error("Missing previous bundle")
      if (scenario === "restore") {
        expect(await readFile(join(destination, "version"), "utf8")).toBe("old")
        expect((await lstat(destination)).mode & 0o777).toBe(0o555)
        await expect(lstat(join(root, backup, "CookieMonster.app"))).rejects.toMatchObject({ code: "ENOENT" })
        continue
      }
      expect(await readFile(join(root, backup, "CookieMonster.app", "version"), "utf8")).toBe("old")
      expect((await lstat(join(root, backup, "CookieMonster.app"))).mode & 0o777).toBe(0o555)
      if (scenario === "restore-fails") {
        await expect(lstat(destination)).rejects.toMatchObject({ code: "ENOENT" })
        continue
      }
      expect(await readFile(join(destination, "sentinel"), "utf8")).toBe("concurrent")
    } finally {
      await chmod(destination, 0o755).catch(() => {})
      for (const name of (await readdir(root)).filter((name) => name.startsWith("CookieMonster Backup-"))) {
        await chmod(join(root, name, "CookieMonster.app"), 0o755).catch(() => {})
      }
      await rm(root, { recursive: true, force: true })
    }
  }
})
