import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import electron from "electron"

const directory = await mkdtemp(join(tmpdir(), "cm-worker-rendering-"))

try {
  for (const [entry, output] of [
    ["src/main/wpp-bridge/worker-rendering.fixture.ts", "out/main/fixture.cjs"],
    ["src/preload/worker-preview.ts", "out/preload/worker-preview.cjs"],
  ]) {
    const build = await Bun.build({ entrypoints: [entry], target: "node", format: "cjs", external: ["electron"] })

    if (!build.success) throw new Error(build.logs.join("\n"))

    await Bun.write(join(directory, output), build.outputs[0])
  }

  await Bun.write(
    join(directory, "package.json"),
    JSON.stringify({ name: "cm-worker-rendering", main: "out/main/fixture.cjs" }),
  )

  const env = { ...process.env, CM_WPP_WORKER_FIXTURE_DIR: directory }
  delete env.ELECTRON_RUN_AS_NODE

  const child = Bun.spawn([electron, directory], {
    env,
    stdout: "inherit",
    stderr: "inherit",
    timeout: 60000,
  })

  const code = await child.exited

  if (code) throw new Error(`Worker rendering smoke failed (${code})`)
} finally {
  await rm(directory, { recursive: true, force: true })
}
