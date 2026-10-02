import assert from "node:assert/strict"
import { BrowserWindow } from "electron"
import { browserViewportBounds } from "../../../../app/src/components/browser-panel/browser-viewport"
import { browserCommand, browserViewport, registerBrowserOwner } from "./tabs"

export async function overlaysSmoke() {
  assert(process.env.CM_BROWSER_SMOKE_PROFILE, "Only run through the isolated smoke runner")
  const win = new BrowserWindow({
    width: 900,
    height: 640,
    show: true,
    webPreferences: { sandbox: true, contextIsolation: true },
  })
  const sessionID = "overlays"
  const lease = "overlays-fixture"
  try {
    await win.loadURL(
      "data:text/html," +
        encodeURIComponent(`<!doctype html><meta charset="utf-8"><style>
          html,body{margin:0;width:100%;height:100%}#viewport{position:fixed;left:100px;top:100px;width:300px;height:200px}
          #overlay{position:fixed;left:550px;top:450px;width:120px;height:50px}
        </style><div id="viewport"></div><button id="overlay" onclick="window.received=(window.received||0)+1;window.trusted=event.isTrusted">Menu</button>`),
    )
    const owner = registerBrowserOwner(win)
    const currentBounds = () => (Reflect.get(owner, "viewport") as { bounds?: unknown } | undefined)?.bounds
    const tabID = (await browserCommand(owner, sessionID, { op: "new" })).activeID!
    const nativeTab = owner.groups.get(sessionID)!.tabs.find((tab) => tab.id === tabID)!
    const boundsExpression = `(${browserViewportBounds.toString()})(document.querySelector('#viewport'))`
    const bounds = await win.webContents.executeJavaScript(boundsExpression)
    assert.deepEqual(bounds, { x: 100, y: 100, width: 300, height: 200 })
    browserViewport(owner, { sessionID, lease, bounds })
    assert.deepEqual(currentBounds(), bounds)

    await win.webContents.executeJavaScript("document.querySelector('#overlay').setAttribute('role','tooltip')")
    assert.deepEqual(
      await win.webContents.executeJavaScript(boundsExpression),
      bounds,
      "Disjoint tooltip must leave page visible",
    )
    await win.webContents.executeJavaScript("document.querySelector('#overlay').style.cssText='left:200px;top:120px'")
    const tooltipOverlap = await win.webContents.executeJavaScript(boundsExpression)
    assert.equal(tooltipOverlap, null, "Overlapping tooltip must hide the page")
    browserViewport(owner, { sessionID, lease, bounds: tooltipOverlap })
    assert.equal(currentBounds(), undefined, "Native page must hide under an overlapping tooltip")
    const clicked = win.webContents.executeJavaScript(
      "new Promise(resolve => document.querySelector('#overlay').addEventListener('click', event => resolve(event.isTrusted), {once:true}))",
    ) as Promise<boolean>
    win.webContents.sendInputEvent({ type: "mouseDown", x: 220, y: 140, button: "left", clickCount: 1 })
    win.webContents.sendInputEvent({ type: "mouseUp", x: 220, y: 140, button: "left", clickCount: 1 })
    assert.equal(await clicked, true, "The visible overlay receives native trusted input after page hiding")
    assert.equal(
      await win.webContents.executeJavaScript("window.received"),
      1,
      "Overlapping app control must receive input",
    )

    await win.webContents.executeJavaScript(
      "document.querySelector('#overlay').removeAttribute('role'); document.querySelector('#overlay').setAttribute('role','menu'); document.querySelector('#overlay').style.cssText='left:550px;top:450px'",
    )
    assert.deepEqual(
      await win.webContents.executeJavaScript(boundsExpression),
      bounds,
      "Disjoint menu must leave page visible",
    )
    await win.webContents.executeJavaScript("document.querySelector('#overlay').style.cssText='left:200px;top:120px'")
    const menuOverlap = await win.webContents.executeJavaScript(boundsExpression)
    assert.equal(menuOverlap, null, "Overlapping menu must hide the page")
    browserViewport(owner, { sessionID, lease, bounds: menuOverlap })
    assert.equal(currentBounds(), undefined, "Native page must hide under an overlapping menu")

    await win.webContents.executeJavaScript(
      "document.querySelector('#overlay').remove(); document.body.insertAdjacentHTML('beforeend','<div role=dialog aria-modal=true style=\"position:fixed;left:200px;top:120px;width:100px;height:80px\"></div>')",
    )
    assert.equal(
      await win.webContents.executeJavaScript(boundsExpression),
      null,
      "Overlapping modal must hide the page",
    )
    await win.webContents.executeJavaScript("document.querySelector('[role=dialog]').remove()")
    await win.webContents.executeJavaScript(
      "document.body.insertAdjacentHTML('beforeend','<div role=dialog aria-modal=true style=\"position:fixed;left:700px;top:500px;width:100px;height:80px\"></div>')",
    )
    assert.equal(
      await win.webContents.executeJavaScript(boundsExpression),
      null,
      "A modal dialog blocks the page even when its surface is outside the viewport",
    )
    await win.webContents.executeJavaScript(
      "document.querySelector('[role=dialog]').remove(); document.body.insertAdjacentHTML('beforeend','<div data-component=dialog-overlay style=\"position:fixed;inset:0\"></div>')",
    )
    assert.equal(await win.webContents.executeJavaScript(boundsExpression), null, "Dialog backdrop must hide the page")
    await win.webContents.executeJavaScript("document.querySelector('[data-component=dialog-overlay]').remove()")
    const restored = await win.webContents.executeJavaScript(boundsExpression)
    assert.deepEqual(restored, bounds, "Removing an overlay must restore the measured CSS-pixel bounds")
    browserViewport(owner, { sessionID, lease, bounds: restored })
    assert.deepEqual(currentBounds(), restored, "Native page must restore after overlay disposal")

    await win.webContents.executeJavaScript("document.querySelector('#viewport').style.width='250px'")
    const resized = await win.webContents.executeJavaScript(boundsExpression)
    assert.deepEqual(resized, { ...bounds, width: 250 }, "Viewport resize must update measured bounds")
    browserViewport(owner, { sessionID, lease, bounds: resized })
    assert.equal(nativeTab.view.getBounds().width, 250)

    win.webContents.setZoomFactor(1.25)
    const scaled = await win.webContents.executeJavaScript(boundsExpression)
    browserViewport(owner, { sessionID, lease, bounds: scaled })
    assert(Math.abs(scaled.width - 250) < 1, "Renderer reports CSS pixels after display scaling")
    assert.equal(nativeTab.view.getBounds().x, 125, "Main scales the renderer's CSS-pixel origin")
    assert.equal(nativeTab.view.getBounds().width, 313, "Main scales and rounds the renderer's CSS-pixel width")
    win.webContents.setZoomFactor(1)
    browserViewport(owner, { sessionID, lease, bounds: resized })

    await browserCommand(owner, "another-chat", { op: "new" })
    browserViewport(owner, { sessionID: "another-chat", lease, bounds: resized })
    browserViewport(owner, { sessionID, lease, bounds: null })
    assert.deepEqual(currentBounds(), resized, "A late clear from the prior chat must not hide the current viewport")
    browserViewport(owner, { sessionID, lease, bounds: resized })

    browserViewport(owner, { sessionID, lease, bounds: null })
    assert.equal(currentBounds(), undefined, "Disposal must hide the native page")
    console.log(
      "PASS overlays: disjoint tooltip/menu, overlapping tooltip/menu/modal, trusted input, restoration, resize/scale, chat-switch stale clear, disposal",
    )
  } finally {
    win.destroy()
  }
}
