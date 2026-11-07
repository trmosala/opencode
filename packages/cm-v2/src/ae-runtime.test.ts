import { expect, test } from "bun:test"
import { mkdtemp, rm } from "node:fs/promises"
import { join } from "node:path"
import { tmpdir } from "node:os"
import { pathToFileURL } from "node:url"
import { stageCmAeBundle } from "../../desktop/src/cm-ae"

test("official V2 AE directory plugin runs the real artifact, model/tool continuation and panel lifecycle", async () => {
  const root = await mkdtemp(join(tmpdir(), "cm-ae-v2-"))
  try {
    const directory = stageCmAeBundle(
      new URL("../../desktop/vendor/cm-ae", import.meta.url).pathname,
      join(root, "desktop"),
      () => {},
    )
    const child = Bun.spawn(["node", new URL("./ae-runtime.fixture.mjs", import.meta.url).pathname], {
      env: {
        ...process.env,
        FIXTURE_ROOT: root,
        CM_V2_AE_PATH: pathToFileURL(directory).href,
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
    expect(stdout).toContain("AE_V2_RUNTIME_FIXTURE_PASSED")
    console.log(
      stdout
        .split("\n")
        .filter((line) => line.startsWith("AE_V2_RUNTIME_FIXTURE_PASSED"))
        .join("\n"),
    )
  } finally {
    await rm(root, { recursive: true, force: true })
  }
}, 90000)
