import { expect, test } from "bun:test"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"

test("published Node runtime preserves history and plugin identity with isolated lifecycle", async () => {
  const root = await mkdtemp(join(tmpdir(), "cm-v2-runtime-"))
  try {
    const child = Bun.spawn(["node", new URL("./runtime.fixture.mjs", import.meta.url).pathname], {
      env: {
        ...process.env,
        FIXTURE_ROOT: root,
        CM_V2_CLI: new URL("../../desktop/resources/opencode-cli", import.meta.url).pathname,
        XDG_DATA_HOME: join(root, "data"),
        XDG_CONFIG_HOME: join(root, "config"),
        XDG_STATE_HOME: join(root, "state"),
        XDG_CACHE_HOME: join(root, "cache"),
      },
      stdout: "pipe",
      stderr: "pipe",
    })
    const [code, stdout, stderr] = await Promise.all([
      child.exited,
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
    ])
    expect({ code, error: code ? stdout + stderr : undefined }).toEqual({ code: 0, error: undefined })
    expect(stdout).toContain("Runtime fixture passed")
  } finally {
    await rm(root, { recursive: true, force: true })
  }
}, 60_000)
