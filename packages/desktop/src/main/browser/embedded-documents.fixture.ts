import assert from "node:assert/strict"
import { once } from "node:events"
import { createServer } from "node:http"
import { setTimeout } from "node:timers/promises"
import { BrowserWindow, dialog } from "electron"
import { browserCommand, browserViewport, registerBrowserOwner } from "./tabs"
import { routeBrowserRequest } from "./router"
import { browserAccessAllowed, browserAgentEnabled, setBrowserAgentEnabled } from "./registry"
import { discoverDocuments } from "./frames"
import { execute } from "./driver"

export async function embeddedDocumentsSmoke() {
  assert(process.env.CM_BROWSER_SMOKE_PROFILE, "Only run through the isolated smoke runner")
  const server = createServer((request, response) => {
    response.writeHead(200, { "Content-Type": "text/html; charset=utf-8" })
    const port = request.headers.host?.split(":").at(-1)
    const destination = `http://${request.headers.host?.startsWith("localhost") ? "127.0.0.1" : "localhost"}:${port}`
    const pathname = new URL(request.url ?? "/", `http://${request.headers.host}`).pathname
    if (pathname === "/shell") {
      response.end(`<!doctype html><title>Calendar shell</title>
        <main><h1>Outlook calendar week</h1><iframe id="week" src="${destination}/week" style="width:520px;height:520px"></iframe>
        <iframe id="sandbox" sandbox="allow-scripts" src="/sandbox"></iframe>
        <iframe id="srcdoc" srcdoc="&lt;title&gt;Inline calendar&lt;/title&gt;&lt;p&gt;SRC-DOC-CALENDAR&lt;/p&gt;"></iframe></main>`)
      return
    }
    if (pathname === "/week") {
      response.end(`<!doctype html><title>Week of 12 October</title>
        <main><h2>Monday 12 October</h2><button aria-label="Open event">Planning review</button>
        <p>09:00 Project meeting</p><p>14:30 Design review</p><input value="frame-input-secret">
        <div id="open-shadow" style="display:block;width:320px;height:48px"></div><script>
          document.querySelector('#open-shadow').attachShadow({mode:'open'}).innerHTML='<p>Shadow agenda</p>';
        </script></main>`)
      return
    }
    if (pathname === "/sandbox") {
      response.end("<!doctype html><title>Sandbox calendar</title><p>SANDBOX-CALENDAR</p>")
      return
    }
    if (pathname !== "/") {
      response.writeHead(404)
      response.end()
      return
    }
    response.end(`<!doctype html><title>Teams calendar shell</title>
      <main style="height:260px;overflow:hidden;transform:translateZ(0)">
        <h1>Teams calendar</h1><iframe id="calendar" src="${destination}/shell"
          style="width:520px;height:420px;transform:scale(.8);transform-origin:top left"></iframe>
        <canvas width="80" height="40"></canvas></main>`)
  })
  server.listen(0, "127.0.0.1")
  await once(server, "listening")
  const address = server.address()
  assert(address && typeof address === "object")
  const url = `http://127.0.0.1:${address.port}/`
  const win = new BrowserWindow({ show: false, width: 900, height: 700 })
  const sessionID = `embedded-documents-${win.webContents.id}`
  const owner = registerBrowserOwner(win)
  const agentEnabled = browserAgentEnabled()
  const showMessageBox = dialog.showMessageBox
  setBrowserAgentEnabled(true)
  win.showInactive()
  browserViewport(owner, {
    sessionID,
    lease: "embedded-documents-smoke",
    bounds: { x: 0, y: 0, width: 880, height: 660 },
  })
  try {
    await browserCommand(owner, sessionID, { op: "open-link", url, destination: "browser" })
    const tab = owner.groups.get(sessionID)?.tabs.at(-1)
    assert(tab, "production browser command created the fixture tab")
    const contents = tab.view.webContents
    for (let i = 0; (contents.isLoading() || contents.getURL() !== url) && i < 400; i++) await setTimeout(10)
    assert(!contents.isLoading() && contents.getURL() === url, "production-created tab finished loading")
    dialog.showMessageBox = (async () => ({ response: 1, checkboxChecked: false })) as typeof dialog.showMessageBox
    await browserCommand(owner, sessionID, { op: "access", tabID: tab.id, enabled: true })
    dialog.showMessageBox = showMessageBox
    assert(tab.agentAccess && tab.frameSessions, "the native one-tab grant is active and frame sessions are guarded")
    for (
      let i = 0;
      (contents.isLoading() || !tab.frameSessions?.list().some((context) => context.frameId !== "")) && i < 400;
      i++
    )
      await setTimeout(10)
    assert(!contents.isLoading(), "bounded embedded-document fixture load")
    const response = await routeBrowserRequest({
      type: "browser_request",
      id: "embedded-documents",
      sessionID,
      request: { op: "read_state", tabID: tab.id },
    })
    assert(response.ok, JSON.stringify(response))
    const docs = response.result.documents ?? []
    const read = docs.filter((document) => document.status === "read" || document.status === "truncated")
    const text = read.map((document) => `${document.title} ${document.visibleText}`).join("\n")
    assert(text.includes("Outlook calendar week"), "nested calendar shell is discoverable")
    assert(text.includes("Project meeting") && text.includes("Design review"), "visible week events are read")
    assert(text.includes("Shadow agenda"), "open shadow content is included")
    assert(text.includes("SRC-DOC-CALENDAR"), "srcdoc remains readable through its native frame")
    assert(text.includes("SANDBOX-CALENDAR"), "sandboxed content remains readable through its native frame")
    const week = read.find((document) => document.visibleText?.includes("Project meeting"))
    assert(week)
    const preparedFrame = await routeBrowserRequest({
      type: "browser_request",
      id: "embedded-documents-prepare",
      sessionID,
      request: { op: "prepare_frame", tabID: tab.id, frameRef: week.frameRef },
    })
    assert(preparedFrame.ok && preparedFrame.result.frameContext, "a nested frame read needs no additional grant")
    const frameWait = await routeBrowserRequest({
      type: "browser_request",
      id: "embedded-documents-frame-wait",
      sessionID,
      request: {
        op: "wait_for_element",
        tabID: tab.id,
        frameRef: week.frameRef,
        frameContext: preparedFrame.result.frameContext,
        selector: "h2",
        condition: "attached",
        timeoutMs: 1000,
      },
    })
    assert(frameWait.ok && frameWait.result.observedCondition?.condition === "attached")
    const explicitPrepare = await routeBrowserRequest({
      type: "browser_request",
      id: "embedded-documents-explicit-prepare",
      sessionID,
      request: { op: "prepare_frame", tabID: tab.id, frameRef: week.frameRef },
    })
    assert(explicitPrepare.ok && explicitPrepare.result.frameContext)
    const explicitRead = await routeBrowserRequest({
      type: "browser_request",
      id: "embedded-documents-explicit-read",
      sessionID,
      request: {
        op: "read_state",
        tabID: tab.id,
        frameRef: week.frameRef,
        frameContext: explicitPrepare.result.frameContext,
      },
    })
    assert(explicitRead.ok && explicitRead.result.visibleText.includes("Project meeting"))
    assert(
      docs.some(
        (document) => document.parentFrameRef && docs.some((parent) => parent.frameRef === document.parentFrameRef),
      ),
      "nested document ancestry uses native frame references",
    )
    assert(
      tab.frameSessions?.list().some((context) => Boolean(context.sessionID)),
      "cross-origin frames are read through attached OOPIF sessions",
    )
    assert(!JSON.stringify(response.result).includes("frame-input-secret"), "editable field values are not read")
    assert(
      docs.every((document) => document.status || document.reason),
      "every known document has a status",
    )
    assert(
      docs.some((document) => document.omissions?.includes("closed_shadow_dom")),
      "visual-only omissions are explicit",
    )
    assert(
      docs.some((document) => document.elements?.some((element) => element.ref.startsWith("frame."))),
      "refs retain frame identity",
    )
    const stale = docs.find((document) => document.status === "read" || document.status === "truncated")
    assert(stale)
    await contents.executeJavaScript("document.querySelector('#calendar').src += '?replaced=1'; void 0")
    let replacement
    for (let attempt = 0; attempt < 100; attempt++) {
      replacement = await routeBrowserRequest({
        type: "browser_request",
        id: `embedded-documents-replacement-${attempt}`,
        sessionID: tab.sessionID,
        request: { op: "read_state", tabID: tab.id },
      })
      if (replacement.ok && replacement.result.documents?.some((document) => document.status === "read")) break
      await setTimeout(20)
    }
    assert(replacement?.ok && replacement.result.documents?.some((document) => document.status === "read"))
    const prepared = await routeBrowserRequest({
      type: "browser_request",
      id: "embedded-documents-stale",
      sessionID,
      request: { op: "prepare_frame", tabID: tab.id, frameRef: stale.frameRef },
    })
    assert(!prepared.ok, "frame replacement invalidates old document references")
    assert(!contents.isDestroyed())
    await browserCommand(owner, sessionID, { op: "close", tabID: tab.id })
    console.log(
      `PASS embedded documents: ${read.length} documents, nested calendar, sandbox/srcdoc, open shadow, stale refs`,
    )
  } finally {
    dialog.showMessageBox = showMessageBox
    win.destroy()
    server.closeAllConnections()
    await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())))
    setBrowserAgentEnabled(agentEnabled)
  }
}
