import assert from "node:assert/strict"
import { once } from "node:events"
import { createServer } from "node:http"
import { setTimeout } from "node:timers/promises"
import { BrowserWindow, dialog } from "electron"
import { browserCommand, browserViewport, registerBrowserOwner } from "./tabs"
import { routeBrowserRequest } from "./router"
import { browserAgentEnabled, setBrowserAgentEnabled } from "./registry"

export async function embeddedInputSmoke() {
  assert(process.env.CM_BROWSER_SMOKE_PROFILE, "Only run through the isolated smoke runner")
  const server = createServer((request, response) => {
    response.writeHead(200, { "Content-Type": "text/html; charset=utf-8" })
    const host = request.headers.host ?? "127.0.0.1"
    const port = host.split(":").at(-1)
    const otherHost = host.startsWith("localhost") ? "127.0.0.1" : "localhost"
    const other = `http://${otherHost}:${port}`
    const path = new URL(request.url ?? "/", `http://${host}`).pathname
    if (path === "/shell") {
      response.end(`<title>Synthetic calendar shell</title>
        <main style="height:420px;overflow:auto;transform:translateZ(0)">
          <div style="height:20px"></div>
          <iframe id="calendar" src="http://${host}/calendar" style="width:600px;height:500px;transform:scale(.8);transform-origin:top left"></iframe>
        </main>`)
      return
    }
    if (path === "/calendar") {
      response.end(`<title>Synthetic calendar</title>
        <h1>Week one</h1><button id="next">Next week</button>
        <iframe id="week" src="${other}/week" style="width:540px;height:450px"></iframe>
        <script>window.events=[];document.addEventListener('click',e=>events.push([e.target.id,e.isTrusted]));document.querySelector('#next').onclick=()=>{window.nextClicked=true;document.querySelector('h1').textContent='Week two'}</script>`)
      return
    }
    if (path === "/week") {
      response.end(`<title>Week two agenda</title>
        <main style="height:450px;overflow:auto">
          <button id="stale">Stale target</button>
          <div style="height:480px"></div>
          <h2>Synthetic events</h2>
          <button id="event">Open synthetic event</button><p id="details"></p>
          <label>Title <input id="title" aria-label="Event title" value="Draft event"></label>
          <label>Category <select aria-label="Event category"><option>Planning</option><option>Review</option></select></label>
          <p id="scroll-marker">Bottom of synthetic week</p>
          <button id="source" draggable="true">Move event</button><button id="target">Tuesday</button><div style="height:100px"></div>
          <p id="drag-result"></p>
        </main>
        <script>
          const title=document.querySelector('#title');
          document.addEventListener('mousemove',e=>window.mouseLocation=[e.clientX,e.clientY,e.target.id]);
          document.addEventListener('contextmenu',e=>{window.contextMenu=[e.target.id,e.isTrusted,e.button];e.preventDefault()});
          document.querySelector('#event').addEventListener('click',()=>document.querySelector('#details').textContent='Synthetic event opened');
          title.addEventListener('keydown',e=>{window.keySeen=e.isTrusted;if(e.key==='a'&&(e.ctrlKey||e.metaKey))title.style.transform='translateY(10000px)'});
          title.addEventListener('input',e=>window.fillTrusted=e.isTrusted);
          document.querySelector('#source').addEventListener('dragstart',e=>{window.dragTrusted=e.isTrusted;e.dataTransfer.setData('text/plain','synthetic')});
          document.querySelector('#target').addEventListener('drop',e=>{e.preventDefault();document.querySelector('#drag-result').textContent='Synthetic event moved'});
          document.querySelector('#target').addEventListener('dragover',e=>e.preventDefault());
          document.querySelector('#event').addEventListener('mouseenter',()=>window.hovered=true);
        </script>`)
      return
    }
    response.writeHead(404)
    response.end()
  })
  server.listen(0, "127.0.0.1")
  await once(server, "listening")
  const address = server.address()
  assert(address && typeof address === "object")
  const url = `http://127.0.0.1:${address.port}/shell`
  const win = new BrowserWindow({ show: false, width: 900, height: 700 })
  const sessionID = `embedded-input-${win.webContents.id}`
  const owner = registerBrowserOwner(win)
  const wasEnabled = browserAgentEnabled()
  const showMessageBox = dialog.showMessageBox
  setBrowserAgentEnabled(true)
  win.showInactive()
  browserViewport(owner, { sessionID, lease: "embedded-input-smoke", bounds: { x: 0, y: 0, width: 880, height: 660 } })
  let sequence = 0
  let removeContextObserver: (() => void) | undefined
  const route = (request: object, control?: Parameters<typeof routeBrowserRequest>[2]) =>
    routeBrowserRequest(
      {
        type: "browser_request",
        id: `embedded-input-${++sequence}`,
        sessionID,
        request,
      } as Parameters<typeof routeBrowserRequest>[0],
      undefined,
      control,
    )
  try {
    await browserCommand(owner, sessionID, { op: "open-link", url, destination: "browser" })
    const tab = owner.groups.get(sessionID)?.tabs.at(-1)
    assert(tab, "production browser command created the synthetic fixture tab")
    const contents = tab.view.webContents
    for (let index = 0; (contents.isLoading() || contents.getURL() !== url) && index < 400; index++)
      await setTimeout(10)
    assert(!contents.isLoading() && contents.getURL() === url)
    dialog.showMessageBox = (async () => ({ response: 1, checkboxChecked: false })) as typeof dialog.showMessageBox
    await browserCommand(owner, sessionID, { op: "access", tabID: tab.id, enabled: true })
    dialog.showMessageBox = showMessageBox
    assert(tab.agentAccess && tab.frameSessions, "one tab grant covers all nested fixture documents")
    await contents.mainFrame.executeJavaScript("document.body.style.height='1200px';window.scrollTo(0,12)")
    await contents.mainFrame.frames[0].executeJavaScript("document.body.style.height='1200px';window.scrollTo(0,8)")

    const isolatedContexts = new Set<string>()
    const observeContexts = (
      _event: Electron.Event,
      method: string,
      params: Record<string, unknown>,
      sessionID?: string,
    ) => {
      if (method !== "Runtime.executionContextCreated") return
      const context = params.context as
        | { id?: unknown; auxData?: { isDefault?: boolean; frameId?: unknown }; name?: unknown }
        | undefined
      if (
        context?.auxData?.isDefault === false &&
        typeof context.id === "number" &&
        typeof context.auxData?.frameId === "string" &&
        typeof context.name === "string" &&
        context.name.startsWith("cm-browser-frame-")
      )
        isolatedContexts.add(`${sessionID ?? ""}:${context.auxData.frameId}:${context.name}:${context.id}`)
    }
    contents.debugger.on("message", observeContexts)
    removeContextObserver = () => contents.debugger.removeListener("message", observeContexts)
    let nativeContextCount: number | undefined
    let isolatedContextBaseline: string | undefined
    const readDocuments = async () => {
      const response = await route({ op: "read_state", tabID: tab.id })
      assert(response.ok, JSON.stringify(response))
      const currentContextCount = tab.frameSessions!.list().length
      assert(
        nativeContextCount === undefined || currentContextCount === nativeContextCount,
        "repeated document reads must not create native frame contexts",
      )
      nativeContextCount = currentContextCount
      const currentIsolatedContexts = [...isolatedContexts].sort().join("\n")
      assert(isolatedContexts.size > 0, "frame isolated-world creation events must be observed")
      assert(
        isolatedContextBaseline === undefined || currentIsolatedContexts === isolatedContextBaseline,
        "repeated document reads must reuse frame-owned isolated contexts",
      )
      isolatedContextBaseline = currentIsolatedContexts
      const docs = response.result.documents ?? []
      const calendar = docs.find((document) => document.elements?.some((element) => element.label === "Next week"))
      const week = docs.find((document) => document.url.endsWith("/week"))
      assert(calendar?.status === "read" || calendar?.status === "truncated")
      assert(week?.status === "read" || week?.status === "truncated")
      return { calendar, week }
    }
    const run = async (frameRef: string, action: object) => {
      const prepared = await route({ op: "prepare_frame_input", tabID: tab.id, frameRef, action })
      assert(
        prepared.ok && prepared.result.frameContext,
        `frame input preparation failed for ${JSON.stringify(action)}: ${JSON.stringify(prepared)}`,
      )
      const response = await route({
        op: "frame_input",
        tabID: tab.id,
        frameRef,
        frameContext: prepared.result.frameContext,
        action,
      })
      assert(response.ok, `frame input failed for ${JSON.stringify(action)}: ${JSON.stringify(response)}`)
      return response
    }

    let { calendar, week } = await readDocuments()
    const staleRef = week.elements?.find((element) => element.label === "Stale target")?.ref
    assert(staleRef)
    const staleAction = { op: "click", ref: staleRef }
    const stalePrepared = await route({
      op: "prepare_frame_input",
      tabID: tab.id,
      frameRef: week.frameRef,
      action: staleAction,
    })
    assert(stalePrepared.ok && stalePrepared.result.frameContext)
    await contents.mainFrame.frames[0].frames[0].executeJavaScript(`(() => {
      const node = document.querySelector('#stale'), replacement = node.cloneNode(true);
      node.replaceWith(replacement); replacement.onclick = () => window.staleClicked = true;
    })()`)
    const stale = await route({
      op: "frame_input",
      tabID: tab.id,
      frameRef: week.frameRef,
      frameContext: stalePrepared.result.frameContext,
      action: staleAction,
    })
    assert(!stale.ok && stale.actionStatus === "not_dispatched", `stale node dispatched: ${JSON.stringify(stale)}`)
    assert.equal(await contents.mainFrame.frames[0].frames[0].executeJavaScript("window.staleClicked"), null)
    const cancelAction = { op: "scroll", deltaX: 0, deltaY: 10 }
    const cancelPrepared = await route({
      op: "prepare_frame_input",
      tabID: tab.id,
      frameRef: week.frameRef,
      action: cancelAction,
    })
    assert(cancelPrepared.ok && cancelPrepared.result.frameContext)
    const beforeInput = new AbortController()
    beforeInput.abort()
    const cancelled = await route(
      {
        op: "frame_input",
        tabID: tab.id,
        frameRef: week.frameRef,
        frameContext: cancelPrepared.result.frameContext,
        action: cancelAction,
      },
      { signal: beforeInput.signal },
    )
    assert(
      !cancelled.ok && cancelled.actionStatus === "not_dispatched",
      `cancelled input dispatched: ${JSON.stringify(cancelled)}`,
    )

    const scrolled = await run(week.frameRef, { op: "scroll", deltaX: 0, deltaY: 520 })
    assert(scrolled.ok, JSON.stringify(scrolled))
    const firstChild = contents.mainFrame.frames[0].frames[0]
    assert(
      Number(await firstChild.executeJavaScript("document.querySelector('main').scrollTop")) > 0,
      "wheel reaches the nested document",
    )
    ;({ calendar, week } = await readDocuments())
    const next = calendar.elements?.find((element) => element.label === "Next week")?.ref
    assert(next)
    const navigation = await run(calendar.frameRef, { op: "click", ref: next })
    assert(
      navigation.ok && navigation.result.visibleText.includes("Week two"),
      `native click navigates the embedded week: ${JSON.stringify(navigation)}`,
    )
    ;({ calendar, week } = await readDocuments())
    const event = week.elements?.find((element) => element.label === "Open synthetic event")?.ref
    const title = week.elements?.find((element) => element.label.includes("Event title"))?.ref
    const category = week.elements?.find((element) => element.label.includes("Event category"))
    const source = week.elements?.find((element) => element.label === "Move event")?.ref
    const target = week.elements?.find((element) => element.label === "Tuesday")?.ref
    assert(event && title && category?.options?.length === 2 && source && target)

    const hovered = await run(week.frameRef, { op: "hover", ref: event })
    assert(hovered.ok, JSON.stringify(hovered))
    assert.equal(
      await contents.mainFrame.frames[0].frames[0].executeJavaScript("window.hovered"),
      true,
      `native hover did not reach event: ${JSON.stringify(await contents.mainFrame.frames[0].frames[0].executeJavaScript("window.mouseLocation"))}`,
    )
    const opened = await run(week.frameRef, { op: "click", ref: event })
    assert(opened.ok && opened.result.visibleText.includes("Synthetic event opened"))
    const rightClicked = await run(week.frameRef, { op: "click", ref: event, mode: "right" })
    assert(rightClicked.ok)

    const filled = await run(week.frameRef, { op: "fill", ref: title, text: "Revisión – 週" })
    assert(filled.ok, JSON.stringify(filled))
    const child = contents.mainFrame.frames[0].frames[0]
    assert.equal(await child.executeJavaScript("document.querySelector('#title').value"), "Revisión – 週")
    assert.equal(await child.executeJavaScript("window.fillTrusted"), true)
    assert.deepEqual(await child.executeJavaScript("window.contextMenu"), ["event", true, 2])
    await child.executeJavaScript(
      "document.querySelector('#title').style.transform='';document.querySelector('#title').focus()",
    )
    const keyAction = { op: "press_key", key: "ArrowRight", modifiers: [] }
    const keyPrepared = await route({
      op: "prepare_frame_input",
      tabID: tab.id,
      frameRef: week.frameRef,
      action: keyAction,
    })
    assert(keyPrepared.ok && keyPrepared.result.frameContext)
    await contents.mainFrame.frames[0].executeJavaScript("document.querySelector('#next').focus()")
    const focusMoved = await route({
      op: "frame_input",
      tabID: tab.id,
      frameRef: week.frameRef,
      frameContext: keyPrepared.result.frameContext,
      action: keyAction,
    })
    assert(
      !focusMoved.ok && focusMoved.actionStatus === "not_dispatched",
      `changed frame focus dispatched a key: ${JSON.stringify(focusMoved)}`,
    )
    await child.executeJavaScript("document.querySelector('#title').focus()")
    assert((await run(week.frameRef, { op: "press_key", key: "ArrowRight", modifiers: [] })).ok)
    assert.equal(await child.executeJavaScript("window.keySeen"), true)

    const selected = await run(week.frameRef, {
      op: "select_option",
      ref: category.ref,
      optionRef: category.options![1].ref,
    })
    assert(selected.ok)
    assert.equal(await child.executeJavaScript("document.querySelector('select').selectedIndex"), 1)
    const dragScroll = await run(week.frameRef, { op: "scroll", deltaX: 0, deltaY: 420 })
    assert(dragScroll.ok, JSON.stringify(dragScroll))
    ;({ calendar, week } = await readDocuments())
    const dragSource = week.elements?.find((element) => element.label === "Move event")?.ref
    const dragTarget = week.elements?.find((element) => element.label === "Tuesday")?.ref
    assert(
      dragSource && dragTarget,
      `drag controls missing after fresh read: ${week.elements?.map((element) => element.label).join(", ")}`,
    )
    const dragged = await run(week.frameRef, { op: "drag", sourceRef: dragSource, targetRef: dragTarget })
    assert(dragged.ok && dragged.actionStatus === "dispatched_observed", JSON.stringify(dragged))
    assert.equal(await child.executeJavaScript("window.dragTrusted"), true)
    assert.equal(
      await child.executeJavaScript("document.querySelector('#drag-result').textContent"),
      "Synthetic event moved",
    )
    ;({ calendar, week } = await readDocuments())
    const cancelRef = week.elements?.find((element) => element.label === "Open synthetic event")?.ref
    assert(cancelRef)
    const cancelDownAction = { op: "click", ref: cancelRef }
    const cancelDownPrepared = await route({
      op: "prepare_frame_input",
      tabID: tab.id,
      frameRef: week.frameRef,
      action: cancelDownAction,
    })
    assert(cancelDownPrepared.ok && cancelDownPrepared.result.frameContext)
    const afterDown = new AbortController()
    let dispatches = 0
    const interrupted = await route(
      {
        op: "frame_input",
        tabID: tab.id,
        frameRef: week.frameRef,
        frameContext: cancelDownPrepared.result.frameContext,
        action: cancelDownAction,
      },
      {
        signal: afterDown.signal,
        onActionDispatch() {
          dispatches++
          if (dispatches === 2) afterDown.abort()
        },
      },
    )
    assert(
      !interrupted.ok && interrupted.actionStatus === "dispatched_uncertain",
      `cancellation after native down was not preserved: ${JSON.stringify(interrupted)}`,
    )
    const held = await route({ op: "read_state", tabID: tab.id })
    assert(!held.ok && held.code === "unavailable", "a possibly held native input quarantines later operations")

    const count = contents.mainFrame.frames.length
    assert(count > 0 && !contents.isDestroyed())
    removeContextObserver?.()
    removeContextObserver = undefined
    await browserCommand(owner, sessionID, { op: "close", tabID: tab.id })
    console.log(
      "PASS embedded input: nested cross-origin transformed frame, native click/hover/drag/fill/key/select/scroll, one synthetic tab grant",
    )
  } finally {
    removeContextObserver?.()
    dialog.showMessageBox = showMessageBox
    win.destroy()
    server.closeAllConnections()
    await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())))
    setBrowserAgentEnabled(wasEnabled)
  }
}
