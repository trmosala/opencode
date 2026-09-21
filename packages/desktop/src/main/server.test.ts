import { expect, test } from "bun:test"
import { createSidecarEnv } from "./sidecar-env"

test("explicit OPENCODE_CONFIG_CONTENT bypasses bundled plugin resolution byte-for-byte", () => {
  for (const content of ["", '{ "plugin": ["user-plugin"], "permission": { "ae_*": "deny" } }']) {
    expect(
      createSidecarEnv(
        () => {
          throw new Error("must not resolve plugins")
        },
        {
          OPENCODE_CONFIG_CONTENT: content,
        },
      ).OPENCODE_CONFIG_CONTENT,
    ).toBe(content)
  }
})

test("default sidecar config preserves other environment settings without mutating the parent", () => {
  const source = { DEBUG: "1", LD_PRELOAD: "preload.so", USER_SETTING: "custom" }
  expect(createSidecarEnv(() => "bundled config", source, "linux")).toEqual({
    OPENCODE_CONFIG_CONTENT: "bundled config",
    USER_SETTING: "custom",
  })
  expect(createSidecarEnv(() => "bundled config", source, "win32").LD_PRELOAD).toBe("preload.so")
  expect(source).toEqual({ DEBUG: "1", LD_PRELOAD: "preload.so", USER_SETTING: "custom" })
})
