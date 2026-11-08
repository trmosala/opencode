import { expect, test } from "bun:test"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"

test("CM features execute on published V2 with isolated files and authenticated routes", async () => {
  const root = await mkdtemp(join(tmpdir(), "cm-v2-features-"))
  try {
    const child = Bun.spawn(["node", new URL("./features.fixture.mjs", import.meta.url).pathname], {
      env: {
        ...process.env,
        HOME: root,
        FIXTURE_ROOT: root,
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
    expect(stdout).toContain("Feature fixture passed")
  } finally {
    await rm(root, { recursive: true, force: true })
  }
}, 60_000)
