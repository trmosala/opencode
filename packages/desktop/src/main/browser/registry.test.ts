import { expect, test } from "bun:test"
import { browserRegistration, browserTabs, registerBrowserTab, resolveBrowserTarget } from "./registry"
import type { DriverContents } from "./driver"

test("registry resolves exact session and tab, never a fallback", () => {
  let destroyed = false
  const contents: DriverContents = {
    isDestroyed: () => destroyed,
    getURL: () => "http://localhost/",
    loadURL: async () => {},
    debugger: { isAttached: () => true, attach: () => {}, sendCommand: async () => ({}) },
  }
  const remove = registerBrowserTab({
    id: "registry-one",
    ownerID: 1,
    sessionID: "session-one",
    contents,
    agentAccess: false,
    revision: 0,
  })
  expect(resolveBrowserTarget("session-one", "registry-one")?.contents).toBe(contents)
  expect(resolveBrowserTarget("other", "registry-one")).toBeUndefined()
  expect(resolveBrowserTarget("session-one", "other")).toBeUndefined()
  expect(browserRegistration("session-one", "registry-one")?.agentAccess).toBe(false)
  destroyed = true
  expect(browserTabs("session-one")).toEqual([])
  remove()
})
