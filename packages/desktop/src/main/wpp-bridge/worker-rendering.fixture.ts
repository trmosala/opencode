// SAFETY: This fixture owns its synthetic native objects, runtime probes and malformed inputs; partial shapes deliberately exercise the production guards.
/* oxlint-disable anti-slop/no-runtime-typeof, anti-slop/no-unsafe-dictionary-type */
import assert from "node:assert/strict"
import { createServer } from "node:http"
import { readFileSync, readdirSync } from "node:fs"
import { join } from "node:path"
import { app, BrowserWindow, desktopCapturer, ImageView, WebContentsView } from "electron"
import { createWorkerWindow } from "./session"
import { hideWorkerWindow, showWorkerWindow } from "./worker-preview"
import { observeWorkerWindow, writeWorkerLog } from "./worker-logging"
import { initLogging } from "../logging"

const directory = process.env.CM_WPP_WORKER_FIXTURE_DIR

if (!directory) throw new Error("CM_WPP_WORKER_FIXTURE_DIR is required")

app.setPath("userData", directory)

app.on("window-all-closed", () => {})

const page = `
  <style>
    body { margin: 0; background: rgb(40, 180, 80); min-height: 3000px; }
    input { position: absolute; left: 500px; top: 100px; }
    @keyframes spin { to { transform: rotate(360deg); } }
    #spinner { width: 300px; height: 300px; background: conic-gradient(red, blue, red); animation: spin 1s linear infinite; }
  </style>
  <div id="spinner"></div>
  <input id="typing" />
  <button onclick="window.clicks++; requestAnimationFrame(async () => { window.completedClicks += (await (await fetch('/pulse')).text()) === 'ok' ? 1 : 0; })" style="position:absolute;left:100px;top:100px;width:150px;height:50px">Run</button>
  <script>
    window.clicks = 0;
    window.completedClicks = 0;
    window.framesRun = 0;
    window.timersRun = 0;
    setInterval(() => window.timersRun++, 25);
    function tick() { window.framesRun++; requestAnimationFrame(tick); }
    requestAnimationFrame(tick);
  </script>
`

// localhost and 127.0.0.1 exercise a cross-site assistant frame like WPP's composer.
const server = createServer((request, response) => {
  if (request.url === "/pulse") {
    response.end("ok")

    return
  }

  const address = server.address()
  response.setHeader("Content-Type", "text/html")
  response.end(
    request.url === "/frame"
      ? page
      : `${page}
    <iframe style="position:absolute;top:200px" src="http://localhost:${address && typeof address === "object" ? address.port : 0}/frame"></iframe>
  `,
  )
})

const wait = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms))

async function run() {
  await app.whenReady()
  initLogging()
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve))
  const address = server.address()

  if (!address || typeof address === "string") throw new Error("Missing fixture server address")
  // Exercise the production factory, including two workers that remain alive together.
  const workers = [createWorkerWindow(), createWorkerWindow()]

  for (const win of workers) {
    const workerId = win.webContents.id
    const records: { event: string; details: Record<string, unknown> }[] = []
    observeWorkerWindow(win.webContents, (event, details, level) => {
      records.push({ event, details })
      writeWorkerLog(workerId, event, { workerId, ...details }, level)
    })

    for (const url of [`http://127.0.0.1:${address.port}/`, `http://127.0.0.1:${address.port}/next`]) {
      await win.loadURL(url)
      await wait(300)
      await assertBackgroundProgress(win)
      assert.equal(win.isVisible(), false)
      assert.equal(win.isFocused(), false)
    }

    await win.webContents.executeJavaScript("console.error('private worker console content')")
    await wait(50)
    assert.ok(records.some((record) => record.event === "navigation-started"))
    assert.ok(records.some((record) => record.event === "navigation-finished"))
    assert.ok(records.some((record) => record.event === "console" && record.details.severity === "error"))

    if (process.env.O1_CODE_PROXY_LOG_PAYLOADS !== "1") {
      assert.ok(!JSON.stringify(records).includes("private worker console content"))
    }

    const debug = showWorkerWindow(win, "WPP worker preview fixture")
    await wait(500)
    assert.equal(win.webContents.getFrameRate(), 15)
    const preview = debug.contentView.children.find((view) => view instanceof WebContentsView)
    assert.ok(preview instanceof WebContentsView)
    assert.ok(debug.contentView.children.some((view) => view instanceof ImageView))
    assert.equal(await preview.webContents.executeJavaScript("typeof require"), "undefined")
    assert.equal(await preview.webContents.executeJavaScript("typeof ipcRenderer"), "undefined")

    for (const type of ["mouseDown", "mouseUp"] as const) {
      preview.webContents.sendInputEvent({ type, button: "left", x: 175, y: 125, clickCount: 1 })
    }

    await wait(300)
    assert.equal(await win.webContents.executeJavaScript("window.completedClicks"), 1)
    await win.webContents.executeJavaScript("document.querySelector('#typing').focus()")

    for (const type of ["keyDown", "keyUp"] as const) {
      preview.webContents.sendInputEvent({ type, keyCode: "A" })
    }

    await wait(100)
    assert.equal(await win.webContents.executeJavaScript("document.querySelector('#typing').value"), "a")

    for (const args of [
      [NaN, 0, 0, 100],
      [0, 0, 0, Infinity],
      [0, "0", 0, 100],
      [0, 0, 0],
    ]) {
      preview.webContents.emit("ipc-message", {}, "worker-preview-wheel", ...args)
    }

    await wait(100)
    assert.equal(await win.webContents.executeJavaScript("scrollY"), 0)

    await preview.webContents.executeJavaScript(
      "window.dispatchEvent(new WheelEvent('wheel', { clientX: 700, clientY: 500, deltaY: 100 }))",
    )
    await wait(300)
    assert.ok((await win.webContents.executeJavaScript("scrollY")) > 0)
    await win.webContents.executeJavaScript("scrollTo(0, 0)")

    const capture = (
      await desktopCapturer.getSources({ types: ["window"], thumbnailSize: { width: 1440, height: 1000 } })
    ).find((source) => source.id === debug.getMediaSourceId())

    assert.ok(capture && !capture.thumbnail.isEmpty(), "Native debug preview must be capturable")
    const size = capture.thumbnail.getSize()
    const offset = (Math.floor(size.height * 0.5) * size.width + Math.floor(size.width * 0.75)) * 4
    // Window captures are color-managed by the OS; require the green page, not exact RGB bytes.
    const pixel = capture.thumbnail.toBitmap().subarray(offset, offset + 3)
    assert.ok(
      pixel[1] > 140 && pixel[1] > pixel[0] + 60 && pixel[1] > pixel[2] + 60,
      `Debug preview did not display the worker page: ${[...pixel]}`,
    )

    await assertBackgroundProgress(win)
    debug.close()
    assert.equal(win.isDestroyed(), false)
    assert.equal(debug.isVisible(), false)
    assert.equal(showWorkerWindow(win, "WPP worker preview fixture"), debug)
    debug.setContentSize(1320, 900)
    await wait(300)
    assert.equal(await win.webContents.executeJavaScript("innerWidth"), 1320)
    assert.equal(await win.webContents.executeJavaScript("innerHeight"), 900)
    debug.minimize()
    await wait(300)
    await assertBackgroundProgress(win)
    debug.restore()
    await wait(300)
    assert.equal(win.webContents.getFrameRate(), 15)
    hideWorkerWindow(win)
    await assertBackgroundProgress(win)

    for (const type of ["mouseMove", "mouseDown", "mouseUp"] as const) {
      win.webContents.sendInputEvent({ type, button: "left", x: 175, y: 125, clickCount: 1 })
    }

    await wait(300)
    assert.equal(await win.webContents.executeJavaScript("window.clicks"), 2)
    assert.equal(await win.webContents.executeJavaScript("window.completedClicks"), 2)
    assert.equal(win.isVisible(), false)
  }

  const logs = join(directory!, "logs")
  const run = join(logs, readdirSync(logs)[0])

  for (const win of workers) {
    const contents = readFileSync(join(run, `wpp-worker-${win.webContents.id}.log`), "utf8")
    assert.ok(contents.includes("navigation-started"))
    assert.ok(contents.includes("console"))

    if (process.env.O1_CODE_PROXY_LOG_PAYLOADS !== "1") assert.ok(!contents.includes("private worker console content"))
  }

  console.log(
    "PASS WPP workers paint at 15 fps, preserve interactive visual debugging and keep timers, frames and requests alive across navigation and visibility toggles",
  )
}

// Exercise an animated page so the cap is measured under continuous repaint demand.
// Chromium can temporarily boost animation callbacks after input; cap paint output while
// requiring callbacks and timers to keep advancing in the root and cross-site iframe.
async function assertBackgroundProgress(win: BrowserWindow) {
  const frames = win.webContents.mainFrame.framesInSubtree
  assert.equal(frames.length, 2)
  const before = await Promise.all(frames.map((frame) => frame.executeJavaScript("window.framesRun")))
  const timers = await Promise.all(frames.map((frame) => frame.executeJavaScript("window.timersRun")))
  const paints = { count: 0 }
  const paint = () => paints.count++
  win.webContents.on("paint", paint)
  const started = Date.now()
  await wait(1000)
  const after = await Promise.all(frames.map((frame) => frame.executeJavaScript("window.framesRun")))
  const elapsed = Date.now() - started
  win.webContents.removeListener("paint", paint)

  assert.equal(win.webContents.getFrameRate(), 15)
  const ceiling = 15 * 1.25
  assert.ok(paints.count > 2, "Hidden worker stopped painting")
  assert.ok(
    paints.count <= (ceiling * elapsed) / 1000 + 2,
    `Worker paint rate exceeded 15 fps: ${paints.count} in ${elapsed}ms`,
  )
  console.log(`Worker paint rate: ${((paints.count * 1000) / elapsed).toFixed(1)} fps`)

  after.forEach((count, index) => {
    const previous = before[index]
    assert.ok(typeof count === "number")
    assert.ok(typeof previous === "number")
    assert.ok(count > previous + 2, `Hidden animation frames stalled: ${previous} -> ${count}`)
  })

  const advanced = await Promise.all(frames.map((frame) => frame.executeJavaScript("window.timersRun")))
  advanced.forEach((count, index) => {
    const previous = timers[index]
    assert.ok(typeof count === "number")
    assert.ok(typeof previous === "number")
    assert.ok(count > previous + 10, `Hidden timers throttled: ${previous} -> ${count}`)
  })
}

void run()
  .finally(() => {
    BrowserWindow.getAllWindows().forEach((win) => {
      if (!win.isDestroyed()) win.destroy()
    })
    server.close()
  })
  .then(() => app.exit(0))
  .catch((error) => {
    console.error(error)
    app.exit(1)
  })
