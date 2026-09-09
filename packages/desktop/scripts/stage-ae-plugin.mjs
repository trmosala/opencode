import { copyFile, mkdir, mkdtemp, realpath, rename, rm } from "node:fs/promises"
import { isAbsolute, join, relative, resolve } from "node:path"
import { fileURLToPath, pathToFileURL } from "node:url"
import { AE_ARTIFACT_FILES, readAeArtifact } from "../src/main/ae-artifact.mjs"

export async function stageAePlugin(
  input = process.env.CM_AE_ARTIFACT_DIR,
  resources = fileURLToPath(new URL("../resources", import.meta.url)),
  warn = console.warn,
) {
  const destination = join(resources, "cm-ae")
  // Never delete a caller's input if they accidentally select the staging directory.
  if (input && isAbsolute(input)) {
    const source = await realpath(input).catch(() => resolve(input))
    const output = join(await realpath(resources).catch(() => resolve(resources)), "cm-ae")
    const overlap = relative(output, source)
    if (overlap === "" || (!overlap.startsWith("..") && !isAbsolute(overlap)))
      throw new Error("CM_AE_ARTIFACT_DIR must not be inside desktop resources/cm-ae")
  }
  // ponytail: one build writer per desktop checkout; no stale optional bundle on the next build.
  await rm(destination, { recursive: true, force: true })
  if (!input) {
    warn("[cm-ae] Optional plugin omitted: set CM_AE_ARTIFACT_DIR to the built dist/cm-ae directory.")
    return false
  }
  let stage
  try {
    await readAeArtifact(input)
    await mkdir(resources, { recursive: true })
    stage = await mkdtemp(join(resources, ".cm-ae-"))
    for (const name of AE_ARTIFACT_FILES) await copyFile(join(input, name), join(stage, name))
    await readAeArtifact(stage)
    await rename(stage, destination)
    console.log("[cm-ae] Staged plugin, render worker, permissions, and Zod license.")
    return true
  } catch (error) {
    warn(`[cm-ae] Optional plugin omitted: ${error.message}`)
    return false
  } finally {
    if (stage) await rm(stage, { recursive: true, force: true })
  }
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) await stageAePlugin()
