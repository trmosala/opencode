import assert from "node:assert/strict"
import { createServer } from "node:http"
import { once } from "node:events"
import { BrowserWindow, WebContentsView, app, dialog } from "electron"
import { registerBrowserOwner, browserCommand, browserViewport, browserLinkContext } from "./tabs"
import { saveTabs } from "./tab-recovery"
import { inspectBrowserResources } from "./resource-policy"
import { browserOperationBusy, reserveBrowserTab } from "./registry"

const delay = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))
const waitFor = async (check: () => boolean | Promise<boolean>) => {
  for (let attempt = 0; attempt < 100; attempt++) {
    if (await check()) return
    await delay(100)
  }
  throw new Error("Resource fixture navigation timed out")
}

function processSample(ids: Set<number>) {
  const processes = app.getAppMetrics().filter((metric) => ids.has(metric.pid))
  return {
    renderers: processes.filter((metric) => metric.type === "Tab").length,
    workingSetMiB: Math.round(processes.reduce((sum, metric) => sum + metric.memory.workingSetSize, 0) / 1024),
    cpuPercent: Math.round(processes.reduce((sum, metric) => sum + metric.cpu.percentCPUUsage, 0) * 100) / 100,
  }
}

export async function resourceBaselineSmoke() {
  let requests = 0
  const server = createServer((_request, response) => {
    requests++
    response.writeHead(200, { "Content-Type": "text/html" })
    response.end(`<!doctype html><title>Visited chat fixture</title><body>
      <aside>Chats <button>New chat</button></aside><main id="messages"></main>
      <form><textarea aria-label="Unsent chat draft"></textarea><button>Send</button></form><script>
      const messages = document.querySelector('#messages');
      const transcript = Array.from({length: 400}, (_, index) => ({role: index % 2 ? 'assistant' : 'user', text: ('Synthetic message ' + index + ': repeated chat text. ').repeat(20)}));
      messages.innerHTML = transcript.map(entry => '<article><h3>' + entry.role + '</h3><p>' + entry.text + '</p></article>').join('');
      document.querySelector('textarea').addEventListener('input', () => { window.onbeforeunload = event => { event.preventDefault(); event.returnValue = ''; }; });
      document.querySelector('form').addEventListener('submit', event => event.preventDefault());
      window.ticks = 0; setInterval(() => window.ticks++, 50);
      const canvas = document.createElement('canvas'); canvas.width = canvas.height = 512;
      const context = canvas.getContext('2d'); document.body.append(canvas);
      setInterval(() => { context.fillStyle = '#' + Math.floor(Math.random()*0xffffff).toString(16).padStart(6,'0'); context.fillRect(0,0,512,512); }, 100);
    </script></body>`)
  })
  server.listen(0, "127.0.0.1")
  await once(server, "listening")
  const address = server.address()
  assert(address && typeof address !== "string")
  const origin = `http://127.0.0.1:${address.port}`
  const eagerWindow = new BrowserWindow({ show: false })
  const fixtureViews: WebContentsView[] = []
  let lazyWindowForCleanup: BrowserWindow | undefined
  try {
    const eagerPIDs = new Set<number>()
    for (let index = 0; index < 12; index++) {
      const view = new WebContentsView({ webPreferences: { contextIsolation: true, sandbox: true } })
      fixtureViews.push(view)
      eagerWindow.contentView.addChildView(view)
      view.setVisible(false)
      await view.webContents.loadURL(`${origin}/chat/${index}`)
      eagerPIDs.add(view.webContents.getOSProcessId())
    }
    processSample(eagerPIDs)
    await delay(2_000)
    const eager = processSample(eagerPIDs)
    console.log("RESOURCE_EAGER", JSON.stringify(eager))
    eagerWindow.showInactive()
    fixtureViews[0].setBounds({ x: 0, y: 0, width: 600, height: 400 })
    fixtureViews[0].setVisible(true)
    const probe = fixtureViews[0].webContents
    assert.deepEqual(await inspectBrowserResources(probe), { unsaved: false, media: false, unknown: false })
    await probe.executeJavaScript("document.querySelector('textarea').value = 'Unsent synthetic draft'")
    assert.equal((await inspectBrowserResources(probe)).unsaved, true)
    await probe.executeJavaScript(
      "document.querySelector('textarea').value = ''; document.body.append(document.createElement('iframe'))",
    )
    assert.equal((await inspectBrowserResources(probe)).unknown, true)
    await probe.executeJavaScript(
      "document.querySelector('iframe').remove(); const host = document.createElement('div'); document.body.append(host); host.attachShadow({mode:'open'}).innerHTML = '<div contenteditable>Nested draft</div>'",
    )
    assert.equal((await inspectBrowserResources(probe)).unsaved, true)
    await probe.executeJavaScript(
      `(async () => {
      const bytes = new Uint8Array(44 + 8000 * 2 * 5);
      const data = new DataView(bytes.buffer);
      const text = (offset, value) => Array.from(value).forEach((letter, index) => bytes[offset + index] = letter.charCodeAt(0));
      text(0, 'RIFF'); data.setUint32(4, bytes.length - 8, true); text(8, 'WAVE'); text(12, 'fmt ');
      data.setUint32(16, 16, true); data.setUint16(20, 1, true); data.setUint16(22, 1, true);
      data.setUint32(24, 8000, true); data.setUint32(28, 16000, true); data.setUint16(32, 2, true); data.setUint16(34, 16, true);
      text(36, 'data'); data.setUint32(40, bytes.length - 44, true);
      const audio = document.createElement('audio'); audio.loop = true; audio.muted = true;
      audio.src = URL.createObjectURL(new Blob([bytes], { type: 'audio/wav' }));
      document.body.append(audio); await audio.play().catch(error => { throw new Error(error.name + ': ' + error.message); });
    })()`,
      true,
    )
    assert.equal((await inspectBrowserResources(probe)).media, true)
    await probe.executeJavaScript("document.querySelector('audio').pause()")
    assert.equal((await inspectBrowserResources(probe)).media, false)
    await probe.executeJavaScript(
      "const quota = document.createElement('div'); quota.id='quota'; quota.innerHTML='<span></span>'.repeat(11000); document.body.append(quota)",
    )
    assert.equal((await inspectBrowserResources(probe)).unknown, true)
    await probe.executeJavaScript("document.querySelector('#quota').remove()")
    fixtureViews[0].setVisible(false)
    eagerWindow.hide()
    console.log(
      "PASS resource probe protects unsent drafts, embedded documents, shadow editor drafts and playing muted media",
    )

    const savedSession = "resource-lazy"
    saveTabs({
      sessionID: savedSession,
      active: 0,
      closed: [],
      tabs: Array.from({ length: 12 }, (_, index) => ({
        url: `${origin}/chat/${index}`,
        title: `Saved chat ${index + 1}`,
        navigation: {
          entries: [
            { url: `${origin}/before/${index}`, title: `Before ${index}` },
            { url: `${origin}/chat/${index}`, title: `Saved chat ${index + 1}` },
          ],
          activeIndex: 1,
        },
      })),
    })
    const lazyWindow = new BrowserWindow({ show: false })
    lazyWindowForCleanup = lazyWindow
    const lazyOwner = registerBrowserOwner(lazyWindow)
    try {
      const restored = await browserCommand(lazyOwner, savedSession, { op: "state" })
      const lazyGroup = lazyOwner.groups.get(savedSession)!
      fixtureViews.push(...lazyGroup.tabs.map((tab) => tab.view))
      const active = lazyGroup.tabs.find((tab) => tab.id === restored.activeID)!
      await active.restore?.()
      const lazyPIDs = new Set(lazyGroup.tabs.map((tab) => tab.view.webContents.getOSProcessId()))
      processSample(lazyPIDs)
      await delay(2_000)
      const lazy = processSample(lazyPIDs)
      const dormant = lazyGroup.tabs.filter((tab) => tab.deferredRestore)
      assert.equal(dormant.length, 11)
      assert(dormant.every((tab) => !tab.agentAccess && tab.saved.navigation?.entries.length === 2))
      const initialLoads = lazyGroup.tabs.filter((tab) => tab.contents.getURL().startsWith(origin))
      assert.equal(initialLoads.length, 1)
      const beforeActivation = lazyGroup.tabs.find((tab) => tab !== active)!
      const beforePID = beforeActivation.view.webContents.getOSProcessId()
      const beforeRestored = await browserCommand(lazyOwner, savedSession, { op: "select", tabID: beforeActivation.id })
      assert.equal(beforeRestored.tabs.find((tab) => tab.id === beforeActivation.id)?.url, beforeActivation.saved.url)
      await beforeActivation.restore?.()
      await waitFor(() => beforeActivation.contents.getURL() === beforeActivation.saved.url)
      const afterActivationPID = beforeActivation.view.webContents.getOSProcessId()
      assert(beforeActivation.contents.getURL().startsWith(origin))
      assert(!beforeActivation.agentAccess, "Restored pages do not inherit Agent Access")
      assert(
        beforeActivation.view.webContents.navigationHistory.canGoBack(),
        "Saved history remains available after lazy restore",
      )
      await browserCommand(lazyOwner, savedSession, { op: "back", tabID: beforeActivation.id })
      await waitFor(
        () => beforeActivation.contents.getURL() === `${origin}/before/${lazyGroup.tabs.indexOf(beforeActivation)}`,
      )
      console.log(
        "RESOURCE_RESTORE",
        JSON.stringify({
          runtime: process.versions.electron,
          chromium: process.versions.chrome,
          savedTabs: 12,
          eager,
          lazyBeforeActivation: lazy,
          dormantTabs: dormant.length,
          eagerPIDs: eagerPIDs.size,
          lazyPIDs: lazyPIDs.size,
          activatedPIDChanged: beforePID !== afterActivationPID,
          processMemoryReductionMiB: eager.workingSetMiB - lazy.workingSetMiB,
        }),
      )
    } finally {
      await closeFixtureViews(fixtureViews)
      if (!lazyWindow.isDestroyed()) lazyWindow.destroy()
    }
    await resourceUnloadSmoke(origin, () => requests)
  } finally {
    await closeFixtureViews(fixtureViews)
    if (lazyWindowForCleanup && !lazyWindowForCleanup.isDestroyed()) lazyWindowForCleanup.destroy()
    eagerWindow.destroy()
    server.closeAllConnections()
    if (server.listening)
      await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())))
  }
}

async function closeFixtureViews(views: WebContentsView[]) {
  await Promise.all(
    views.map(async (view) => {
      const contents = view.webContents
      if (!contents || contents.isDestroyed()) return
      const destroyed = once(contents, "destroyed")
      contents.close({ waitForBeforeUnload: false })
      await Promise.race([
        destroyed,
        delay(5_000).then(() => {
          throw new Error(`Fixture WebContents ${contents.id} did not destroy`)
        }),
      ])
    }),
  )
}

export async function resourceUnloadSmoke(origin: string, requestCount: () => number) {
  const sessionID = "resource-visited-unload"
  saveTabs({
    sessionID,
    active: 11,
    closed: [],
    tabs: Array.from({ length: 12 }, (_, index) => ({
      url: `${origin}/visited/${index}`,
      title: `Visited chat ${index}`,
      navigation: {
        entries: [
          { url: `${origin}/before/${index}`, title: `Before ${index}` },
          { url: `${origin}/visited/${index}`, title: `Visited chat ${index}` },
        ],
        activeIndex: 1,
      },
    })),
  })
  const win = new BrowserWindow({ show: false, width: 800, height: 600 })
  const owner = registerBrowserOwner(win)
  const consent = dialog.showMessageBox.bind(dialog)
  let answer = 1
  let prompts = 0
  let dialogHook: (() => Promise<void>) | undefined
  dialog.showMessageBox = (async () => {
    prompts++
    await dialogHook?.()
    return { response: answer, checkboxChecked: false }
  }) as typeof dialog.showMessageBox
  const command = (tabID: string) => browserCommand(owner, sessionID, { op: "tab-unload", tabID })
  try {
    await win.loadURL("about:blank")
    win.showInactive()
    await browserCommand(owner, sessionID, { op: "state" })
    browserLinkContext(owner, sessionID, "resource-fixture")
    browserViewport(owner, { sessionID, lease: "resource-fixture", bounds: { x: 0, y: 0, width: 780, height: 550 } })
    const group = owner.groups.get(sessionID)!
    for (const tab of group.tabs) await tab.restore?.()
    console.log("RESOURCE_UNLOAD visited pages loaded")
    const tabs = group.tabs.slice()
    const pids = new Set(tabs.map((tab) => tab.view.webContents.getOSProcessId()))
    processSample(pids)
    await delay(2_000)
    const before = processSample(pids)
    const protectedTab = tabs[0]
    await protectedTab.view.webContents.executeJavaScript(
      "document.querySelector('textarea').value = 'Synthetic unsaved draft'",
    )
    await assert.rejects(command(protectedTab.id))
    assert(!protectedTab.contents.isDestroyed())
    assert.equal(prompts, 0)
    await protectedTab.view.webContents.executeJavaScript("document.querySelector('textarea').value = ''")
    protectedTab.saved.pinned = true
    await assert.rejects(command(protectedTab.id))
    protectedTab.saved.pinned = false
    protectedTab.agentAccess = true
    await assert.rejects(command(protectedTab.id))
    protectedTab.agentAccess = false
    browserOperationBusy.add(protectedTab.id)
    await assert.rejects(command(protectedTab.id))
    browserOperationBusy.delete(protectedTab.id)
    const releaseReservation = reserveBrowserTab(protectedTab, {})
    console.log("RESOURCE_UNLOAD reservation acquired")
    await assert.rejects(command(protectedTab.id))
    releaseReservation()
    console.log("RESOURCE_UNLOAD reservation protected and released")
    group.downloads = [{ id: "synthetic-transfer", filename: "fixture.bin", state: "saving" }]
    await assert.rejects(command(protectedTab.id))
    group.downloads = []
    await assert.rejects(command(tabs[11].id))
    console.log("RESOURCE_UNLOAD primary protections passed")
    assert.equal(prompts, 0)
    answer = 0
    await command(protectedTab.id)
    assert(!protectedTab.contents.isDestroyed(), "Cancelling explicit unloading must retain the live document")
    answer = 1
    dialogHook = () => browserCommand(owner, sessionID, { op: "select", tabID: protectedTab.id }).then(() => undefined)
    await assert.rejects(command(protectedTab.id))
    assert(!protectedTab.contents.isDestroyed(), "Selecting a tab invalidates pending unload approval")
    dialogHook = undefined
    await browserCommand(owner, sessionID, { op: "select", tabID: tabs[11].id })
    dialogHook = () => tabs[2].view.webContents.loadURL(`${origin}/visited/2#changed`)
    await assert.rejects(command(tabs[2].id))
    console.log("RESOURCE_UNLOAD stale approval protections passed")
    assert(!tabs[2].contents.isDestroyed(), "Navigation invalidates pending unload approval")
    dialogHook = undefined
    const vetoTab = tabs[1]
    await browserCommand(owner, sessionID, { op: "select", tabID: vetoTab.id })
    browserViewport(owner, { sessionID, lease: "resource-fixture", bounds: { x: 0, y: 0, width: 780, height: 550 } })
    await vetoTab.view.webContents.executeJavaScript(`{
      const arm = document.createElement('button'); arm.id = 'arm-veto'; arm.textContent = 'Arm unload guard';
      arm.style = 'position:fixed;left:20px;top:20px;width:180px;height:80px;z-index:999';
      arm.onclick = () => { window.vetoActivated = true; window.onbeforeunload = event => { event.preventDefault(); event.returnValue = ''; }; };
      document.body.append(arm);
    }`)
    win.focus()
    vetoTab.view.webContents.focus()
    await delay(100)
    vetoTab.view.webContents.sendInputEvent({ type: "mouseDown", x: 60, y: 50, button: "left", clickCount: 1 })
    vetoTab.view.webContents.sendInputEvent({ type: "mouseUp", x: 60, y: 50, button: "left", clickCount: 1 })
    await waitFor(() => vetoTab.view.webContents.executeJavaScript("window.vetoActivated === true"))
    console.log("RESOURCE_UNLOAD native guard activated")
    await browserCommand(owner, sessionID, { op: "select", tabID: tabs[11].id })
    await command(vetoTab.id).catch(() => undefined)
    console.log("RESOURCE_UNLOAD native guard settled")
    assert(
      !vetoTab.contents.isDestroyed(),
      "Native beforeunload veto must retain a document even after unload confirmation",
    )
    await vetoTab.view.webContents.executeJavaScript(
      "window.onbeforeunload = null; document.querySelector('#arm-veto').remove()",
    )
    const closed = group.closed.slice()
    const activeID = group.activeID
    const initialRequests = requestCount()
    for (const tab of tabs.slice(0, 11)) await command(tab.id)
    console.log("RESOURCE_UNLOAD clean pages settled")
    assert.equal(group.tabs.length, 12)
    assert.equal(group.activeID, activeID)
    assert.deepEqual(group.closed, closed, "Unloading is not an explicit tab closure")
    const dormant = group.tabs.filter((tab) => tab.deferredRestore)
    assert.equal(dormant.length, 11)
    assert(dormant.every((tab) => !tab.agentAccess))
    assert(tabs.slice(0, 11).every((tab) => tab.contents.isDestroyed()))
    assert(
      dormant.every((tab) => !tabs.some((old) => old.id === tab.id)),
      "Recreated views receive fresh target identity",
    )
    assert(dormant.every((tab) => (tab.saved.navigation?.entries.length ?? 0) >= 2))
    assert.equal(requestCount(), initialRequests, "Unloading must not reload a URL, submit a form or replay work")
    await delay(2_000)
    const after = processSample(new Set(group.tabs.map((tab) => tab.view.webContents.getOSProcessId())))
    console.log(
      "RESOURCE_VISITED_UNLOAD",
      JSON.stringify({
        before,
        after,
        dormant: dormant.length,
        workingSetReductionMiB: before.workingSetMiB - after.workingSetMiB,
      }),
    )
    const restored = group.tabs[0]
    await browserCommand(owner, sessionID, { op: "select", tabID: restored.id })
    await restored.restore?.()
    await waitFor(() => restored.contents.getURL() === `${origin}/visited/0`)
    assert(!restored.agentAccess)
    await browserCommand(owner, sessionID, { op: "back", tabID: restored.id })
    await waitFor(() => restored.contents.getURL() === `${origin}/before/0`)
    console.log(
      "PASS visited resource unload protects active/granted/pinned/busy/reserved/transfer/draft tabs, cancellation, stale selection/navigation approval, native beforeunload veto, private history restore and fresh target identity",
    )
  } finally {
    dialogHook = undefined
    dialog.showMessageBox = consent
    await closeFixtureViews([...owner.groups.values()].flatMap((group) => group.tabs.map((tab) => tab.view)))
    win.destroy()
  }
}
