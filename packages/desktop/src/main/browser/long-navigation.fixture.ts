import assert from "node:assert/strict"
import { once } from "node:events"
import { createServer } from "node:http"
import { setTimeout } from "node:timers/promises"
import { BrowserWindow, dialog } from "electron"
import { browserCommand, browserViewport, registerBrowserOwner } from "./tabs"
import { routeBrowserRequest } from "./router"
import { parseRequest } from "@cookiemonster/cm-browser/protocol"

export async function longNavigationSmoke() {
  assert(process.env.CM_BROWSER_SMOKE_PROFILE, "Only run through the isolated smoke runner")
  const submitted: { length: number; body: string }[] = []
  const completed: { length: number; method: string | undefined }[] = []
  const redirects: { length: number; cancelled: boolean; guarded: boolean }[] = []
  const payload = "Synthetic space + ampersand & Unicode résumé"
  const server = createServer((request, response) => {
    const base = `http://${request.headers.host}`
    const address = new URL(request.url ?? "/", base)
    const length = Number(address.searchParams.get("length"))
    if (address.pathname === "/post-shell") {
      response.writeHead(200, { "Content-Type": "text/html; charset=utf-8" })
      response.end(`<!doctype html><title>Synthetic authentication handoff</title><body>
        <form hidden method="post" action="/continue?length=${length}">
          <input name="payload" value="Synthetic space + ampersand &amp; Unicode résumé">
        </form><script>document.querySelector('form').submit()</script>`)
      return
    }
    if (address.pathname === "/continue" && request.method === "POST") {
      let body = ""
      request.setEncoding("utf8")
      request.on("data", (chunk: string) => {
        body += chunk
      })
      request.once("end", () => {
        submitted.push({ length, body })
        const prefix = `${base}/done?length=${length}&state=`
        response.writeHead(302, { location: prefix + "x".repeat(length - prefix.length) }).end()
      })
      return
    }
    if (address.pathname === "/route-redirect") {
      const prefix = `${base}/done?length=${length}&state=`
      response.writeHead(302, { location: prefix + "x".repeat(length - prefix.length) }).end()
      return
    }
    if (address.pathname === "/done") {
      completed.push({ length: request.url!.length + base.length, method: request.method })
      response.writeHead(200, { "Content-Type": "text/html; charset=utf-8" })
      response.end("<!doctype html><title>Long navigation complete</title><p>Long navigation complete</p>")
      return
    }
    response.writeHead(404).end()
  })
  server.listen(0, "127.0.0.1")
  await once(server, "listening")
  const address = server.address()
  assert(address && typeof address === "object")
  const base = `http://127.0.0.1:${address.port}`
  const win = new BrowserWindow({ show: false, width: 640, height: 480 })
  const owner = registerBrowserOwner(win)
  const originalDialog = dialog.showMessageBox
  const sessionID = `long-navigation-${win.webContents.id}`
  const destination = (length: number) => {
    const prefix = `${base}/done?length=${length}&state=`
    return prefix + "x".repeat(length - prefix.length)
  }
  const loaded = async (contents: Electron.WebContents, url: string) => {
    for (let attempt = 0; attempt < 150; attempt++) {
      if (contents.getURL() === url && !contents.isLoadingMainFrame()) {
        assert.equal(await contents.executeJavaScript("document.body.innerText.trim()"), "Long navigation complete")
        return
      }
      await setTimeout(20)
    }
    assert.fail(
      `Native long navigation failed: expected ${url.length} characters, observed ${contents.getURL().length}; redirect witness ${JSON.stringify(redirects)}`,
    )
  }
  try {
    await browserCommand(owner, sessionID, { op: "new" })
    const group = owner.groups.get(sessionID)!
    const tab = group.tabs[0]
    const contents = tab.view.webContents
    contents.on("will-redirect", (event, url, _inPlace, main) => {
      if (main)
        redirects.push({ length: url.length, cancelled: event.defaultPrevented, guarded: !!tab.navigationAllowed })
    })
    for (const length of [2096, 8192]) {
      await browserCommand(owner, sessionID, {
        op: "navigate",
        tabID: tab.id,
        url: `${base}/post-shell?length=${length}`,
      }).catch(() => undefined)
      await loaded(contents, destination(length))
      const posts = submitted.filter((entry) => entry.length === length)
      assert.equal(posts.length, 1, "The native POST handoff is submitted once")
      assert.equal(new URLSearchParams(posts[0].body).get("payload"), payload)
      assert.equal(completed.filter((entry) => entry.length === length).length, 1)
      assert(
        completed.every((entry) => entry.method === "GET"),
        "Chromium retains normal POST/302/GET semantics",
      )
    }
    await browserCommand(owner, sessionID, { op: "navigate", tabID: tab.id, url: destination(2096) })
    await loaded(contents, destination(2096))
    await contents.executeJavaScript(`location.assign(${JSON.stringify(destination(8192))}); void 0`)
    await loaded(contents, destination(8192))
    await contents.executeJavaScript(`window.open(${JSON.stringify(destination(2096))}); void 0`, true)
    for (let attempt = 0; group.tabs.length < 2 && attempt < 100; attempt++) await setTimeout(20)
    const popup = group.tabs.find((entry) => entry !== tab)
    assert(popup, "Native long-URL popup created a private browser tab")
    await loaded(popup.view.webContents, destination(2096))
    assert(!tab.agentAccess && !popup.agentAccess, "Long native navigation does not grant Agent Access")
    win.showInactive()
    await browserCommand(owner, sessionID, { op: "select", tabID: tab.id })
    browserViewport(owner, { sessionID, lease: "long-navigation", bounds: { x: 0, y: 0, width: 620, height: 450 } })
    dialog.showMessageBox = (async () => ({ response: 1, checkboxChecked: false })) as typeof dialog.showMessageBox
    await browserCommand(owner, sessionID, { op: "access", tabID: tab.id, enabled: true })
    dialog.showMessageBox = originalDialog
    const request = { op: "navigate", tabID: tab.id, url: `${base}/route-redirect?length=2096` } as const
    const prepare = await routeBrowserRequest({
      type: "browser_request",
      id: "long-navigation-prepare",
      sessionID,
      request: { op: "prepare_write", request },
    })
    assert(prepare.ok && prepare.result.context)
    const response = await routeBrowserRequest({
      type: "browser_request",
      id: "long-navigation-action",
      sessionID,
      request: { ...request, context: prepare.result.context },
    })
    assert(response.ok, JSON.stringify(response))
    await loaded(contents, destination(2096))
    assert(
      redirects.some((entry) => entry.length === 2096 && entry.guarded && !entry.cancelled),
      "A long redirect remains allowed while the actual agent route's navigation guard is active",
    )
    assert.equal(
      parseRequest({ op: "navigate", tabID: tab.id, url: destination(2096) }),
      undefined,
      "Explicit long agent destinations remain rejected",
    )
    assert.equal(submitted.length, 2, "The guarded tool navigation never replays previous POST handoffs")
    assert(
      redirects.length >= 2 && redirects.every((entry) => !entry.cancelled),
      "Native redirect witnesses confirm no guard cancellation",
    )
    console.log(
      "PASS native long navigation: blank auto-POST/302 handoff at 2096/8192 characters, exact synthetic payload, direct UI navigation, scripted navigation, private popup and guarded agent-route redirect with short explicit tool limits",
    )
  } finally {
    dialog.showMessageBox = originalDialog
    owner.shutting = true
    owner.groups.forEach((group) =>
      group.tabs.slice().forEach((tab) => {
        if (!tab.contents.isDestroyed()) tab.view.webContents.close({ waitForBeforeUnload: false })
      }),
    )
    win.destroy()
    server.closeAllConnections()
    await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())))
  }
}
