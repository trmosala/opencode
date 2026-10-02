import assert from "node:assert/strict"
import { once } from "node:events"
import { createServer } from "node:http"
import { BrowserWindow } from "electron"
import { browserCommand, browserViewport, registerBrowserOwner } from "./tabs"

export async function navigationSmoke() {
  assert(process.env.CM_BROWSER_SMOKE_PROFILE, "Only run through the isolated smoke runner")
  const entered = new Map<string, ReturnType<typeof Promise.withResolvers<void>>>()
  const server = createServer((request, response) => {
    const pending = entered.get(request.url ?? "")
    response.writeHead(200, { "Content-Type": "text/html" })
    if (pending) {
      response.write("<!doctype html><title>Held load</title>")
      pending.resolve()
      return
    }
    response.end(`<!doctype html><title>Navigation fixture</title><p>${request.url}</p>`)
  })
  server.listen(0, "127.0.0.1")
  await once(server, "listening")
  const address = server.address()
  assert(address && typeof address === "object")
  const url = `http://127.0.0.1:${address.port}`
  const win = new BrowserWindow({ show: false, webPreferences: { sandbox: true, contextIsolation: true } })
  const owner = registerBrowserOwner(win)
  const command = (value: Parameters<typeof browserCommand>[2], sessionID = "navigation") =>
    browserCommand(owner, sessionID, value)
  const pending = (tabID: string, path: string) => {
    const entry = Promise.withResolvers<void>()
    entered.set(path, entry)
    const result = command({ op: "navigate", tabID, url: url + path }).then(
      () => "loaded",
      () => "interrupted",
    )
    return { entry: entry.promise, result }
  }
  try {
    await win.loadURL(url)
    const first = (await command({ op: "new" })).activeID!
    const second = (await command({ op: "new" })).activeID!
    const one = owner.groups.get("navigation")!.tabs.find((tab) => tab.id === first)!
    const two = owner.groups.get("navigation")!.tabs.find((tab) => tab.id === second)!
    const held = pending(first, "/held-replace")
    await held.entry
    await command({ op: "navigate", tabID: second, url: url + "/other" })
    assert.equal(two.view.webContents.getURL(), url + "/other")
    await command({ op: "navigate", tabID: first, url: url + "/replacement" })
    assert.equal(await held.result, "interrupted")
    assert.equal(one.view.webContents.getURL(), url + "/replacement")
    assert.equal(one.loadFailed, false)
    assert.equal(two.view.webContents.getURL(), url + "/other")

    const queued = pending(first, "/held-queue")
    await queued.entry
    await Promise.all([
      command({ op: "navigate", tabID: first, url: url + "/superseded" }),
      command({ op: "navigate", tabID: first, url: url + "/newest" }),
    ])
    assert.equal(await queued.result, "interrupted")
    assert.equal(one.view.webContents.getURL(), url + "/newest")

    const stopped = pending(first, "/held-stop")
    await stopped.entry
    await command({ op: "stop", tabID: first })
    assert.equal(await stopped.result, "interrupted")
    assert.equal(one.view.webContents.isLoadingMainFrame(), false)
    await command({ op: "navigate", tabID: first, url: url + "/after-stop" })

    const switched = pending(first, "/held-chat")
    await switched.entry
    const other = (await command({ op: "new" }, "another-chat")).activeID!
    browserViewport(owner, {
      sessionID: "another-chat",
      lease: "another-chat",
      bounds: { x: 0, y: 0, width: 400, height: 300 },
    })
    await command({ op: "navigate", tabID: other, url: url + "/other-chat" }, "another-chat")
    await command({ op: "close", tabID: first })
    assert.equal(await switched.result, "interrupted")
    assert.equal(owner.viewport?.sessionID, "another-chat")
    assert.equal(
      owner.groups.get("navigation")!.tabs.some((tab) => tab.id === first),
      false,
    )
    assert.equal(two.view.webContents.getURL(), url + "/other")
    console.log("PASS native navigation: replacement, cross-tab progress, stop, closure and chat isolation")
  } finally {
    win.destroy()
    server.closeAllConnections()
    await new Promise<void>((resolve) => server.close(() => resolve()))
  }
}
