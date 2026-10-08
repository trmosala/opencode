import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import electron from "electron"

const directory = await mkdtemp(join(tmpdir(), "cm-wpp-login-fixture-"))
try {
  const build = await Bun.build({
    entrypoints: ["./src/main/wpp-bridge/okta-login.fixture.ts"],
    target: "node",
    format: "cjs",
    external: ["electron"],
  })
  if (!build.success) throw new Error(build.logs.join("\n"))
  const entry = join(directory, "fixture.cjs")
  await Bun.write(entry, build.outputs[0])
  const env = { ...process.env, CM_WPP_LOGIN_FIXTURE_DIR: directory }
  delete env.ELECTRON_RUN_AS_NODE
  const child = Bun.spawn([electron, entry], { env, stdout: "inherit", stderr: "inherit" })
  const timeout = setTimeout(() => child.kill(), 30_000)
  try {
    if ((await child.exited) !== 0) throw new Error("WPP login fixture failed")
  } finally {
    clearTimeout(timeout)
  }
} finally {
  await rm(directory, { recursive: true, force: true })
}
