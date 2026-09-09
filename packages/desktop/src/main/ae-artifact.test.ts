import { expect, test } from "bun:test"
import { cp, mkdir, mkdtemp, readFile, readdir, rm, symlink, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { pathToFileURL } from "node:url"
import { AE_ARTIFACT_FILES, aePluginConfig, readAeArtifact } from "./ae-artifact.mjs"
import { stageAePlugin } from "../../scripts/stage-ae-plugin.mjs"
import { o1CodeConfigContent } from "./wpp-bridge/proxy/providerConfig.mjs"

test("stages only AE build outputs and adds them to browser config in dev and packaged layouts", async () => {
  const root = await mkdtemp(join(tmpdir(), "cm-ae-desktop-"))
  const input = join(root, "build input")
  const resources = join(root, "desktop", "resources")
  const warnings: string[] = []
  const warn = (message: string) => warnings.push(message)
  const permissions = { ae_connections: "allow", ae_execute: "ask", ae_raw_execute: "deny" }
  try {
    await mkdir(input)
    await mkdir(resources, { recursive: true })
    // Syntax validation must not execute the input.
    const plugin = 'throw new Error("must not execute"); export default { id: "cm-ae", server() {} }'
    await writeFile(join(input, "plugin.mjs"), plugin)
    await writeFile(join(input, "render-worker.mjs"), 'throw new Error("must not execute")')
    await writeFile(join(input, "permissions.json"), JSON.stringify(permissions))
    await writeFile(join(input, "ZOD-LICENSE.txt"), "test license")
    await writeFile(join(input, ".env"), "SECRET=must-not-copy")
    await writeFile(join(input, "pairing.json"), '{"token":"must-not-copy"}')
    await mkdir(join(input, "logs"))
    await writeFile(join(input, "logs", "session.log"), "must-not-copy")

    expect(await stageAePlugin(input, resources, warn)).toBe(true)
    expect((await readdir(join(resources, "cm-ae"))).sort()).toEqual([...AE_ARTIFACT_FILES].sort())
    expect(await readFile(join(resources, "cm-ae", "plugin.mjs"), "utf8")).toBe(plugin)

    const options = {
      packaged: false,
      appPath: join(root, "desktop"),
      resourcesPath: join(root, "installed"),
      version: "1.18.27+cm.1",
    }
    const ae = await aePluginConfig(options, warn)
    expect(ae?.plugin).toEqual([
      pathToFileURL(join(resources, "cm-ae", "plugin.mjs")).href,
      { releaseMetadata: { cookieMonsterVersion: options.version } },
    ])
    const browser = "file:///cm-browser/plugin.mjs"
    const baseline = JSON.parse(o1CodeConfigContent(browser))
    const config = JSON.parse(o1CodeConfigContent(browser, ae))
    expect(config.plugin).toEqual([browser, ae?.plugin])
    expect(config.permission).toEqual(baseline.permission)
    expect(Object.keys(config.permission).some((name) => name.startsWith("ae_"))).toBe(false)
    expect(config.provider).toEqual(baseline.provider)
    expect(config.mcp).toEqual(baseline.mcp)
    expect(JSON.parse(o1CodeConfigContent(undefined, ae)).plugin).toEqual([ae?.plugin])

    await cp(resources, options.resourcesPath, { recursive: true })
    await rm(resources, { recursive: true })
    const installed = await aePluginConfig(
      { ...options, packaged: true, appPath: join(root, "missing-app.asar") },
      warn,
    )
    expect(installed?.plugin[0]).toBe(pathToFileURL(join(options.resourcesPath, "cm-ae", "plugin.mjs")).href)
    expect(installed?.permissions).toEqual(permissions)
    expect(warnings).toEqual([])

    const missing = await aePluginConfig(options, warn)
    expect(missing).toBeUndefined()
    expect(JSON.parse(o1CodeConfigContent(browser, missing))).toEqual(baseline)
    expect(warnings.pop()).toContain("Optional plugin disabled")

    // A new build with absent/invalid input cannot silently package a previous AE bundle.
    await mkdir(resources)
    expect(await stageAePlugin(input, resources, warn)).toBe(true)
    await expect(stageAePlugin(join(resources, "cm-ae"), resources, warn)).rejects.toThrow("must not be inside")
    expect(await readFile(join(resources, "cm-ae", "plugin.mjs"), "utf8")).toBe(plugin)
    expect(await stageAePlugin("", resources, warn)).toBe(false)
    expect(await readdir(resources)).toEqual([])
    expect(warnings.pop()).toContain("CM_AE_ARTIFACT_DIR")
    expect(await stageAePlugin(join(root, "absent"), resources, warn)).toBe(false)
    expect(await stageAePlugin("relative/path", resources, warn)).toBe(false)

    for (const invalid of ["{", "", "[]", "{}", '{"browser_click":"allow"}', '{"ae_execute":"bogus"}']) {
      await writeFile(join(input, "permissions.json"), invalid)
      expect(await stageAePlugin(input, resources, warn)).toBe(false)
      expect(await readdir(resources)).toEqual([])
      expect(warnings.pop()).toContain("permissions.json")
    }
    await writeFile(join(input, "permissions.json"), JSON.stringify(permissions))
    for (const name of ["plugin.mjs", "render-worker.mjs"]) {
      const original = await readFile(join(input, name))
      await writeFile(join(input, name), "export const = ;")
      expect(await stageAePlugin(input, resources, warn)).toBe(false)
      expect(warnings.pop()).toContain(`${name} failed syntax validation`)
      await writeFile(join(input, name), original)
    }
    await rm(join(input, "render-worker.mjs"))
    expect(await stageAePlugin(input, resources, warn)).toBe(false)
    expect(warnings.pop()).toContain("render-worker.mjs")
    await mkdir(join(input, "render-worker.mjs"))
    await expect(readAeArtifact(input)).rejects.toThrow("regular render-worker.mjs")
    await rm(join(input, "render-worker.mjs"), { recursive: true })
    await writeFile(join(input, "render-worker.mjs"), "export {}")
    // Junctions work on Windows without symlink privilege.
    const linked = join(root, "linked")
    await symlink(input, linked, "junction")
    await expect(readAeArtifact(linked)).rejects.toThrow("real directory")
    await rm(linked, { recursive: true })
  } finally {
    await rm(root, { recursive: true, force: true })
  }
}, 30_000)

test("packaging keeps the browser resource and allowlists AE outside the app archive", async () => {
  const { default: config } = await import("../../electron-builder.config")
  const resources = config.extraResources as { from: string; to: string; filter?: string[] }[]
  expect(resources).toContainEqual({ from: "../cm-browser/dist/plugin.mjs", to: "cm-browser/plugin.mjs" })
  const ae = resources.find((entry) => entry.to === "cm-ae")
  if (ae) expect(ae.filter).toEqual(AE_ARTIFACT_FILES)
  expect(config.files).toContain("!resources/cm-ae/**/*")
})
