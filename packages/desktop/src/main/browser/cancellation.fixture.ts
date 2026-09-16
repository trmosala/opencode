import assert from "node:assert/strict"
import { once } from "node:events"
import { createServer } from "node:http"
import { setTimeout } from "node:timers/promises"
import { BrowserWindow, WebContentsView } from "electron"
import type { Request, WriteRequest } from "@cookiemonster/cm-browser/protocol"
import { registerBrowserTab, setBrowserAgentEnabled, type BrowserRegistration } from "./registry"
import { routeBrowserRequest, type BrowserOperation } from "./router"

const html = `<!doctype html><title>Cancellation fixture</title>
<button id="button" style="width:160px;height:80px">Action</button>
<script>
window.witness = { events: [], down: false, clicks: 0 };
for (const type of ["keydown", "keyup", "mousedown", "mouseup", "click"]) {
  document.addEventListener(type, event => {
    witness.events.push({ type, trusted: event.isTrusted, key: event.key, buttons: event.buttons });
    if (type === "keydown" || type === "mousedown") witness.down = true;
    if (type === "keyup" || type === "mouseup") witness.down = false;
    if (type === "click") witness.clicks++;
  });
}
</script>`

type Witness = {
  events: { type: string; trusted: boolean; key?: string; buttons?: number }[]
  down: boolean
  clicks: number
  active: boolean
}

export async function cancellationSmoke() {
  assert(process.env.CM_BROWSER_SMOKE_PROFILE, "Only run through the isolated smoke runner")
  const server = createServer((_request, response) => {
    response.writeHead(200, { "Content-Type": "text/html" })
    response.end(html)
  })
  server.listen(0, "127.0.0.1")
  await once(server, "listening")
  const address = server.address()
  assert(address && typeof address === "object")
  const url = `http://127.0.0.1:${address.port}/`
  const win = new BrowserWindow({ show: false, width: 640, height: 480 })
  win.showInactive()

  const create = async () => {
    const view = new WebContentsView({
      webPreferences: {
        partition: "cancellation-fixture",
        sandbox: true,
        contextIsolation: true,
        nodeIntegration: false,
      },
    })
    win.contentView.addChildView(view)
    view.setBounds({ x: 0, y: 0, width: 600, height: 400 })
    const contents = view.webContents
    await contents.loadURL(url)
    while (contents.isLoadingMainFrame()) await setTimeout(10)
    const tab: BrowserRegistration = {
      id: `cancellation-${contents.id}`,
      ownerID: win.id,
      sessionID: "cancellation",
      contents,
      revision: 0,
      agentAccess: true,
    }
    const remove = registerBrowserTab(tab)
    const route = (request: Request, control: BrowserOperation = {}) =>
      routeBrowserRequest(
        { type: "browser_request", id: "fixture", sessionID: tab.sessionID, request },
        (destination) => new URL(destination).origin === new URL(url).origin,
        control,
      )
    const prepare = async (request: WriteRequest) => {
      const response = await route({ op: "prepare_write", request })
      assert(response.ok && response.result.context)
      return { ...request, context: response.result.context }
    }
    const read = async (): Promise<Witness> =>
      contents.executeJavaScript("({ ...witness, active: document.getElementById('button').matches(':active') })")
    return {
      view,
      contents,
      tab,
      route,
      prepare,
      read,
      close: () => {
        remove()
        win.contentView.removeChildView(view)
        contents.close({ waitForBeforeUnload: false })
      },
    }
  }

  try {
    for (const kind of ["key", "mouse"] as const) {
      const original = await create()
      const controller = new AbortController()
      const entered = Promise.withResolvers<void>()
      const held = Promise.withResolvers<void>()
      const settled = Promise.withResolvers<void>()
      const send = original.contents.debugger.sendCommand.bind(original.contents.debugger)
      const dispatched: string[] = []
      try {
        await original.contents.executeJavaScript("document.getElementById('button').focus()")
        const state = await original.route({ op: "read_state", tabID: original.tab.id })
        assert(state.ok)
        const ref = state.result.elements.find((entry) => entry.tag === "button")?.ref
        assert(ref)
        const request = await original.prepare(
          kind === "key"
            ? { op: "press_key", tabID: original.tab.id, key: " ", modifiers: [] }
            : { op: "click", tabID: original.tab.id, ref },
        )
        original.contents.debugger.sendCommand = async (method, params) => {
          if (method.startsWith("Input.")) dispatched.push(params?.type)
          const value = await send(method, params)
          if (params?.type === (kind === "key" ? "keyDown" : "mousePressed")) {
            entered.resolve()
            await held.promise
          }
          return value
        }
        const pending = original.route(request, {
          signal: controller.signal,
          onSettled: (operation) => {
            void operation.finally(() => settled.resolve())
          },
        })
        await entered.promise
        const down = await original.read()
        assert(down.down)
        assert.equal(down.clicks, 0)
        assert(down.events.some((event) => event.type === (kind === "key" ? "keydown" : "mousedown") && event.trusted))
        controller.abort()
        assert.deepEqual(await pending, { ok: false, code: "cancelled", error: "Browser operation cancelled." })
        assert.equal(original.contents.backgroundThrottling, false)
        assert(original.tab.navigationAllowed)
        const busy = await original.route({ op: "read_state", tabID: original.tab.id })
        assert(!busy.ok && busy.error.includes("Another operation"))
        held.resolve()
        await settled.promise
        assert.equal(original.contents.backgroundThrottling, true)
        assert.equal(original.tab.navigationAllowed, undefined)
        assert.deepEqual(dispatched, kind === "key" ? ["keyDown"] : ["mouseMoved", "mousePressed"])
        const after = await original.read()
        assert(after.down)
        assert.equal(after.clicks, 0)
        assert(!after.events.some((event) => event.type === "keyup" || event.type === "mouseup"))
        const blocked = await original.route({ op: "read_state", tabID: original.tab.id })
        assert(!blocked.ok && blocked.error.includes("Close this tab"))
        setBrowserAgentEnabled(false)
        setBrowserAgentEnabled(true)
        original.tab.agentAccess = true
        const regrant = await original.route({ op: "prepare_write", request })
        assert(!regrant.ok && regrant.error.includes("Close this tab"))

        // Fixture-only witness, never a recovery path: releases can activate this inert button.
        const release =
          kind === "key"
            ? { key: " ", code: "", windowsVirtualKeyCode: 32, modifiers: 0, type: "keyUp" }
            : { x: 88, y: 48, button: "left", buttons: 0, clickCount: 1, type: "mouseReleased" }
        await send(kind === "key" ? "Input.dispatchKeyEvent" : "Input.dispatchMouseEvent", release)
        const released = await original.read()
        assert.equal(released.down, false)
        assert.equal(released.clicks, 1, "An automatic release would have activated the page after cancellation")

        // Re-latch only in the fixture, then reload: observe DOM reset, not an internal input reset guarantee.
        await send(
          kind === "key" ? "Input.dispatchKeyEvent" : "Input.dispatchMouseEvent",
          kind === "key"
            ? { ...release, type: "keyDown", text: " " }
            : { ...release, type: "mousePressed", buttons: 1 },
        )
        assert((await original.read()).down)
        const loaded = once(original.contents, "did-finish-load")
        original.contents.reload()
        await loaded
        while (original.contents.isLoadingMainFrame()) await setTimeout(10)
        const reloaded = await original.read()
        assert.equal(reloaded.down, false)
        assert.equal(reloaded.clicks, 0)
        const reloadBlocked = await original.route({ op: "read_state", tabID: original.tab.id })
        assert(!reloadBlocked.ok && reloadBlocked.error.includes("Close this tab"))
        console.log(
          JSON.stringify({ kind, down, afterCancellation: after, fixtureRelease: released, afterReload: reloaded }),
        )
      } finally {
        controller.abort()
        held.resolve()
        original.contents.debugger.sendCommand = send
        original.close()
      }

      const fresh = await create()
      try {
        const clean = await fresh.read()
        assert.equal(clean.down, false)
        assert.equal(clean.active, false)
        assert.equal(clean.clicks, 0)
        await fresh.contents.executeJavaScript("document.getElementById('button').focus()")
        const state = await fresh.route({ op: "read_state", tabID: fresh.tab.id })
        assert(state.ok)
        const ref = state.result.elements.find((entry) => entry.tag === "button")?.ref
        assert(ref)
        const request = await fresh.prepare(
          kind === "key"
            ? { op: "press_key", tabID: fresh.tab.id, key: " ", modifiers: [] }
            : { op: "click", tabID: fresh.tab.id, ref },
        )
        assert((await fresh.route(request)).ok)
        const recovered = await fresh.read()
        assert.equal(recovered.down, false)
        assert.equal(recovered.clicks, 1)
        assert(recovered.events.some((event) => event.type === (kind === "key" ? "keyup" : "mouseup") && event.trusted))
        console.log(JSON.stringify({ kind, newView: recovered }))
      } finally {
        fresh.close()
      }
    }
    console.log(
      `PASS cancellation Chromium ${process.versions.chrome} Electron ${process.versions.electron}: real down/up, release activation, reload quarantine, fresh-view recovery`,
    )
  } finally {
    setBrowserAgentEnabled(true)
    win.destroy()
    await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())))
  }
}
