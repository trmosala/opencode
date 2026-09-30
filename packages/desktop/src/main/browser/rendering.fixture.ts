import assert from "node:assert/strict"
import { createServer } from "node:http"
import { BrowserWindow } from "electron"
import { readFileSync } from "node:fs"
import { join } from "node:path"
import { browserCommand, browserViewport, registerBrowserOwner } from "./tabs"

export async function renderingSmoke() {
  assert(process.env.CM_BROWSER_SMOKE_PROFILE, "Rendering tests require an isolated smoke profile")
  const server = createServer((request, response) => {
    if (request.url === "/account-fill.js") {
      response.writeHead(200, { "Content-Type": "text/javascript" })
      response.end(readFileSync(join(process.env.CM_BROWSER_SMOKE_PROFILE!, "account-fill.js")))
      return
    }
    response.writeHead(200, { "Content-Type": "text/html" })
    response.end('<!doctype html><body style="margin:0;background:rgb(40,180,80)"><h1>Rendering fixture</h1>')
  })
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve))
  const address = server.address()
  assert(address && typeof address !== "string")
  const win = new BrowserWindow({ width: 900, height: 700, show: false })
  const owner = registerBrowserOwner(win)
  const command = (value: Parameters<typeof browserCommand>[2]) => browserCommand(owner, "smoke", value)
  const wait = async (check: () => boolean | Promise<boolean>) => {
    for (let attempt = 0; attempt < 100; attempt++) {
      if (await check()) return
      await new Promise((resolve) => setTimeout(resolve, 30))
    }
    console.log(
      "Rendering fixture state",
      JSON.stringify({
        viewport: owner.viewport,
        attached: !!owner.attached,
        suspended: owner.suspended,
        visible: win.isVisible(),
        dom: await win.webContents.executeJavaScript(
          "({fixture:!!window.fixture, visibility:document.visibilityState, rect:document.querySelector('.min-h-0.flex-1')?.getBoundingClientRect().toJSON(), dimensions:[innerWidth,innerHeight]})",
        ),
      }),
    )
    throw new Error("Rendering fixture condition timed out")
  }
  try {
    await win.loadURL(`http://127.0.0.1:${address.port}/`)
    win.showInactive()
    const state = await command({ op: "new" })
    const tab = owner.groups.get("smoke")!.tabs.find((tab) => tab.id === state.activeID)!
    assert(tab)
    await command({ op: "navigate", tabID: tab.id, url: `http://127.0.0.1:${address.port}/` })
    const attach = (width: number, height: number) =>
      browserViewport(owner, {
        sessionID: "smoke",
        lease: "rendering",
        bounds: { x: 20, y: 80, width, height },
      })
    const paint = async () => {
      for (let attempt = 0; attempt < 60; attempt++) {
        const image = await tab.view.webContents
          .capturePage({ x: 10, y: 60, width: 20, height: 20 })
          .catch(() => undefined)
        const pixel = image?.toBitmap() ?? Buffer.alloc(0)
        if (pixel.length && Math.abs(pixel[0] - 80) < 5 && Math.abs(pixel[1] - 180) < 5 && Math.abs(pixel[2] - 40) < 5)
          return
        await new Promise((resolve) => setTimeout(resolve, 30))
      }
      throw new Error(
        "Attached browser view did not paint its expected green pixels: " +
          JSON.stringify({
            url: tab.contents.getURL(),
            attached: owner.attached === tab,
            bounds: tab.view.getBounds(),
          }),
      )
    }
    attach(700, 500)
    await paint()
    for (let cycle = 0; cycle < 8; cycle++) {
      browserViewport(owner, { sessionID: "smoke", lease: "rendering", bounds: null })
      assert.equal(owner.attached, undefined)
      assert(win.contentView.children.includes(tab.view), "Transient hiding must retain the native parent")
      assert.equal(tab.view.getVisible(), false)
      attach(650 + cycle, 450 + cycle)
      assert.equal(tab.view.getVisible(), true)
      await paint()
      win.setSize(850 + cycle * 5, 650 + cycle * 5)
      await new Promise((resolve) => setTimeout(resolve, 80))
      attach(630 + cycle, 430 + cycle)
      await paint()
    }
    console.log("PASS native view remains parented and paints after repeated hide, show and window resize")
    const failures: unknown[] = []
    win.webContents.debugger.attach("1.3")
    await win.webContents.debugger.sendCommand("Runtime.enable")
    await win.webContents.debugger.sendCommand("Runtime.addBinding", { name: "fixtureRequest" })
    win.webContents.debugger.on("message", (_event, method, params) => {
      if (method !== "Runtime.bindingCalled" || params.name !== "fixtureRequest") return
      void (async () => {
        const input = JSON.parse(params.payload) as
          | { id: number; op: "viewport"; args: [Parameters<typeof browserViewport>[1]] }
          | { id: number; op: "command"; args: [string, unknown] }
        const result =
          input.op === "viewport"
            ? browserViewport(owner, input.args[0])
            : await browserCommand(owner, input.args[0], input.args[1])
        await win.webContents.executeJavaScript(
          `window.fixture.resolve(${input.id}, ${JSON.stringify(result ?? null)})`,
        )
      })().catch((error) => failures.push(error))
    })
    await win.webContents.executeJavaScript(
      "document.body.innerHTML = ''; const script = document.createElement('script'); script.src = '/account-fill.js'; document.body.append(script); true",
    )
    console.log("Rendering stage: fixture load")
    await wait(() => win.webContents.executeJavaScript("!!window.fixture"))
    // The shared mount fixture supplies only a small subset of Tailwind layout utilities.
    await win.webContents.executeJavaScript(
      "const style = document.createElement('style'); style.textContent = '.max-h-64{max-height:16rem}.overflow-y-auto{overflow-y:auto}[class~=\"mb-2.5\"]{margin-bottom:10px}'; document.head.append(style); true",
    )
    // Match the real session side panel: rounded overflow clips the viewport's bottom corners.
    await win.webContents.executeJavaScript(
      "document.body.lastElementChild.style.cssText += ';border-radius:10px;overflow:hidden'; true",
    )
    await win.webContents.executeJavaScript(
      `window.fixture.accept(${JSON.stringify(await command({ op: "state" }))}); true`,
    )
    console.log("Rendering stage: fixture attachment")
    await wait(() => owner.attached === tab && owner.viewport?.lease !== "rendering")
    await paint()
    console.log("PASS mounted browser paints inside the rounded session panel")
    const lease = owner.viewport!.lease
    // Reproduce late native invalidation after an acknowledged renderer viewport,
    // without changing DOM geometry or emitting a second renderer resize event.
    win.emit("resize")
    assert.equal(owner.attached, undefined)
    assert(win.contentView.children.includes(tab.view))
    assert.equal(tab.view.getVisible(), false)
    assert.equal(owner.viewport, undefined)
    console.log("Rendering stage: late resize recovery")
    await wait(() => owner.attached === tab)
    assert.equal(owner.viewport!.lease, lease)
    await paint()
    await win.webContents.executeJavaScript(
      "document.body.insertAdjacentHTML('beforeend', '<div role=dialog id=cover>Fixture dialog</div>'); true",
    )
    console.log("Rendering stage: dialog hide")
    await wait(() => owner.attached === undefined)
    await new Promise((resolve) => setTimeout(resolve, 1200))
    assert.equal(owner.attached, undefined, "Renewal must not show the page over an app dialog")
    assert(win.contentView.children.includes(tab.view))
    assert.equal(tab.view.getVisible(), false, "Parent retention must not expose a view behind a dialog")
    await win.webContents.executeJavaScript("document.getElementById('cover').remove(); true")
    await wait(() => owner.attached === tab)
    await paint()
    for (let cycle = 0; cycle < 3; cycle++) {
      await win.webContents.executeJavaScript("document.querySelector('[data-browser-site]').click(); true")
      await new Promise((resolve) => setTimeout(resolve, 100))
      await wait(() => owner.attached === tab)
      await paint()
    }
    assert.deepEqual(failures, [])
    const next = await command({ op: "new" })
    assert.equal(tab.view.getVisible(), false, "Switching tabs must hide the previous native view")
    assert(win.contentView.children.includes(tab.view))
    await command({ op: "close", tabID: tab.id })
    await wait(() => !owner.groups.get("smoke")!.tabs.includes(tab))
    assert(!win.contentView.children.includes(tab.view), "Closing an inactive tab must remove its native view")
    assert(next.activeID)
    console.log(
      "PASS mounted browser restores late resize invalidation, reflows Site controls and stays hidden behind dialogs",
    )
  } finally {
    win.destroy()
    await new Promise<void>((resolve) => server.close(() => resolve()))
  }
}
