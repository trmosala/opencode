import assert from "node:assert/strict"
import { createServer } from "node:http"
import { app, BrowserWindow } from "electron"
import { createWorkerWindow } from "./session"

const directory = process.env.CM_WPP_WORKER_FIXTURE_DIR
if (!directory) throw new Error("CM_WPP_WORKER_FIXTURE_DIR is required")
app.setPath("userData", directory)
app.on("window-all-closed", () => {})

const page = `
  <button onclick="window.clicks++" style="position:absolute;left:100px;top:100px;width:150px;height:50px">Run</button>
  <script>
    window.clicks = 0;
    window.framesRun = 0;
    function tick() { window.framesRun++; requestAnimationFrame(tick); }
    requestAnimationFrame(tick);
  </script>
`
// localhost and 127.0.0.1 exercise a cross-site assistant frame like WPP's composer.
const server = createServer((request, response) => {
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
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve))
  const address = server.address()
  if (!address || typeof address === "string") throw new Error("Missing fixture server address")
  // Exercise the production factory, including two workers that remain alive together.
  const workers = [createWorkerWindow(), createWorkerWindow()]
  for (const win of workers) {
    for (const url of [`http://127.0.0.1:${address.port}/`, `http://127.0.0.1:${address.port}/next`]) {
      await win.loadURL(url)
      await wait(300)
      const frames = win.webContents.mainFrame.framesInSubtree
      assert.equal(frames.length, 2)
      const before = await Promise.all(frames.map((frame) => frame.executeJavaScript("window.framesRun")))
      await wait(300)
      const after = await Promise.all(frames.map((frame) => frame.executeJavaScript("window.framesRun")))
      assert.ok(
        after.every((count, index) => {
          const previous = before[index]
          return typeof count === "number" && typeof previous === "number" && count > previous + 2
        }),
        `Hidden animation frames stalled: ${JSON.stringify(before)} -> ${JSON.stringify(after)}`,
      )
      assert.equal(win.isVisible(), false)
      assert.equal(win.isFocused(), false)
    }
    win.showInactive()
    win.hide()
    const before = await win.webContents.executeJavaScript("window.framesRun")
    await wait(300)
    assert.ok((await win.webContents.executeJavaScript("window.framesRun")) > before + 2)
    for (const type of ["mouseMove", "mouseDown", "mouseUp"] as const) {
      win.webContents.sendInputEvent({ type, button: "left", x: 175, y: 125, clickCount: 1 })
    }
    await wait(100)
    assert.equal(await win.webContents.executeJavaScript("window.clicks"), 1)
    assert.equal(win.isVisible(), false)
  }
  console.log("PASS hidden WPP workers render, accept clicks and survive navigation and visibility toggles")
}

void run()
  .finally(() => {
    BrowserWindow.getAllWindows().forEach((win) => win.destroy())
    server.close()
  })
  .then(() => app.exit(0))
  .catch((error) => {
    console.error(error)
    app.exit(1)
  })
