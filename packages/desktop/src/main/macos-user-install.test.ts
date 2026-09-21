import { expect, test } from "bun:test"
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises"
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
      await diskImageSource("/Users/me/Applications/CookieMonster.app/Contents/MacOS/CookieMonster", async () => result),
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

test("reserves destination exclusively and retains failed copies without touching existing apps", async () => {
  const root = await mkdtemp(join(tmpdir(), "cm-install-test-"))
  const applications = join(root, "Applications")
  const destination = join(applications, "CookieMonster.app")
  const calls: string[][] = []
  try {
    await copyUserApp("/source/CookieMonster.app", applications, async (file, args) => {
      calls.push([file, ...args])
      return ""
    })
    expect(calls[0]?.slice(0, 5)).toEqual([
      "/usr/bin/ditto",
      "--rsrc",
      "--extattr",
      "--acl",
      "/source/CookieMonster.app",
    ])
    await writeFile(join(destination, "sentinel"), "existing")
    await expect(copyUserApp("/source/CookieMonster.app", applications, run)).rejects.toThrow()
    expect(await readFile(join(destination, "sentinel"), "utf8")).toBe("existing")
    const failed = join(root, "Failed")
    await expect(
      copyUserApp("/source/CookieMonster.app", failed, async () => {
        throw new Error("disk full")
      }),
    ).rejects.toThrow("disk full")
    await expect(mkdir(join(failed, "CookieMonster.app"))).rejects.toThrow()
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})
