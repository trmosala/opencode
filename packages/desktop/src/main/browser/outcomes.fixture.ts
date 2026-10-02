import assert from "node:assert/strict"
import { once } from "node:events"
import { createServer } from "node:http"
import { BrowserWindow, dialog } from "electron"
import { browserCommand, browserViewport, registerBrowserOwner } from "./tabs"
import { browserOperationBusy } from "./registry"
import { routeBrowserRequest } from "./router"

export async function outcomesSmoke() {
  assert(process.env.CM_BROWSER_SMOKE_PROFILE, "Only run through the isolated smoke runner")
  const server = createServer((_request, response) => {
    response.writeHead(200, { "Content-Type": "text/html" })
    response.end(`<!doctype html><title>Synthetic calendar</title>
      <button onclick="window.weeks=(window.weeks||0)+1;document.querySelector('p').textContent='Synthetic week '+weeks">Next calendar week</button>
      <p>Synthetic week 0</p>`)
  })
  server.listen(0, "127.0.0.1")
  await once(server, "listening")
  const address = server.address()
  assert(address && typeof address === "object")
  const url = `http://127.0.0.1:${address.port}/`
  const win = new BrowserWindow({
    show: false,
    width: 700,
    height: 500,
    webPreferences: { sandbox: true, contextIsolation: true },
  })
  const owner = registerBrowserOwner(win)
  const sessionID = "action-outcomes"
  const command = (value: Parameters<typeof browserCommand>[2]) => browserCommand(owner, sessionID, value)
  const originalDialog = dialog.showMessageBox
  dialog.showMessageBox = (async () => ({ response: 1, checkboxChecked: false })) as typeof dialog.showMessageBox
  const held = Promise.withResolvers<void>()
  const settled = Promise.withResolvers<void>()
  try {
    await win.loadURL(url)
    win.showInactive()
    const tabID = (await command({ op: "new" })).activeID!
    await command({ op: "navigate", tabID, url })
    browserViewport(owner, { sessionID, lease: sessionID, bounds: { x: 0, y: 0, width: 600, height: 400 } })
    const tab = owner.groups.get(sessionID)!.tabs.find((item) => item.id === tabID)!
    const contents = tab.view.webContents
    if (contents.isLoading()) await once(contents, "did-stop-loading")
    await command({ op: "access", tabID, enabled: true })
    const read = () =>
      routeBrowserRequest({ type: "browser_request", id: "read", sessionID, request: { op: "read_state", tabID } })
    const state = await read()
    assert(state.ok, JSON.stringify(state))
    const ref = state.result.elements.find((element) => element.tag === "button")!.ref
    const prepared = await routeBrowserRequest({
      type: "browser_request",
      id: "prepare",
      sessionID,
      request: { op: "prepare_write", request: { op: "click", tabID, ref } },
    })
    assert(prepared.ok && prepared.result.context)
    const dispatch = contents.debugger.sendCommand.bind(contents.debugger)
    let observationFailed = false
    let releases = 0
    contents.debugger.sendCommand = async (method, params, child) => {
      if (observationFailed && method === "Runtime.evaluate" && params?.returnByValue)
        throw new Error("Synthetic observation failure")
      const result = await dispatch(method, params, child)
      if (method === "Input.dispatchMouseEvent" && params?.type === "mouseReleased") {
        releases++
        observationFailed = true
      }
      return result
    }
    const response = await routeBrowserRequest({
      type: "browser_request",
      id: "calendar-click",
      sessionID,
      request: { op: "click", tabID, ref, context: prepared.result.context },
    })
    assert.equal(response.ok, false)
    assert.equal(response.actionStatus, "dispatched_uncertain")
    assert(!response.ok && response.actionCause === "observation_failed")
    assert.equal(releases, 1, "Observation failure must not replay a click")
    assert.equal(await contents.executeJavaScript("window.weeks"), 1)
    contents.debugger.sendCommand = dispatch

    const fresh = await read()
    assert(fresh.ok && fresh.result.visibleText.includes("Synthetic week 1"))
    const freshRef = fresh.result.elements.find((element) => element.tag === "button")!.ref
    const next = await routeBrowserRequest({
      type: "browser_request",
      id: "prepare-next",
      sessionID,
      request: { op: "prepare_write", request: { op: "click", tabID, ref: freshRef } },
    })
    assert(next.ok && next.result.context)
    const request = { op: "click" as const, tabID, ref: freshRef, context: next.result.context }
    const before = new AbortController()
    before.abort()
    const cancelled = await routeBrowserRequest(
      { type: "browser_request", id: "before-dispatch", sessionID, request },
      undefined,
      { signal: before.signal },
    )
    assert(!cancelled.ok && cancelled.code === "cancelled" && cancelled.actionStatus === "not_dispatched")
    assert.equal(await contents.executeJavaScript("window.weeks"), 1)

    const after = new AbortController()
    contents.debugger.sendCommand = async (method, params, child) => {
      const result = await dispatch(method, params, child)
      if (method === "Input.dispatchMouseEvent" && params?.type === "mouseReleased") {
        after.abort()
        await held.promise
      }
      return result
    }
    const interrupted = await routeBrowserRequest(
      { type: "browser_request", id: "after-dispatch", sessionID, request },
      undefined,
      {
        signal: after.signal,
        onSettled: (operation) => void operation.finally(() => settled.resolve()),
      },
    )
    assert(!interrupted.ok && interrupted.code === "cancelled" && interrupted.actionStatus === "dispatched_uncertain")
    assert(browserOperationBusy.has(tabID), "Cancellation must retain unsettled native ownership")
    assert.equal((await command({ op: "state" })).tabs.find((item) => item.id === tabID)?.operation?.status, "settling")
    assert.equal(await contents.executeJavaScript("window.weeks"), 2)
    held.resolve()
    await settled.promise
    assert(!browserOperationBusy.has(tabID))
    assert.equal((await command({ op: "state" })).tabs.find((item) => item.id === tabID)?.operation?.status, "failed")
    const crashed = once(contents, "render-process-gone")
    contents.forcefullyCrashRenderer()
    await crashed
    const crashedTab = (await command({ op: "state" })).tabs.find((item) => item.id === tabID)!
    assert.equal(crashedTab.loadFailed, true)
    assert.equal(crashedTab.failure?.kind, "crash")
    assert.equal(crashedTab.agentAccess, false)
    console.log(
      "PASS native action outcomes: synthetic calendar click once, failed observation, before/after dispatch cancellation",
    )
  } finally {
    held.resolve()
    dialog.showMessageBox = originalDialog
    win.destroy()
    server.closeAllConnections()
    await new Promise<void>((resolve) => server.close(() => resolve()))
  }
}
