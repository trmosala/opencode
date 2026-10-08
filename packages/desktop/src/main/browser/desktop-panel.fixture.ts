import assert from "node:assert/strict"
import { setTimeout } from "node:timers/promises"
import { BrowserWindow } from "electron"
import type { DesktopPanelRequest } from "@opencode-ai/app/browser-panel"
import type { PanelRequest } from "@cookiemonster/cm-browser/protocol"
import {
  browserCommand,
  browserLinkContext,
  browserPanelAcknowledgement,
  browserPanelRequestCurrent,
  browserViewport,
  registerBrowserOwner,
} from "./tabs"
import { browserOperationBusy, reserveBrowserTab, setBrowserAgentEnabled, setBrowserTaskPaused } from "./registry"
import { routeBrowserRequest } from "./router"

// Only the isolated native fixtures replace renderer acknowledgement; native layout stays real.
export function desktopPanelFixture(owner: ReturnType<typeof registerBrowserOwner>) {
  assert(process.env.CM_BROWSER_SMOKE_PROFILE)
  const send = owner.win.webContents.send
  const fixture = {
    auto: true,
    requests: [] as DesktopPanelRequest[],
    cancellations: [] as string[],
    acknowledge(request: DesktopPanelRequest) {
      if (!browserPanelRequestCurrent(owner, request.id, request.sessionID)) return false
      const lease = owner.viewport?.lease ?? "panel-fixture"
      browserViewport(owner, {
        sessionID: request.sessionID,
        lease,
        bounds: request.view === "browser" ? { x: 0, y: 0, width: 500, height: 350 } : null,
      })
      return browserPanelAcknowledgement(owner, {
        id: request.id, sessionID: request.sessionID, view: request.view,
        ...(request.view === "browser" ? { tabID: request.tabID } : {}),
      })
    },
    close() {
      owner.panelRequest?.cancel()
      owner.win.webContents.send = send
    },
  }
  owner.win.webContents.send = (channel, ...args) => {
    if (channel === "desktop-panel-request") {
      const request = args[0] as DesktopPanelRequest
      fixture.requests.push(request)
      if (fixture.auto) queueMicrotask(() => assert(fixture.acknowledge(request), "Native panel fixture not ready"))
    }
    if (channel === "desktop-panel-cancel") fixture.cancellations.push(args[0])
    send.call(owner.win.webContents, channel, ...args)
  }
  return fixture
}

export async function desktopPanelSmoke() {
  assert(process.env.CM_BROWSER_SMOKE_PROFILE, "Only run through the isolated smoke runner")
  const win = new BrowserWindow({ show: false, width: 640, height: 480 })
  const owner = registerBrowserOwner(win)
  const fixture = desktopPanelFixture(owner)
  const sessionID = "desktop-panel"
  const route = (request: PanelRequest, signal?: AbortSignal, deadline?: number) =>
    routeBrowserRequest(
      { type: "browser_request", id: crypto.randomUUID(), sessionID, request },
      undefined,
      { signal, deadline },
    )
  const pending = async (request: PanelRequest, signal?: AbortSignal, deadline?: number) => {
    const count = fixture.requests.length
    const response = route(request, signal, deadline)
    for (let i = 0; i < 100 && fixture.requests.length === count; i++) await setTimeout(10)
    assert.equal(fixture.requests.length, count + 1, "Renderer request must arrive")
    return { response, request: fixture.requests[count] }
  }
  try {
    await win.loadURL("about:blank")
    win.showInactive()
    browserLinkContext(owner, sessionID, "panel")
    const blank = await browserCommand(owner, sessionID, { op: "new" })
    const tab = owner.groups.get(sessionID)!.tabs.find((entry) => entry.id === blank.activeID)!
    tab.agentCreated = true
    tab.agentAccess = true
    const browser: PanelRequest = { op: "set_panel", view: "browser", tabID: tab.id }
    fixture.auto = false
    const opening = await pending(browser)
    const ack = { id: opening.request.id, sessionID, view: "browser", tabID: tab.id }
    assert(!browserPanelAcknowledgement(owner, ack), "Agent blank tab requires native viewport")
    assert(!browserPanelAcknowledgement(owner, { ...ack, tabID: "other" }))
    assert(!browserPanelAcknowledgement(owner, { ...ack, id: "stale" }))
    assert(!browserPanelAcknowledgement(owner, { ...ack, op: "set_panel" }))
    browserLinkContext(owner, sessionID, "panel")
    assert(browserPanelRequestCurrent(owner, ack.id, sessionID), "Idempotent link update retains request")
    browserViewport(owner, { sessionID, lease: "mounted", bounds: { x: 0, y: 0, width: 0, height: 0 } })
    assert(!browserPanelAcknowledgement(owner, ack), "Zero viewport cannot acknowledge")
    assert(fixture.acknowledge(opening.request), "Mount may advance owner epoch without cancelling itself")
    const opened = await opening.response
    assert(opened.ok && opened.result.panelResult?.view === "browser")
    assert(!browserPanelAcknowledgement(owner, ack), "Duplicate acknowledgement rejected")
    assert.equal(owner.captureChecks?.size, 0)

    for (const view of ["review", "hidden"] as const) {
      const closing = await pending({ op: "set_panel", view })
      const observed = { id: closing.request.id, sessionID, view }
      if (owner.attached) assert(!browserPanelAcknowledgement(owner, observed), "Native page still attached")
      assert(!browserPanelAcknowledgement(owner, { ...observed, tabID: tab.id }))
      assert(fixture.acknowledge(closing.request), "Viewport clear must not cancel closing request")
      const closed = await closing.response
      assert(closed.ok && closed.result.panelResult?.browserReady === false)
      assert.equal(owner.captureChecks?.size, 0)
    }

    for (const change of ["abort", "link", "viewport", "takeover", "disable", "hide", "revision", "revoke"] as const) {
      const controller = new AbortController()
      const waiting = await pending(change === "revision" || change === "revoke" ? browser : { op: "set_panel", view: "hidden" }, controller.signal)
      if (change === "abort") controller.abort()
      if (change === "link") {
        browserLinkContext(owner, "other-task", "other")
        browserLinkContext(owner, sessionID, "panel")
      }
      if (change === "viewport") {
        browserViewport(owner, { sessionID: "other-task", lease: "other", bounds: { x: 0, y: 0, width: 500, height: 350 } })
        browserViewport(owner, { sessionID: "other-task", lease: "other", bounds: null })
      }
      if (change === "takeover") {
        setBrowserTaskPaused(sessionID, true)
        setBrowserTaskPaused(sessionID, false)
      }
      if (change === "disable") {
        setBrowserAgentEnabled(false)
        setBrowserAgentEnabled(true)
      }
      if (change === "hide") {
        win.hide()
        win.showInactive()
      }
      if (change === "revision") tab.revision++
      if (change === "revoke") await browserCommand(owner, sessionID, { op: "access", tabID: tab.id, enabled: false })
      assert(!browserPanelRequestCurrent(owner, waiting.request.id, sessionID), `${change}: request fenced`)
      assert(!fixture.acknowledge(waiting.request), `${change}: no late success`)
      assert(!(await waiting.response).ok, `${change}: no successful result`)
      assert.equal(owner.captureChecks?.size, 0, `${change}: cleanup`)
      assert(fixture.cancellations.includes(waiting.request.id))
      tab.agentAccess = true
    }

    const expiry = await pending({ op: "set_panel", view: "hidden" }, undefined, Date.now() + 150)
    assert(!(await expiry.response).ok)
    assert(!fixture.acknowledge(expiry.request))
    assert.equal(owner.captureChecks?.size, 0)
    const busy = await pending(browser)
    assert(!(await route({ op: "set_panel", view: "hidden" })).ok)
    assert(fixture.acknowledge(busy.request))
    assert((await busy.response).ok)
    const release = reserveBrowserTab(tab, {})
    assert(!(await route(browser)).ok, "Reserved tabs are not panel targets")
    release()
    browserOperationBusy.add(tab.id)
    assert(!(await route({ op: "set_panel", view: "review" })).ok)
    browserOperationBusy.delete(tab.id)
    tab.agentAccess = false
    assert(!(await route(browser)).ok, "Panel selection grants no access")
    console.log("PASS desktop panel: readiness, mount/clear, identity, cancel, deadline, task/global/link fences, private/reserved/busy targets")
  } finally {
    browserOperationBusy.clear()
    setBrowserAgentEnabled(true)
    setBrowserTaskPaused(sessionID, false)
    fixture.close()
    win.destroy()
  }
}
