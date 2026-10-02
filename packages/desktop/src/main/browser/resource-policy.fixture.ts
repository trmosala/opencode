import assert from "node:assert/strict"
import { createServer } from "node:http"
import { once } from "node:events"
import { BrowserWindow, WebContentsView, app } from "electron"
import { registerBrowserOwner, browserCommand } from "./tabs"
import { saveTabs } from "./tab-recovery"

const delay = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))
const waitFor = async (check: () => boolean) => {
  for (let attempt = 0; attempt < 100; attempt++) {
    if (check()) return
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
  const server = createServer((_request, response) => {
    response.writeHead(200, { "Content-Type": "text/html" })
    response.end(`<!doctype html><title>resource fixture</title><body><p>fixture</p><script>
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
    await delay(2_000)
    const eager = processSample(eagerPIDs)
    console.log("RESOURCE_EAGER", JSON.stringify(eager))

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
      await delay(2_000)
      const lazyPIDs = new Set(lazyGroup.tabs.map((tab) => tab.view.webContents.getOSProcessId()))
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
