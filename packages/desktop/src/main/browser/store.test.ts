import { expect, test } from "bun:test"
import fs from "node:fs"
import { syncBuiltinESMExports } from "node:module"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { BrowserStore } from "./store"

if (process.env.CM_BROWSER_STORE_TEST !== "1") {
  test("BrowserStore native atomic-write regressions", () => {
    const result = Bun.spawnSync([process.execPath, "test", import.meta.path], {
      cwd: join(import.meta.dir, "../../.."),
      env: { ...process.env, CM_BROWSER_STORE_TEST: "1" },
      stdout: "pipe",
      stderr: "pipe",
      timeout: 20_000,
    })
    expect(result.exitCode, Buffer.concat([result.stdout, result.stderr]).toString()).toBe(0)
  }, 25_000)
} else {
  test.each([
    { platform: "win32", code: "EPERM", failures: 2, attempts: 3, succeeds: true },
    { platform: "win32", code: "EACCES", failures: 2, attempts: 3, succeeds: true },
    { platform: "win32", code: "EBUSY", failures: 2, attempts: 3, succeeds: true },
    { platform: "win32", code: "EPERM", failures: 100, attempts: 5, succeeds: false },
    { platform: "win32", code: "EACCES", failures: 100, attempts: 5, succeeds: false },
    { platform: "win32", code: "EBUSY", failures: 100, attempts: 5, succeeds: false },
    { platform: "win32", code: "EXDEV", failures: 100, attempts: 1, succeeds: false },
    { platform: "win32", code: "ENOENT", failures: 100, attempts: 1, succeeds: false },
    { platform: "win32", code: "EIO", failures: 100, attempts: 1, succeeds: false },
    { platform: "linux", code: "EPERM", failures: 2, attempts: 1, succeeds: false },
  ])("atomic rename $platform $code failures=$failures", (scenario) => {
    const directory = fs.mkdtempSync(join(tmpdir(), "cm-store-rename-"))
    const store = new BrowserStore(join(directory, "store.json"))
    const prior = { settings: { keep: true }, future: [null, 42], __internal__: { version: 1 } }
    const next = { ...prior, downloads: [{ id: "one", state: "interrupted", received: 3 }] }
    const rename = fs.renameSync
    const unlink = fs.unlinkSync
    const open = fs.openSync
    const sync = fs.fsyncSync
    const platform = Object.getOwnPropertyDescriptor(process, "platform")!
    const fault = Object.assign(new Error(`fixture ${scenario.code}`), { code: scenario.code })
    let attempts = 0
    let syncs = 0
    let temporary = ""
    const times: number[] = []
    const removed: string[] = []
    try {
      store.store = prior
      const before = fs.readFileSync(store.path)
      const unrelated = `${store.path}.unrelated.tmp`
      fs.writeFileSync(unrelated, "not owned", { flag: "wx" })
      Object.defineProperty(process, "platform", { ...platform, value: scenario.platform })
      fs.openSync = (path, flags, mode) => {
        expect(String(path)).not.toBe(store.path)
        return open(path, flags, mode)
      }
      fs.fsyncSync = (descriptor) => {
        syncs++
        return sync(descriptor)
      }
      fs.unlinkSync = (path) => {
        expect(String(path)).not.toBe(store.path)
        expect(String(path)).not.toBe(unrelated)
        removed.push(String(path))
        return unlink(path)
      }
      fs.renameSync = (source, target) => {
        expect(String(target)).toBe(store.path)
        attempts++
        times.push(performance.now())
        if (!temporary) temporary = String(source)
        expect(String(source)).toBe(temporary)
        expect(fs.readFileSync(store.path).equals(before)).toBe(true)
        expect(JSON.parse(fs.readFileSync(String(source), "utf8"))).toEqual(next)
        expect(syncs).toBe(1)
        if (attempts <= scenario.failures) throw fault
        return rename(source, target)
      }
      syncBuiltinESMExports()
      const started = performance.now()
      if (scenario.succeeds) store.set("downloads", next.downloads)
      if (!scenario.succeeds) {
        let failure: unknown
        try {
          store.set("downloads", next.downloads)
        } catch (error) {
          failure = error
        }
        expect(failure).toBe(fault)
      }
      const elapsed = performance.now() - started
      expect(attempts).toBe(scenario.attempts)
      expect(elapsed).toBeLessThan(500)
      if (attempts > 1) expect(times.at(-1)! - times[0]).toBeGreaterThanOrEqual(10)
      expect(new BrowserStore(store.path).store).toEqual(scenario.succeeds ? next : prior)
      if (!scenario.succeeds) expect(fs.readFileSync(store.path).equals(before)).toBe(true)
      expect(fs.existsSync(temporary)).toBe(false)
      expect(removed).toEqual(scenario.succeeds ? [] : [temporary])
      expect(fs.readFileSync(unrelated, "utf8")).toBe("not owned")
      expect(fs.readdirSync(directory).sort()).toEqual(["store.json", "store.json.unrelated.tmp"])
    } finally {
      fs.renameSync = rename
      fs.unlinkSync = unlink
      fs.openSync = open
      fs.fsyncSync = sync
      Object.defineProperty(process, "platform", platform)
      syncBuiltinESMExports()
      fs.rmSync(directory, { recursive: true, force: true })
    }
  })

  test("malformed stores, reserved keys and unowned exclusive temps remain protected", () => {
    const directory = fs.mkdtempSync(join(tmpdir(), "cm-store-protections-"))
    const store = new BrowserStore(join(directory, "store.json"))
    const open = fs.openSync
    let collision = ""
    try {
      for (const contents of ["{", "null", "[]", '"text"']) {
        fs.writeFileSync(store.path, contents)
        expect(() => store.set("key", true)).toThrow()
        expect(() => {
          store.store = {}
        }).toThrow()
        expect(() => store.clear()).toThrow()
        expect(fs.readFileSync(store.path, "utf8")).toBe(contents)
      }
      fs.unlinkSync(store.path)
      store.store = { keep: true, __internal__: { version: 1 } }
      for (const key of ["__internal__", "__internal__.version"]) {
        expect(() => store.set(key, "bad")).toThrow("Reserved store key")
        expect(() => store.set({ nested: { [key]: "bad" } })).toThrow("Reserved store key")
      }
      store.clear()
      expect(store.store).toEqual({ __internal__: { version: 1 } })
      const before = fs.readFileSync(store.path)
      fs.openSync = (path, flags, mode) => {
        if (String(path).startsWith(`${store.path}.`) && flags === "wx") {
          collision = String(path)
          const descriptor = open(path, "wx")
          try {
            fs.writeFileSync(descriptor, "competitor")
          } finally {
            fs.closeSync(descriptor)
          }
          return open(path, flags, mode)
        }
        return open(path, flags, mode)
      }
      syncBuiltinESMExports()
      expect(() => store.set("key", true)).toThrow()
      expect(fs.readFileSync(store.path).equals(before)).toBe(true)
      expect(fs.readFileSync(collision, "utf8")).toBe("competitor")
    } finally {
      fs.openSync = open
      syncBuiltinESMExports()
      fs.rmSync(directory, { recursive: true, force: true })
    }
  })
}
