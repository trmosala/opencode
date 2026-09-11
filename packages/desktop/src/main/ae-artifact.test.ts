import { expect, test } from "bun:test"
import { cp, mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { fileURLToPath, pathToFileURL } from "node:url"
import { CM_AE_FILES, resolveCmAePlugin, stageCmAeBundle } from "../cm-ae"
import { o1CodeConfigContent } from "./wpp-bridge/proxy/providerConfig.mjs"

test("validated AE bundles compose with browser config in dev and packaged layouts", async () => {
  const root = await mkdtemp(join(tmpdir(), "cm-ae-desktop-"))
  const desktop = join(root, "desktop")
  const warnings: string[] = []
  try {
    stageCmAeBundle(fileURLToPath(new URL("../../vendor/cm-ae", import.meta.url)), desktop, () => {})
    const options = {
      isPackaged: false,
      appPath: desktop,
      resourcesPath: join(root, "installed"),
      version: "1.18.27+cm.1",
      warn: (message: string) => warnings.push(message),
    }
    const ae = resolveCmAePlugin(options)
    expect(ae).toEqual([
      pathToFileURL(join(desktop, "resources", "cm-ae", "plugin.mjs")).href,
      { releaseMetadata: { cookieMonsterVersion: options.version } },
    ])
    const browser = "file:///cm-browser/plugin.mjs"
    const baseline = JSON.parse(o1CodeConfigContent(browser))
    const config = JSON.parse(o1CodeConfigContent(browser, ae))
    expect(config.plugin).toEqual([browser, ae])
    expect(config.permission).toEqual(baseline.permission)
    expect(Object.keys(config.permission).some((name) => name.startsWith("ae_"))).toBe(false)
    expect(config.provider).toEqual(baseline.provider)
    expect(config.mcp).toEqual(baseline.mcp)
    expect(JSON.parse(o1CodeConfigContent(undefined, ae)).plugin).toEqual([ae])

    await cp(join(desktop, "resources"), options.resourcesPath, { recursive: true })
    await rm(join(desktop, "resources"), { recursive: true })
    const installed = resolveCmAePlugin({
      ...options,
      isPackaged: true,
      appPath: join(root, "missing-app.asar"),
    })
    expect(installed?.[0]).toBe(pathToFileURL(join(options.resourcesPath, "cm-ae", "plugin.mjs")).href)
    expect(installed?.[1]).toEqual(ae?.[1])
    expect(warnings).toEqual([])

    const missing = resolveCmAePlugin(options)
    expect(missing).toBeUndefined()
    expect(JSON.parse(o1CodeConfigContent(browser, missing))).toEqual(baseline)
    expect(warnings.pop()).toContain("installed bundle absent")
  } finally {
    await rm(root, { recursive: true, force: true })
  }
}, 30_000)

test("packaging keeps the browser resource and requires all five AE files outside the app archive", async () => {
  const { default: config } = await import("../../electron-builder.config")
  const resources = config.extraResources as { from: string; to: string; filter?: string[] }[]
  expect(resources).toContainEqual({ from: "../cm-browser/dist/plugin.mjs", to: "cm-browser/plugin.mjs" })
  expect(resources).toContainEqual({ from: "resources/cm-ae", to: "cm-ae", filter: [...CM_AE_FILES] })
  expect(config.files).toContain("!resources/cm-ae{,/**/*}")
})
