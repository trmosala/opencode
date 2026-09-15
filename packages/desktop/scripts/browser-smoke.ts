import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { basename, dirname, join, resolve } from "node:path"
import electron from "electron"

const directory = await mkdtemp(join(tmpdir(), "cm-browser-smoke-"))
try {
  const build = await Bun.build({
    entrypoints: ["./src/main/browser/native-smoke.ts"],
    target: "node",
    format: "cjs",
    external: ["electron"],
  })
  if (!build.success) throw new Error(build.logs.join("\n"))
  const entry = join(directory, "native.cjs")
  await Bun.write(entry, build.outputs[0])
  const env = { ...process.env, CM_BROWSER_STATE_DIR: directory, CM_BROWSER_SMOKE_PROFILE: directory }
  delete env.ELECTRON_RUN_AS_NODE
  const child = Bun.spawn([electron, entry, ...process.argv.slice(2)], { env, stdout: "inherit", stderr: "inherit" })
  const timeout = setTimeout(() => child.kill(), process.env.CM_BROWSER_LIVE_SMOKE === "1" ? 120_000 : 60_000)
  const code = await child.exited
  clearTimeout(timeout)
  console.log(
    "Last stage:",
    await Bun.file(join(directory, "stage.txt"))
      .text()
      .catch(() => "entry not reached"),
  )
  const result = await Bun.file(join(directory, "result.txt"))
    .text()
    .catch(() => "")
  if (code !== 0 || result !== "PASS")
    throw new Error(`Native smoke exited ${code}: ${result || "no completion result"}`)
  console.log("PASS native browser smoke")
} finally {
  if (dirname(resolve(directory)) !== resolve(tmpdir()) || !basename(directory).startsWith("cm-browser-smoke-"))
    throw new Error("Unexpected browser smoke directory")
  await rm(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 })
}
