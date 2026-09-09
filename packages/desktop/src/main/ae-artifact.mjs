import { execFile } from "node:child_process"
import { lstat, readFile } from "node:fs/promises"
import { isAbsolute, join } from "node:path"
import { pathToFileURL } from "node:url"
import { promisify } from "node:util"

const exec = promisify(execFile)
export const AE_ARTIFACT_FILES = ["plugin.mjs", "render-worker.mjs", "permissions.json", "ZOD-LICENSE.txt"]

// Validate without importing executable build inputs into Electron's main process.
export async function readAeArtifact(directory) {
  if (typeof directory !== "string" || !isAbsolute(directory) || directory.includes("\0"))
    throw new Error("CM_AE_ARTIFACT_DIR must be an absolute path to the built dist/cm-ae directory")
  if (!(await lstat(directory)).isDirectory()) throw new Error("AE artifact must be a real directory")
  for (const name of AE_ARTIFACT_FILES) {
    const info = await lstat(join(directory, name))
    if (!info.isFile() || !info.size) throw new Error(`AE artifact requires a nonempty regular ${name}`)
  }
  const permissions = await readFile(join(directory, "permissions.json"), "utf8")
    .then(JSON.parse)
    .catch(() => {
      throw new Error("AE permissions.json is not valid JSON")
    })
  if (
    !permissions ||
    typeof permissions !== "object" ||
    Array.isArray(permissions) ||
    !Object.keys(permissions).length ||
    Object.entries(permissions).some(
      ([name, value]) => !/^ae_[a-z][a-z0-9_]*$/.test(name) || !["allow", "ask", "deny"].includes(value),
    )
  )
    throw new Error("AE permissions.json must contain only named AE tool policies")

  for (const name of ["plugin.mjs", "render-worker.mjs"]) {
    await exec(process.versions.bun ? "node" : process.execPath, ["--check", join(directory, name)], {
      env: { ...process.env, ELECTRON_RUN_AS_NODE: "1" },
      timeout: 15_000,
      maxBuffer: 64 * 1024,
    }).catch(() => {
      throw new Error(`AE ${name} failed syntax validation (or validator unavailable); not loaded`)
    })
  }
  return { path: pathToFileURL(join(directory, "plugin.mjs")).href, permissions }
}

export async function aePluginConfig({ packaged, appPath, resourcesPath, version }, warn = console.warn) {
  const directory = join(packaged ? resourcesPath : join(appPath, "resources"), "cm-ae")
  try {
    const artifact = await readAeArtifact(directory)
    return {
      plugin: [artifact.path, { releaseMetadata: { cookieMonsterVersion: version } }],
      permissions: artifact.permissions,
    }
  } catch (error) {
    warn(`[cm-ae] Optional plugin disabled: ${error.message}. Rebuild with CM_AE_ARTIFACT_DIR set to dist/cm-ae.`)
    return undefined
  }
}
