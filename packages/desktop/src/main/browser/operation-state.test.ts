import { expect, test } from "bun:test"
import { failure, success } from "@cookiemonster/cm-browser/protocol"
import type { BrowserRegistration } from "./registry"
import { startBrowserOperation } from "./operation-state"

test("late completion cannot erase a newer operation and cancellation remains settling until native completion", () => {
  const states: (string | undefined)[] = []
  const tab: BrowserRegistration = {
    id: "status-tab",
    ownerID: 1,
    sessionID: "status-session",
    agentAccess: true,
    revision: 1,
    contents: {
      mainFrame: { detached: false },
      focusedFrame: null,
      isDestroyed: () => false,
      isLoadingMainFrame: () => false,
      getURL: () => "https://example.test/",
      loadURL: async () => {},
      stop() {},
      debugger: { isAttached: () => true, attach() {}, sendCommand: async () => ({}) },
    },
    operationChanged: () => states.push(tab.operation?.status),
  }
  const first = startBrowserOperation(tab, "read_state", new AbortController().signal)
  const controller = new AbortController()
  const second = startBrowserOperation(tab, "click", controller.signal)
  first.finish()
  first.report(failure("unavailable", "Old failure"))
  expect(tab.operation).toMatchObject({ status: "running", op: "click" })
  controller.abort()
  second.report({
    ...failure("cancelled", "Cancelled"),
    actionStatus: "dispatched_uncertain",
    actionCause: "cancelled",
  })
  expect(tab.operation).toMatchObject({ status: "settling", op: "click", actionStatus: "dispatched_uncertain" })
  second.finish()
  expect(tab.operation).toMatchObject({ status: "failed", code: "cancelled" })
  const third = startBrowserOperation(tab, "read_state", new AbortController().signal)
  third.report(success({ tabID: tab.id, url: "https://example.test/", title: "", visibleText: "", elements: [] }))
  third.finish()
  expect(tab.operation).toBeUndefined()
  second.report(failure("unavailable", "Late failure"))
  expect(tab.operation).toBeUndefined()
  expect(states).toContain("settling")
})
