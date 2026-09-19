import assert from "node:assert/strict"
import { randomUUID } from "node:crypto"
import { createServer, type ServerResponse } from "node:http"
import { BrowserWindow } from "electron"
import { observeConsole } from "./console-diagnostics"
import { observeNetwork } from "./network-diagnostics"

export async function diagnosticsSmoke() {
  const win = new BrowserWindow({
    show: false,
    webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false },
  })
  try {
    await win.loadURL("data:text/html,<title>diagnostics</title>")
    const observation = observeConsole(win.webContents, 250, () => {})
    await win.webContents.executeJavaScript(`
      console.debug("debug secret");
      console.info("info secret");
      console.warn("warning secret");
      console.error("error secret");
    `)
    const result = await observation
    assert(result.debug >= 1)
    assert(result.info >= 1)
    assert(result.warning >= 1)
    assert(result.error >= 1)
    assert.equal(result.total, result.debug + result.info + result.warning + result.error + result.other)
    assert(!JSON.stringify(result).includes("secret"))
    assert.equal(win.webContents.listenerCount("console-message"), 0)
    console.log("PASS native bounded console diagnostics")
    await networkSmoke()
  } finally {
    if (!win.isDestroyed()) win.destroy()
  }
}

async function networkSmoke() {
  const held = new Map<string, ServerResponse>()
  const server = createServer((request, response) => {
    const path = new URL(request.url!, "http://127.0.0.1").pathname
    response.setHeader("Cache-Control", "no-store")
    if (path.startsWith("/held/")) {
      held.set(path, response)
      return
    }
    if (path === "/failure") {
      request.socket.destroy()
      return
    }
    if (path === "/redirect") {
      response.writeHead(302, { Location: "/200" })
      response.end()
      return
    }
    if (/^\/[245]\d\d$/.test(path)) {
      response.writeHead(Number(path.slice(1)), { "Content-Type": "text/plain" })
      response.end("fixture secret")
      return
    }
    response.writeHead(200, { "Content-Type": "text/html" })
    response.end("<title>network fixture</title>")
  })
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve))
  const address = server.address()
  assert(address && typeof address !== "string")
  const url = `http://127.0.0.1:${address.port}`
  const partition = `network-fixture-${randomUUID()}`
  const windows = [0, 1].map(
    () =>
      new BrowserWindow({
        show: false,
        webPreferences: {
          partition,
          sandbox: true,
          contextIsolation: true,
          nodeIntegration: false,
          backgroundThrottling: false,
        },
      }),
  )
  const contents = windows[0].webContents
  const foreign = windows[1].webContents
  const requests = contents.session.webRequest
  const wait = async (ready: () => boolean) => {
    const end = Date.now() + 2000
    while (!ready()) {
      assert(Date.now() < end, "Native network fixture did not reach its checkpoint")
      await new Promise((resolve) => setTimeout(resolve, 10))
    }
  }
  try {
    await Promise.all(windows.map((win) => win.loadURL(url)))
    assert.equal(foreign.session, contents.session)
    await contents.executeJavaScript(`new Promise(resolve => {
      const frame = document.createElement("iframe");
      frame.onload = resolve; frame.src = "/frame"; document.body.append(frame);
    })`)
    const child = contents.mainFrame.frames[0]
    assert(child)
    const observation = observeNetwork(requests, contents, 1500, () => {})
    await foreign.executeJavaScript(`fetch("/500").then(r => r.text())`)
    await child.executeJavaScript(`fetch("/500").then(r => r.text())`)
    assert.deepEqual(
      await contents.executeJavaScript(`(async () => {
      const ok = await fetch("/200"); await ok.text();
      const missing = await new Promise(resolve => {
        const xhr = new XMLHttpRequest(); xhr.open("GET", "/404");
        xhr.onload = () => resolve(xhr.status); xhr.send();
      });
      const error = await fetch("/500"); await error.text();
      const redirect = await fetch("/redirect"); await redirect.text();
      const failed = await fetch("/failure").then(() => false, () => true);
      return [ok.status, missing, error.status, redirect.status, failed];
    })()`),
      [200, 404, 500, 200, true],
    )
    const result = await observation
    assert.deepEqual(result, {
      durationMs: 1500,
      http1xx: 0,
      http2xx: 2,
      http3xx: 0,
      http4xx: 1,
      http5xx: 1,
      other: 0,
      failed: 1,
      total: 5,
    })
    assert(!JSON.stringify(result).includes("secret"))
    assert.equal(contents.debugger.isAttached(), false)
    console.log(
      "PASS native network: Fetch/XHR, HTTP classes, redirect final response, transport failure, tab/frame isolation",
    )

    const cancel = new AbortController()
    const cancelled = observeNetwork(requests, contents, 1000, () => {}, cancel.signal)
    const rejected = assert.rejects(cancelled, /Network observation unavailable/)
    const survivor = observeNetwork(requests, foreign, 500, () => {})
    cancel.abort()
    await rejected
    await foreign.executeJavaScript(`fetch("/200").then(r => r.text())`)
    assert.equal((await survivor).http2xx, 1)
    console.log("PASS native network: cancelling one observer preserves another on the shared Session")

    const aborted = observeNetwork(requests, contents, 500, () => {})
    await contents.executeJavaScript(`window.requestAbort = new AbortController();
      window.requestDone = fetch("/held/abort", { signal: window.requestAbort.signal })
        .then(() => false, () => true); true`)
    await wait(() => held.has("/held/abort"))
    await contents.executeJavaScript("window.requestAbort.abort(); window.requestDone")
    assert.equal((await aborted).failed, 1)
    held.get("/held/abort")!.destroy()
    held.delete("/held/abort")

    // A second observer keeps native interception live before the target subscribes.
    const keeper = new AbortController()
    const keeping = observeNetwork(requests, foreign, 2000, () => {}, keeper.signal)
    const stopped = assert.rejects(keeping)
    await contents.executeJavaScript(`window.inflight = fetch("/held/inflight").then(r => r.text()); true`)
    await wait(() => held.has("/held/inflight"))
    const inflight = observeNetwork(requests, contents, 500, () => {})
    held.get("/held/inflight")!.end("fixture secret")
    held.delete("/held/inflight")
    await contents.executeJavaScript("window.inflight")
    assert.equal((await inflight).http2xx, 1)
    keeper.abort()
    await stopped
    console.log("PASS native network: request abort and already-in-flight completion semantics")

    const navigation = observeNetwork(requests, contents, 500, () => {
      assert.equal(contents.getURL(), `${url}/`)
    })
    const invalidated = assert.rejects(navigation)
    await windows[0].loadURL(`${url}/other`)
    await invalidated
    console.log("PASS native network: changed source discards counts")
  } finally {
    windows.forEach((win) => {
      if (!win.isDestroyed()) win.destroy()
    })
    held.forEach((response) => response.destroy())
    server.closeAllConnections()
    await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())))
  }
}
