import assert from "node:assert/strict"
import { once } from "node:events"
import { createServer } from "node:http"
import { setTimeout } from "node:timers/promises"
import { BrowserWindow } from "electron"
import { browserCommand, registerBrowserOwner } from "./tabs"

export async function longNavigationSmoke() {
  assert(process.env.CM_BROWSER_SMOKE_PROFILE, "Only run through the isolated smoke runner")
  const server = createServer((request, response) => {
    if (request.url === "/redirect") {
      const prefix = `http://${request.headers.host}/target?state=`
      response.writeHead(302, { location: prefix + "x".repeat(2096 - prefix.length) }).end()
      return
    }
    response.writeHead(200, { "Content-Type": "text/html" })
    response.end("<!doctype html><title>Redirect complete</title><p>Long redirect loaded</p>")
  })
  server.listen(0, "127.0.0.1")
  await once(server, "listening")
  const address = server.address()
  assert(address && typeof address === "object")
  const base = `http://127.0.0.1:${address.port}`
  const win = new BrowserWindow({ show: false, width: 640, height: 480 })
  const owner = registerBrowserOwner(win)
  try {
    await browserCommand(owner, "long-navigation", { op: "new" })
    const tab = owner.groups.get("long-navigation")!.tabs[0]
    const prefix = `${base}/target?state=`
    const url = prefix + "x".repeat(2096 - prefix.length)
    const loaded = async () => {
      for (let attempt = 0; attempt < 250; attempt++) {
        if (tab.contents.getURL() === url && !tab.contents.isLoadingMainFrame()) return
        await setTimeout(20)
      }
      throw new Error("Long redirect did not load")
    }
    await setTimeout(100)
    await browserCommand(owner, "long-navigation", { op: "navigate", tabID: tab.id, url: `${base}/redirect` })
    await loaded()
    assert.equal(tab.contents.getURL().length, 2096)
    assert.equal(new URL(tab.contents.getURL()).pathname, "/target")
    assert.equal(await tab.view.webContents.executeJavaScript("document.body.innerText.trim()"), "Long redirect loaded")
    await browserCommand(owner, "long-navigation", { op: "navigate", tabID: tab.id, url })
    await loaded()
    assert.equal(tab.contents.getURL(), url)
    await tab.view.webContents.executeJavaScript(`location.href = ${JSON.stringify(`${base}/redirect`)}`)
    await setTimeout(100)
    await loaded()
    assert.equal(tab.contents.getURL(), url)
    assert.equal(await tab.view.webContents.executeJavaScript("document.body.innerText.trim()"), "Long redirect loaded")
  } finally {
    win.destroy()
    server.closeAllConnections()
    await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())))
  }
}
