import assert from "node:assert/strict"
import { once } from "node:events"
import { createServer } from "node:http"
import { BrowserWindow, dialog } from "electron"
import { browserCommand, browserViewport, registerBrowserOwner } from "./tabs"
import { routeBrowserRequest } from "./router"
import type { Request } from "@cookiemonster/cm-browser/protocol"

export async function targetedReadSmoke() {
  assert(process.env.CM_BROWSER_SMOKE_PROFILE, "Only run through the isolated smoke runner")
  const server = createServer((_request, response) => {
    response.writeHead(200, { "Content-Type": "text/html" })
    response.end(`<!doctype html><title>Dense fixture</title><body>
      ${Array.from({ length: 320 }, (_, index) => `<button id="control-${index}" style="position:absolute;left:40px;top:40px">Control ${index}</button>`).join("")}
      <button id="attached" style="display:none">Hidden attached control</button></body>`)
  })
  server.listen(0, "127.0.0.1")
  await once(server, "listening")
  const address = server.address()
  assert(address && typeof address === "object")
  const url = `http://127.0.0.1:${address.port}/`
  const win = new BrowserWindow({ show: false, width: 700, height: 500 })
  const owner = registerBrowserOwner(win)
  const sessionID = "targeted-read"
  const command = (value: Parameters<typeof browserCommand>[2]) => browserCommand(owner, sessionID, value)
  const original = dialog.showMessageBox
  dialog.showMessageBox = (async () => ({ response: 1, checkboxChecked: false })) as typeof dialog.showMessageBox
  try {
    await win.loadURL(url)
    win.showInactive()
    const tabID = (await command({ op: "new" })).activeID!
    await command({ op: "navigate", tabID, url })
    browserViewport(owner, { sessionID, lease: sessionID, bounds: { x: 0, y: 0, width: 600, height: 400 } })
    const contents = owner.groups.get(sessionID)!.tabs.find((tab) => tab.id === tabID)!.view.webContents
    if (contents.isLoading()) await once(contents, "did-stop-loading")
    await command({ op: "access", tabID, enabled: true })
    const route = (request: Request, signal?: AbortSignal) =>
      routeBrowserRequest({ type: "browser_request", id: "targeted", sessionID, request }, undefined, { signal })
    const aggregate = await route({ op: "read_state", tabID })
    assert(aggregate.ok && aggregate.result.truncated)
    assert(!aggregate.result.elements.some((element) => element.text === "Control 319"))
    const targeted = await route({ op: "read_state", tabID, selector: "#control-319" })
    assert(targeted.ok && targeted.result.elements.some((element) => element.text === "Control 319"))
    assert.deepEqual(targeted.result.inspection, { selector: "#control-319", matched: true })
    const absent = await route({ op: "read_state", tabID, selector: "#absent" })
    assert(absent.ok && absent.result.inspection?.matched === false)
    const attached = await route({
      op: "wait_for_element",
      tabID,
      selector: "#attached",
      condition: "attached",
      timeoutMs: 1000,
    })
    assert(attached.ok && attached.result.observedCondition?.condition === "attached")
    await contents.executeJavaScript(
      "setTimeout(() => { const b=document.createElement('button');b.id='delayed';b.textContent='Delayed';document.body.append(b) }, 150);void 0",
    )
    const visible = await route({
      op: "wait_for_element",
      tabID,
      selector: "#delayed",
      condition: "visible",
      timeoutMs: 2000,
    })
    assert(visible.ok && visible.result.observedCondition?.condition === "visible")
    assert(visible.ok && visible.result.elements.some((element) => element.text === "Delayed"))
    const controller = new AbortController()
    const waiting = route({ op: "wait_for_element", tabID, selector: "#never", timeoutMs: 2000 }, controller.signal)
    controller.abort()
    assert.equal((await waiting).ok, false)
    const stale = route({ op: "wait_for_element", tabID, selector: "#never", timeoutMs: 2000 })
    await command({ op: "navigate", tabID, url: `${url}?replacement` })
    assert.equal((await stale).ok, false)
    console.log(
      "PASS targeted inspection: omitted control recovered, absent target, attached/visible waits, cancellation and document replacement",
    )
  } finally {
    dialog.showMessageBox = original
    win.destroy()
    server.closeAllConnections()
    await new Promise<void>((resolve) => server.close(() => resolve()))
  }
}
