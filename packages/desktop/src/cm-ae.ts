import { spawnSync } from "node:child_process"
import { lstatSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs"
import path from "node:path"
import { pathToFileURL } from "node:url"

export const CM_AE_FILES = [
  "plugin.mjs",
  "render-worker.mjs",
  "permissions.json",
  "ZOD-LICENSE.txt",
  "MARKED-LICENSE.txt",
] as const

const readTools = [
  "ae_connections",
  "ae_inspect",
  "ae_render_list",
  "ae_render_status",
  "ae_render_result",
  "ae_diagnostics",
]
const approvalTools = [
  "ae_pair",
  "ae_bind",
  "ae_release",
  "ae_execute",
  "ae_grant",
  "ae_capture",
  "ae_checkpoints",
  "ae_restore",
  "ae_templates",
  "ae_render_recover",
  "ae_render_submit",
  "ae_render_cancel",
  "ae_render_retire",
  "ae_reconcile",
]

export type CmAePlugin = [string, { releaseMetadata: { cookieMonsterVersion: string } }]

// Read bytes once: syntax checks and staging use these same bytes, never import the artifact.
export function readCmAeBundle(directory: string, executable = process.versions.bun ? "node" : process.execPath) {
  const root = lstatSync(directory, { throwIfNoEntry: false })
  if (!root) return
  if (!root.isDirectory() || root.isSymbolicLink()) throw new Error("cm-ae must be a regular directory")
  const names = readdirSync(directory)
  if (names.length !== CM_AE_FILES.length || CM_AE_FILES.some((name) => !names.includes(name))) {
    throw new Error(`cm-ae requires exactly: ${CM_AE_FILES.join(", ")}`)
  }
  const files = CM_AE_FILES.map((name) => {
    const file = path.join(directory, name)
    const stat = lstatSync(file)
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size === 0 || stat.size > 16 * 1024 * 1024) {
      throw new Error(`cm-ae invalid regular file: ${name}`)
    }
    return { name, data: readFileSync(file) }
  })
  const permissions: unknown = JSON.parse(files.find((file) => file.name === "permissions.json")!.data.toString("utf8"))
  if (!permissions || typeof permissions !== "object" || Array.isArray(permissions)) {
    throw new Error("cm-ae permissions must be an object")
  }
  const entries = Object.entries(permissions)
  if (
    entries.length !== readTools.length + approvalTools.length ||
    [...readTools, ...approvalTools].some((name) => !Object.hasOwn(permissions, name)) ||
    entries.some(
      ([name, action]) =>
        !(readTools.includes(name) || name === "ae_execute" ? ["allow", "ask", "deny"] : ["ask", "deny"]).includes(action),
    )
  ) {
    throw new Error("cm-ae permissions must contain known AE tools with safe actions")
  }
  for (const file of files.filter((file) => file.name.endsWith(".mjs"))) {
    // Electron's embedded Node supports --check. No standalone Node is needed in the installed app.
    // Clear preload options so validation cannot run user-supplied startup modules.
    const check = spawnSync(executable, ["--check", "--input-type=module"], {
      input: file.data,
      env: { ...process.env, NODE_OPTIONS: "", ELECTRON_RUN_AS_NODE: "1" },
      windowsHide: true,
      timeout: 10_000,
      maxBuffer: 1024 * 1024,
      encoding: "utf8",
    })
    if (check.error || check.status !== 0) {
      throw new Error(`cm-ae syntax check failed: ${file.name}: ${check.error?.message || check.stderr.trim()}`)
    }
  }
  return files
}

export function stageCmAeBundle(
  artifactDir: string | undefined,
  desktopDir: string,
  diagnostic: (message: string) => void = console.info,
) {
  const resources = path.resolve(desktopDir, "resources")
  const parent = lstatSync(resources, { throwIfNoEntry: false })
  if (parent && (!parent.isDirectory() || parent.isSymbolicLink())) {
    throw new Error("cm-ae staging resources must be a regular directory")
  }
  const stage = path.join(resources, "cm-ae")
  if (artifactDir !== undefined) {
    if (!artifactDir.trim() || !path.isAbsolute(artifactDir)) {
      rmSync(stage, { recursive: true, force: true })
      throw new Error("CM_AE_ARTIFACT_DIR must be an absolute trusted bundle directory")
    }
    const source = path.resolve(artifactDir)
    const relative = path.relative(source, stage)
    const reverse = path.relative(stage, source)
    if (
      !relative ||
      !reverse ||
      (!relative.startsWith("..") && !path.isAbsolute(relative)) ||
      (!reverse.startsWith("..") && !path.isAbsolute(reverse))
    ) {
      throw new Error("CM_AE_ARTIFACT_DIR must not overlap the generated cm-ae stage")
    }
  }
  rmSync(stage, { recursive: true, force: true })
  const source = artifactDir ?? path.resolve(desktopDir, "vendor", "cm-ae")
  try {
    const files = readCmAeBundle(source)
    if (!files) {
      throw new Error(
        `${artifactDir === undefined ? "Required vendored cm-ae bundle" : "CM_AE_ARTIFACT_DIR"} does not exist: ${source}`,
      )
    }
    mkdirSync(stage, { recursive: true })
    for (const file of files) writeFileSync(path.join(stage, file.name), file.data, { flag: "wx" })
    diagnostic(`[cm-ae] validated and staged ${artifactDir === undefined ? "vendored" : "override"} AE bundle`)
    return stage
  } catch (error) {
    rmSync(stage, { recursive: true, force: true })
    throw error
  }
}

export function resolveCmAePlugin(options: {
  isPackaged: boolean
  resourcesPath: string
  appPath: string
  version: string
  warn: (message: string) => void
}): CmAePlugin | undefined {
  const directory = options.isPackaged
    ? path.join(options.resourcesPath, "cm-ae")
    : path.join(options.appPath, "resources", "cm-ae")
  try {
    if (!readCmAeBundle(directory)) {
      options.warn("[cm-ae] installed bundle absent; AE integration omitted")
      return
    }
    return [
      pathToFileURL(path.join(directory, "plugin.mjs")).href,
      {
        releaseMetadata: { cookieMonsterVersion: options.version },
      },
    ]
  } catch (error) {
    options.warn(
      `[cm-ae] installed bundle invalid; AE integration omitted: ${error instanceof Error ? error.message : String(error)}`,
    )
  }
}
