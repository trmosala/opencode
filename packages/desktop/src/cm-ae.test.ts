import { afterEach, expect, test } from "bun:test"
import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"
import { fileURLToPath, pathToFileURL } from "node:url"
import { createHash } from "node:crypto"
import { createRequire } from "node:module"
import { CM_AE_FILES, readCmAeBundle, resolveCmAePlugin, stageCmAeBundle } from "./cm-ae"

const temporary: string[] = []
afterEach(() => {
  for (const dir of temporary.splice(0)) rmSync(dir, { recursive: true, force: true })
})

function fixture() {
  const dir = mkdtempSync(join(tmpdir(), "cm-ae-test-"))
  temporary.push(dir)
  const source = join(dir, "trusted bundle #1")
  mkdirSync(source)
  const permissions = {
    ae_pair: "ask",
    ae_connections: "allow",
    ae_bind: "ask",
    ae_release: "ask",
    ae_inspect: "allow",
    ae_execute: "ask",
    ae_grant: "ask",
    ae_capture: "ask",
    ae_checkpoints: "ask",
    ae_restore: "ask",
    ae_templates: "ask",
    ae_render_list: "allow",
    ae_render_recover: "ask",
    ae_render_submit: "ask",
    ae_render_status: "allow",
    ae_render_cancel: "ask",
    ae_render_retire: "ask",
    ae_render_result: "allow",
    ae_diagnostics: "allow",
    ae_reconcile: "ask",
  }
  // If validation imports or executes either module, it fails and creates a marker.
  const marker = join(dir, "executed")
  const code = `import { writeFileSync } from "node:fs"; writeFileSync(${JSON.stringify(marker)}, "bad"); throw new Error("executed"); export default { id: "cm-ae", server() {} };`
  writeFileSync(join(source, "plugin.mjs"), code)
  writeFileSync(join(source, "render-worker.mjs"), code)
  writeFileSync(join(source, "permissions.json"), JSON.stringify(permissions))
  writeFileSync(join(source, "ZOD-LICENSE.txt"), "fixture license")
  writeFileSync(join(source, "MARKED-LICENSE.txt"), "fixture marked license")
  const desktop = join(dir, "desktop")
  return { dir, source, desktop, stage: join(desktop, "resources", "cm-ae"), permissions, marker }
}

test("stages exactly five validated files byte-for-byte without executing modules", () => {
  const f = fixture()
  expect(stageCmAeBundle(f.source, f.desktop, () => {})).toBe(f.stage)
  expect(readdirSync(f.stage).sort()).toEqual([...CM_AE_FILES].sort())
  for (const name of CM_AE_FILES) expect(readFileSync(join(f.stage, name))).toEqual(readFileSync(join(f.source, name)))
  expect(existsSync(f.marker)).toBe(false)
})

test("unset override stages the default source relative to desktopDir and replaces stale output", () => {
  const f = fixture()
  cpSync(f.source, join(f.desktop, "vendor", "cm-ae"), { recursive: true })
  stageCmAeBundle(f.source, f.desktop, () => {})
  writeFileSync(join(f.stage, "obsolete"), "stale")
  const messages: string[] = []
  expect(stageCmAeBundle(undefined, f.desktop, (message) => messages.push(message))).toBe(f.stage)
  expect(readdirSync(f.stage).sort()).toEqual([...CM_AE_FILES].sort())
  for (const name of CM_AE_FILES) expect(readFileSync(join(f.stage, name))).toEqual(readFileSync(join(f.source, name)))
  expect(messages.join()).toContain("vendored")
})

test("explicit override takes precedence over the default bundle", () => {
  const f = fixture()
  cpSync(f.source, join(f.desktop, "vendor", "cm-ae"), { recursive: true })
  writeFileSync(join(f.source, "ZOD-LICENSE.txt"), "override license")
  stageCmAeBundle(f.source, f.desktop, () => {})
  expect(readFileSync(join(f.stage, "ZOD-LICENSE.txt"), "utf8")).toBe("override license")
  stageCmAeBundle(undefined, f.desktop, () => {})
  expect(readFileSync(join(f.stage, "ZOD-LICENSE.txt"), "utf8")).toBe("fixture license")
})

test("missing or invalid required default fails and clears stale output", () => {
  const f = fixture()
  stageCmAeBundle(f.source, f.desktop, () => {})
  expect(() => stageCmAeBundle(undefined, f.desktop)).toThrow("Required vendored cm-ae bundle")
  expect(existsSync(f.stage)).toBe(false)
  const vendor = join(f.desktop, "vendor", "cm-ae")
  cpSync(f.source, vendor, { recursive: true })
  for (const [name, value] of [
    ["permissions.json", "{}"],
    ["plugin.mjs", "export default {"],
  ]) {
    cpSync(f.source, vendor, { recursive: true })
    stageCmAeBundle(f.source, f.desktop, () => {})
    writeFileSync(join(vendor, name), value)
    expect(() => stageCmAeBundle(undefined, f.desktop)).toThrow()
    expect(existsSync(f.stage)).toBe(false)
  }
})

test("vendored inventory preserves pinned CookieJar 0.2.2 bytes and the Marked license", () => {
  const vendor = fileURLToPath(new URL("../vendor/cm-ae", import.meta.url))
  const hashes = {
    "plugin.mjs": "7497ae855fa97faeb98a4d1255832b4aa0ca76e03e9bcb6eb84718c491191732",
    "render-worker.mjs": "e4d5b9dc7034f8b63f7d66f3a6c121cea1b7bde551591a2f1a75dcddc8e37291",
    "permissions.json": "3b753bb6dc2d2dd513f6500f20f62d8afec47c648a5a4ed981453b190ae2df38",
    "ZOD-LICENSE.txt": "3f1189b28e3866e0d979968d466b78f813f76827cfdca1fbb124cc0a5c8841f8",
    "MARKED-LICENSE.txt": "8e3a3f82f59a60958f56ca08f445647c32a4733dc7ca6c2c46f6eb898471ab9c",
  }
  expect(readdirSync(vendor).sort()).toEqual(Object.keys(hashes).sort())
  const files = readCmAeBundle(vendor)
  expect(files?.length).toBe(5)
  for (const file of files!) expect(createHash("sha256").update(file.data).digest("hex")).toBe(hashes[file.name])
})

test("explicit missing, empty and relative input fail and clear stale output", () => {
  const f = fixture()
  for (const source of [join(f.dir, "missing"), "", "relative"]) {
    stageCmAeBundle(f.source, f.desktop, () => {})
    expect(() => stageCmAeBundle(source, f.desktop)).toThrow("CM_AE_ARTIFACT_DIR")
    expect(existsSync(f.stage)).toBe(false)
  }
})

test("replacement staging removes unexpected stale files", () => {
  const f = fixture()
  stageCmAeBundle(f.source, f.desktop, () => {})
  writeFileSync(join(f.stage, "obsolete"), "old")
  stageCmAeBundle(f.source, f.desktop, () => {})
  expect(existsSync(join(f.stage, "obsolete"))).toBe(false)
})

for (const name of CM_AE_FILES) {
  test(`rejects missing, empty and nonregular ${name}`, () => {
    const f = fixture()
    rmSync(join(f.source, name))
    expect(() => readCmAeBundle(f.source)).toThrow("requires exactly")
    writeFileSync(join(f.source, name), "")
    expect(() => readCmAeBundle(f.source)).toThrow("invalid regular file")
    rmSync(join(f.source, name))
    mkdirSync(join(f.source, name))
    expect(() => readCmAeBundle(f.source)).toThrow("invalid regular file")
  })
}

test("rejects unexpected files and invalid explicit input cannot preserve stale stage", () => {
  const f = fixture()
  stageCmAeBundle(f.source, f.desktop, () => {})
  writeFileSync(join(f.source, "package.json"), "{}")
  expect(() => stageCmAeBundle(f.source, f.desktop)).toThrow("requires exactly")
  expect(existsSync(f.stage)).toBe(false)
})

for (const name of ["plugin.mjs", "render-worker.mjs"]) {
  test(`rejects invalid JavaScript in ${name}`, () => {
    const f = fixture()
    writeFileSync(join(f.source, name), "export default {")
    expect(() => readCmAeBundle(f.source)).toThrow(`syntax check failed: ${name}`)
  })
}

test("checks syntax using Electron's embedded Node without executing artifact code", () => {
  const f = fixture()
  const electronDir = dirname(createRequire(import.meta.url).resolve("electron/package.json"))
  const electron = join(electronDir, "dist", readFileSync(join(electronDir, "path.txt"), "utf8").trim())
  expect(readCmAeBundle(f.source, electron)?.length).toBe(5)
  expect(existsSync(f.marker)).toBe(false)
  writeFileSync(join(f.source, "render-worker.mjs"), "export default {")
  expect(() => readCmAeBundle(f.source, electron)).toThrow("syntax check failed: render-worker.mjs")
})

test("accepts ae_execute allow, ask and deny without executing modules", () => {
  const f = fixture()
  for (const action of ["allow", "ask", "deny"]) {
    writeFileSync(join(f.source, "permissions.json"), JSON.stringify({ ...f.permissions, ae_execute: action }))
    expect(readCmAeBundle(f.source)?.length).toBe(5)
    expect(stageCmAeBundle(f.source, f.desktop, () => {})).toBe(f.stage)
    expect(readFileSync(join(f.stage, "permissions.json"))).toEqual(readFileSync(join(f.source, "permissions.json")))
    expect(existsSync(f.marker)).toBe(false)
  }
})

test("rejects malformed permission data, unknown tools, wildcard policy and unsafe allows", () => {
  const f = fixture()
  const invalid = [
    "",
    "[]",
    "true",
    "{",
    "{}",
    ...Object.entries(f.permissions)
      .filter(([name, action]) => action === "ask" && name !== "ae_execute")
      .map(([name]) => JSON.stringify({ ...f.permissions, [name]: "allow" })),
    JSON.stringify({ ...f.permissions, ae_inspect: "yes" }),
    JSON.stringify({ ...f.permissions, "*": "allow" }),
    JSON.stringify({ ...f.permissions, ae_unknown: "ask" }),
    JSON.stringify({ ...f.permissions, ae_execute: { "*": "ask" } }),
  ]
  for (const value of invalid) {
    writeFileSync(join(f.source, "permissions.json"), value)
    expect(() => readCmAeBundle(f.source)).toThrow()
  }
  writeFileSync(
    join(f.source, "permissions.json"),
    JSON.stringify({ ...f.permissions, ae_execute: "deny", ae_inspect: "deny" }),
  )
  expect(readCmAeBundle(f.source)?.length).toBe(5)
})

test("rejects symlinked bundle directories and entries", () => {
  const f = fixture()
  const link = join(f.dir, "linked")
  symlinkSync(f.source, link, process.platform === "win32" ? "junction" : "dir")
  expect(() => readCmAeBundle(link)).toThrow("regular directory")
  rmSync(join(f.source, "plugin.mjs"))
  symlinkSync(f.desktop, join(f.source, "plugin.mjs"), process.platform === "win32" ? "junction" : "dir")
  expect(() => readCmAeBundle(f.source)).toThrow("invalid regular file")
})

test("refuses source/stage overlap without deleting the source", () => {
  const f = fixture()
  stageCmAeBundle(f.source, f.desktop, () => {})
  for (const source of [f.stage, f.desktop, join(f.stage, "child")]) {
    expect(() => stageCmAeBundle(source, f.desktop)).toThrow("overlap")
    expect(existsSync(join(f.stage, "plugin.mjs"))).toBe(true)
  }
})

test("resolves packaged and dev staged bundles as URL tuples with release metadata", () => {
  const f = fixture()
  stageCmAeBundle(f.source, f.desktop, () => {})
  const warnings: string[] = []
  for (const isPackaged of [true, false]) {
    expect(
      resolveCmAePlugin({
        isPackaged,
        resourcesPath: join(f.desktop, "resources"),
        appPath: f.desktop,
        version: "1.18.27+cm.1",
        warn: (message) => warnings.push(message),
      }),
    ).toEqual([
      pathToFileURL(join(f.stage, "plugin.mjs")).href,
      {
        releaseMetadata: { cookieMonsterVersion: "1.18.27+cm.1" },
      },
    ])
  }
  expect(warnings).toEqual([])
  expect(existsSync(f.marker)).toBe(false)
})

test("runtime warns and omits missing or invalid installed resources, without falling back to dev paths", () => {
  const f = fixture()
  stageCmAeBundle(f.source, f.desktop, () => {})
  const warnings: string[] = []
  const options = {
    isPackaged: true,
    resourcesPath: join(f.dir, "installed"),
    appPath: f.desktop,
    version: "1.18.27",
    warn: (message: string) => warnings.push(message),
  }
  expect(resolveCmAePlugin(options)).toBeUndefined()
  writeFileSync(join(f.stage, "render-worker.mjs"), "export default {")
  expect(resolveCmAePlugin({ ...options, resourcesPath: join(f.desktop, "resources") })).toBeUndefined()
  expect(warnings[0]).toContain("absent")
  expect(warnings[1]).toContain("invalid")
})
