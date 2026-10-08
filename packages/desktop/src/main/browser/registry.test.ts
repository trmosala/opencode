import { expect, test } from "bun:test"
import {
  browserRegistration,
  browserTabs,
  registerBrowserTab,
  resolveBrowserTarget,
  browserTaskPaused,
  browserTaskEpoch,
  setBrowserTaskPaused,
  revokeBrowserAccess,
  setBrowserAgentEnabled,
  watchBrowserAuthority,
} from "./registry"
import type { DriverContents } from "./driver"

test("panel authority observers fence task changes and global disable without leaking after cleanup", () => {
  const calls: string[] = []
  const stop = watchBrowserAuthority("panel-owner", () => calls.push("owner"))
  const stopOther = watchBrowserAuthority("panel-other", () => calls.push("other"))
  try {
    setBrowserTaskPaused("panel-owner", true)
    expect(calls).toEqual(["owner"])
    setBrowserTaskPaused("panel-owner", true)
    expect(calls).toEqual(["owner"])
    setBrowserTaskPaused("panel-owner", false)
    expect(calls).toEqual(["owner", "owner"])
    stop()
    setBrowserAgentEnabled(false)
    expect(calls).toEqual(["owner", "owner", "other"])
    stopOther()
    setBrowserAgentEnabled(true)
    expect(calls).toEqual(["owner", "owner", "other"])
  } finally {
    stop()
    stopOther()
    setBrowserAgentEnabled(true)
    setBrowserTaskPaused("panel-owner", false)
  }
})

test("registry resolves exact session and tab, never a fallback", () => {
  let destroyed = false
  const contents: DriverContents = {
    mainFrame: { detached: false },
    get focusedFrame() {
      return this.mainFrame
    },
    isDestroyed: () => destroyed,
    isLoadingMainFrame: () => false,
    stop: () => {},
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
  const agent = {
    ...browserRegistration("session-one", "registry-one")!,
    id: "agent-tab",
    agentCreated: true,
    agentAccess: true,
    transferGuarded: true,
  }
  const shared = { ...agent, id: "shared-tab", agentCreated: false }
  const foreign = { ...agent, id: "foreign-tab", sessionID: "foreign-session" }
  const removals = [agent, shared, foreign].map(registerBrowserTab)
  try {
    const epoch = browserTaskEpoch("session-one")
    setBrowserTaskPaused("session-one", true)
    expect(browserTaskPaused("session-one")).toBe(true)
    expect(browserTaskEpoch("session-one")).toBeGreaterThan(epoch)
    expect(agent.agentAccess).toBe(false)
    expect(shared.agentAccess).toBe(false)
    expect(foreign.agentAccess).toBe(true)
    revokeBrowserAccess(shared)
    setBrowserTaskPaused("session-one", false)
    expect(agent.agentAccess).toBe(true)
    expect(shared.agentAccess).toBe(false)
    expect(browserRegistration("session-one", "registry-one")?.agentAccess).toBe(false)
    setBrowserTaskPaused("session-one", true)
    setBrowserAgentEnabled(false)
    expect(() => setBrowserTaskPaused("session-one", false)).toThrow()
    setBrowserAgentEnabled(true)
    setBrowserTaskPaused("session-one", false)
    expect(agent.agentAccess).toBe(false)
  } finally {
    setBrowserAgentEnabled(true)
    removals.forEach((remove) => remove())
  }
  destroyed = true
  expect(browserTabs("session-one")).toEqual([])
  remove()
})
