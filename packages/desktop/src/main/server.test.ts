import { describe, expect, test } from "bun:test"
import { createSidecarEnv, withProxyToken } from "./sidecar-env"

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

describe("withProxyToken", () => {
  test("injects the launch token into a user-supplied cookiemonster provider", () => {
    const content = JSON.stringify({
      model: "cookiemonster/m",
      provider: { cookiemonster: { options: { baseURL: "http://127.0.0.1:8787/v1", apiKey: "cookiemonster-local" } } },
    })
    const result = JSON.parse(withProxyToken(content, "launch-token"))
    expect(result.provider.cookiemonster.options).toEqual({
      baseURL: "http://127.0.0.1:8787/v1",
      apiKey: "launch-token",
    })
    expect(result.model).toBe("cookiemonster/m")
  })

  test("adds the token for a provider merged from the disk seed", () => {
    const result = JSON.parse(withProxyToken('{"provider":{"openai":{}}}', "launch-token"))
    expect(result.provider.openai).toEqual({})
    expect(result.provider.cookiemonster.options.apiKey).toBe("launch-token")
  })

  test("never sends the token to a provider pointed at another host, and passes JSONC through", () => {
    const remote = JSON.stringify({
      provider: { cookiemonster: { options: { baseURL: "https://example.com/v1", apiKey: "mine" } } },
    })
    expect(withProxyToken(remote, "launch-token")).toBe(remote)
    expect(withProxyToken("{ // comment\n }", "launch-token")).toBe("{ // comment\n }")
  })
})
