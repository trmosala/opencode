import { expect, test } from "bun:test"
import type { Plugin } from "@opencode-ai/plugin"
import { server } from "../src/plugin"

test("lifecycle defaults precede user wildcard and exact rules without overriding policy", async () => {
  const hooks = await server({} as Parameters<Plugin>[0])
  const user = { "*": "ask", browser_create_tab: "deny", browser_select_tab: "ask" }
  const config = { permission: user } as Parameters<NonNullable<typeof hooks.config>>[0]
  await hooks.config!(config)
  expect<unknown>(config.permission).toEqual({ browser_close_tab: "allow", desktop_set_panel: "allow", ...user })
  expect(Object.keys(config.permission!)).toEqual([
    "browser_close_tab",
    "desktop_set_panel",
    "*",
    "browser_create_tab",
    "browser_select_tab",
  ])
  const fresh = {}
  await hooks.config!(fresh)
  expect(fresh).toEqual({
    permission: {
      browser_create_tab: "allow", browser_select_tab: "allow", browser_close_tab: "allow", desktop_set_panel: "allow",
    },
  })
  for (const permission of ["ask", "deny", "allow"] as const) {
    const policy = { permission }
    // The legacy SDK type omits string and arbitrary-tool policies supported at runtime.
    await hooks.config!(policy as unknown as Parameters<NonNullable<typeof hooks.config>>[0])
    expect(policy.permission).toBe(permission)
  }
  for (const desktop_set_panel of ["ask", "deny"] as const) {
    const policy = { permission: { "*": "deny", desktop_set_panel } }
    await hooks.config!(policy as unknown as Parameters<NonNullable<typeof hooks.config>>[0])
    expect(policy.permission.desktop_set_panel).toBe(desktop_set_panel)
    expect(Object.keys(policy.permission).slice(-2)).toEqual(["*", "desktop_set_panel"])
    await hooks.config!(policy as unknown as Parameters<NonNullable<typeof hooks.config>>[0])
    expect(Object.keys(policy.permission).slice(-2)).toEqual(["*", "desktop_set_panel"])
  }
})

test("model instructions route to CM, explain autonomous tabs and forbid takeover bypass", async () => {
  const hooks = await server({} as Parameters<Plugin>[0])
  const input = { sessionID: "browser-task" } as Parameters<
    NonNullable<(typeof hooks)["experimental.chat.system.transform"]>
  >[0]
  const output = { system: ["Existing instructions"] }
  await hooks["experimental.chat.system.transform"]!(input, output)
  expect(output.system[0]).toBe("Existing instructions")
  expect(output.system[1]).toContain("desktop_set_panel")
  expect(output.system[1]).toContain("never grants page access or approves/discards changes")
  expect(output.system[2]).toContain("browser_create_tab then browser_navigate")
  expect(output.system[2]).toContain("outside execute's MCP catalog")
  expect(output.system[2]).toContain("never bypass that decision")
  expect(output.system[2]).toContain("confirmation before consequential actions")
})
