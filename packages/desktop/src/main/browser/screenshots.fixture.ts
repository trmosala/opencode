import assert from "node:assert/strict"
import { EventEmitter, once } from "node:events"
import { createServer } from "node:http"
import { setTimeout } from "node:timers/promises"
import { BrowserWindow, dialog, nativeImage } from "electron"
import {
  MAX_SCREENSHOT_BYTES,
  MAX_SNAPSHOT_BYTES,
  type BrowserIpcRequest,
  type BrowserIpcResult,
  type Request,
  type Response,
  type BrowserState,
} from "@cookiemonster/cm-browser/protocol"
import { browserTools } from "@cookiemonster/cm-browser/tools"
import { browserCommand, browserViewport, registerBrowserOwner } from "./tabs"
import { browserOperationBusy, browserRegistration, registerBrowserTab, setBrowserAgentEnabled } from "./registry"
import { routeBrowserRequest } from "./router"
import { attachBrowserBridge } from "./bridge"

// All pixels are synthetic. Never log/assert a whole response, base64 string, or bitmap.
export async function screenshotsSmoke() {
  assert(process.env.CM_BROWSER_SMOKE_PROFILE, "Only run through the isolated smoke runner")
  const frame = createServer((_request, response) => {
    response.writeHead(200, { "Content-Type": "text/html" })
    response.end('<!doctype html><body style="margin:0;background:rgb(20,40,220)">synthetic frame secret</body>')
  })
  frame.listen(0, "127.0.0.1")
  await once(frame, "listening")
  const frameAddress = frame.address()
  assert(frameAddress && typeof frameAddress === "object")
  const html = `<!doctype html><title>Synthetic screenshot fixture</title>
<style>body{margin:0;height:2400px;background:#eee}
input,canvas,iframe{position:fixed;top:40px;width:120px;height:100px;border:0;padding:0}
input{left:20px;background:rgb(20,200,40);color:rgb(220,20,180);font:30px monospace}
canvas{left:180px}iframe{left:340px}</style>
<input aria-label="Synthetic revealed password" autocomplete="current-password" value="&#x2588;&#x2588;&#x2588;">
<canvas width="120" height="100"></canvas>
<iframe src="http://127.0.0.1:${frameAddress.port}/"></iframe>
<script>const c=document.querySelector('canvas').getContext('2d');c.fillStyle='rgb(220,30,20)';c.fillRect(0,0,120,100);</script>`
  const server = createServer((_request, response) => {
    response.writeHead(200, { "Content-Type": "text/html" })
    response.end(html)
  })
  server.listen(0, "127.0.0.1")
  await once(server, "listening")
  const address = server.address()
  assert(address && typeof address === "object")
  const url = `http://127.0.0.1:${address.port}/`
  const win = new BrowserWindow({
    show: false,
    width: 760,
    height: 600,
    webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false },
  })
  const owner = registerBrowserOwner(win)
  const command = (value: Parameters<typeof browserCommand>[2]) => browserCommand(owner, "screenshots", value)
  const nativeDialog = dialog.showMessageBox.bind(dialog)
  let answer = 1
  let prompts = 0
  let dialogHook: ((options: Electron.MessageBoxOptions) => Promise<void>) | undefined
  dialog.showMessageBox = (async (
    windowOrOptions: Electron.BaseWindow | Electron.MessageBoxOptions,
    options?: Electron.MessageBoxOptions,
  ) => {
    const settings = options ?? ("message" in windowOrOptions ? windowOrOptions : undefined)
    assert(settings)
    assert.equal(settings.defaultId, 0)
    assert.equal(settings.cancelId, 0)
    prompts++
    await dialogHook?.(settings)
    return { response: answer, checkboxChecked: false }
  }) as typeof dialog.showMessageBox
  let stop = () => {}
  try {
    await win.loadURL(url)
    win.showInactive()
    const id = (await command({ op: "new" })).activeID!
    await command({ op: "navigate", tabID: id, url })
    const tab = owner.groups.get("screenshots")!.tabs.find((item) => item.id === id)!
    const contents = tab.view.webContents
    const layout = () =>
      browserViewport(owner, {
        sessionID: "screenshots",
        lease: "screenshots",
        bounds: { x: 0, y: 0, width: 600, height: 400 },
      })
    layout()
    while (contents.isLoadingMainFrame()) await setTimeout(10)
    const send = contents.debugger.sendCommand.bind(contents.debugger)
    let captures = 0
    let rawBytes = 0
    let fakePreflight = false
    let captureHook: (() => Promise<void>) | undefined
    const methods: string[] = []
    contents.debugger.sendCommand = async (method, params) => {
      methods.push(method)
      if (method === "Page.getLayoutMetrics" && fakePreflight)
        return { visualViewport: { clientWidth: 600, clientHeight: 400 } }
      if (method !== "Page.captureScreenshot") return send(method, params)
      assert.deepEqual(params, { format: "jpeg", quality: 60, fromSurface: true, captureBeyondViewport: false })
      captures++
      const result = await send(method, params)
      rawBytes = Buffer.from(result.data, "base64").length
      await captureHook?.()
      return result
    }
    let allowed = true
    let timeout = 15_000
    let afterRoute: ((message: BrowserIpcRequest, response: Response<BrowserState>) => Promise<void>) | undefined
    let settled: Promise<unknown> = Promise.resolve()
    const replies = new Map<string, (response: Response<BrowserState>) => void>()
    const posts = new Map<string, { replies: number; images: number }>()
    const child = Object.assign(new EventEmitter(), {
      postMessage(message: BrowserIpcResult) {
        assert(Buffer.byteLength(JSON.stringify(message.response)) <= MAX_SNAPSHOT_BYTES)
        const count = posts.get(message.id) ?? { replies: 0, images: 0 }
        count.replies++
        if (message.response.ok && message.response.result.screenshot) count.images++
        posts.set(message.id, count)
        replies.get(message.id)?.(message.response)
        replies.delete(message.id)
      },
    })
    stop = attachBrowserBridge(child, async (message, _allowed, control = {}) => {
      const response = await routeBrowserRequest(
        message,
        (candidate) => allowed && new URL(candidate).origin === new URL(url).origin,
        {
          ...control,
          deadline: Math.min(control.deadline ?? Infinity, Date.now() + timeout),
          onSettled(operation) {
            settled = operation
            control.onSettled?.(operation)
          },
        },
      )
      await afterRoute?.(message, response)
      return response
    })
    let sequence = 0
    const dispatch = (request: Request, sessionID = "screenshots", requestID = `shot-${++sequence}`) => {
      const reply = Promise.withResolvers<Response<BrowserState>>()
      replies.set(requestID, reply.resolve)
      child.emit("message", { type: "browser_request", id: requestID, sessionID, request })
      return reply.promise
    }
    const prepare = async (tabID = id) => {
      const prepared = await dispatch({ op: "prepare_write", request: { op: "screenshot", tabID } })
      assert(prepared.ok && prepared.result.context, "Screenshot preparation")
      return { op: "screenshot", tabID, context: prepared.result.context } as const
    }
    const shot = async () => dispatch(await prepare())
    const noImage = (response: Response<BrowserState>) => {
      assert.equal(response.ok, false, "Must reject without pixels")
      assert(!("result" in response))
      assert(!JSON.stringify(response).includes("data:image"))
      assert(!JSON.stringify(response).includes("/9j/"))
    }
    const pixels = async (response: Response<BrowserState>, label: string) => {
      assert(
        response.ok && response.result.screenshot,
        `${label}: screenshot expected (${response.ok ? "missing image" : response.code + ": " + response.error})`,
      )
      const state = response.result
      const image = state.screenshot!
      const bytes = Buffer.from(image.data, "base64")
      const decoded = nativeImage.createFromBuffer(bytes)
      assert(!decoded.isEmpty())
      assert.deepEqual(decoded.getSize(), { width: image.width, height: image.height })
      assert(bytes.length <= MAX_SCREENSHOT_BYTES)
      assert.equal(state.url, contents.getURL())
      assert.equal(state.title, "")
      assert.equal(state.visibleText, "")
      assert.equal(state.elements.length, 0)
      const viewport = await contents.executeJavaScript(
        "({width:innerWidth,height:innerHeight,dpr:devicePixelRatio,scroll:scrollY})",
      )
      const scale = image.width / viewport.width
      assert(Math.abs(image.height - viewport.height * scale) <= 2, "Viewport-only aspect ratio")
      const bitmap = decoded.toBitmap()
      const rgb = (x: number, y: number) => {
        const offset = (Math.floor(y * scale) * image.width + Math.floor(x * scale)) * 4
        return [bitmap[offset + 2], bitmap[offset + 1], bitmap[offset]]
      }
      for (const [x, expected] of [
        [80, [20, 200, 40]],
        [240, [220, 30, 20]],
        [400, [20, 40, 220]],
      ] as const)
        assert(
          rgb(x, 120).every((value, index) => Math.abs(value - expected[index]) < 18),
          `${label}: unredacted swatch ${x}`,
        )
      let visibleValue = false
      for (let y = 70; y < 110; y++)
        for (let x = 25; x < 100; x++) {
          const color = rgb(x, y)
          if (color[0] > 150 && color[1] < 80 && color[2] > 100) visibleValue = true
        }
      assert(visibleValue, "Revealed field value pixels remain unredacted")
      assert.equal(await contents.executeJavaScript("document.querySelector('iframe').contentDocument === null"), true)
      console.log(
        "PASS pixels",
        JSON.stringify({
          label,
          width: image.width,
          height: image.height,
          bytes: bytes.length,
          dpr: viewport.dpr,
          scroll: viewport.scroll,
        }),
      )
    }

    const startCaptures = captures
    const startPrompts = prompts
    noImage(await dispatch({ op: "prepare_write", request: { op: "screenshot", tabID: id } }))
    noImage(await dispatch({ op: "prepare_write", request: { op: "screenshot", tabID: id } }, "wrong-task"))
    assert.equal(captures, startCaptures)
    assert.equal(prompts, startPrompts)
    await command({ op: "access", tabID: id, enabled: true })
    assert(tab.agentAccess)
    await contents.executeJavaScript(
      "const ctx = document.querySelector('canvas').getContext('2d'); ctx.fillStyle = 'rgb(220,30,20)'; ctx.fillRect(0,0,120,100); scrollTo(0,120)",
    )
    await setTimeout(100)
    const geometry = () =>
      contents.executeJavaScript(
        "JSON.stringify([scrollX,scrollY,innerWidth,innerHeight,document.body.scrollHeight,...[...document.querySelectorAll('input,canvas,iframe')].map(e=>e.getBoundingClientRect().toJSON())])",
      )
    for (const zoom of [1, 1.25]) {
      contents.setZoomFactor(zoom)
      await setTimeout(100)
      const before = await geometry()
      const focus = BrowserWindow.getFocusedWindow()?.id
      methods.length = 0
      const count = prompts
      await pixels(await shot(), `zoom-${zoom}`)
      assert.equal(prompts, count + 1)
      assert.deepEqual(methods, ["Page.getLayoutMetrics", "Page.captureScreenshot"])
      assert.equal(await geometry(), before)
      assert.equal(BrowserWindow.getFocusedWindow()?.id, focus, "Capture does not focus owner")
    }
    contents.setZoomFactor(1)
    for (const deviceScaleFactor of [1, 1.5]) {
      await send("Emulation.setDeviceMetricsOverride", { width: 600, height: 400, deviceScaleFactor, mobile: false })
      await setTimeout(100)
      const before = await geometry()
      await pixels(await shot(), `device-scale-${deviceScaleFactor}`)
      assert.equal(await geometry(), before)
    }
    await send("Emulation.clearDeviceMetricsOverride")

    const other = (await command({ op: "new" })).activeID!
    await command({ op: "navigate", tabID: other, url })
    layout()
    assert.notEqual(owner.attached, tab)
    const covered = new BrowserWindow({ show: false, ...win.getBounds(), webPreferences: { sandbox: true } })
    try {
      await covered.loadURL(url)
      covered.showInactive()
      const focus = BrowserWindow.getFocusedWindow()?.id
      const before = await geometry()
      const attempts = captures
      const confirmations = prompts
      timeout = 1500
      const response = await shot()
      noImage(response)
      assert.equal(captures, attempts, "Detached tabs must fail before native capture")
      assert.equal(prompts, confirmations, "Detached tabs must fail before consent")
      await settled
      assert.equal(browserOperationBusy.has(id), false, "Detached rejection releases the tab without reattachment")
      assert.equal(await geometry(), before)
      assert.equal(BrowserWindow.getFocusedWindow()?.id, focus)
      assert.equal(owner.groups.get("screenshots")!.activeID, other)
      assert.notEqual(owner.attached, tab)
      console.log("PASS detached screenshot rejection: zero consent/capture and native settlement without reattachment")
      await command({ op: "select", tabID: id })
      layout()
      await settled
      timeout = 15_000
      await pixels(await shot(), "selected-covered")
      await command({ op: "select", tabID: other })
      layout()
      assert.equal(BrowserWindow.getFocusedWindow()?.id, focus)
      assert.equal(owner.groups.get("screenshots")!.activeID, other)
      assert.notEqual(owner.attached, tab)
    } finally {
      covered.destroy()
    }
    await command({ op: "select", tabID: id })
    layout()

    const tool = browserTools({ send: (sessionID, request) => dispatch(request, sessionID) }).browser_screenshot
    const permissions: string[] = []
    answer = 0
    const deniedCaptures = captures
    await assert.rejects(
      tool.execute(
        { tabID: id },
        {
          sessionID: "screenshots",
          messageID: "plugin-allow",
          agent: "build",
          directory: ".",
          worktree: ".",
          abort: new AbortController().signal,
          metadata: () => {},
          ask: async (input) => {
            permissions.push(input.permission)
          },
        },
      ),
    )
    assert.deepEqual(permissions, ["browser_read_state", "browser_screenshot"])
    assert.equal(captures, deniedCaptures)
    answer = 1
    dialogHook = async (options) => {
      assert(options.signal)
      assert(options.detail)
      assert(options.detail.includes(id) && options.detail.includes(url))
      assert(options.detail.includes("passwords") && options.detail.includes("Nothing is redacted"))
      tab.screenshotConsent?.abort()
    }
    noImage(await shot())
    assert.equal(captures, deniedCaptures)
    dialogHook = undefined
    console.log("PASS private/wrong-task, per-capture consent, plugin Allow does not bypass denial, consent abort")

    for (const dimensions of [
      [4097, 100],
      [2048, 2049],
    ]) {
      await send("Emulation.setDeviceMetricsOverride", {
        width: dimensions[0],
        height: dimensions[1],
        deviceScaleFactor: 1,
        mobile: false,
      })
      await setTimeout(60)
      const before = captures
      noImage(await shot())
      assert.equal(captures, before, "Oversized viewport preflight: zero captures")
      fakePreflight = true
      noImage(await shot())
      assert.equal(captures, before + 1, "Actual oversized raster: one capture")
      assert(rawBytes <= MAX_SCREENSHOT_BYTES, "Raster rejection must not be a byte rejection")
      fakePreflight = false
    }
    await send("Emulation.clearDeviceMetricsOverride")
    await contents.executeJavaScript(`(() => {
      const c=document.createElement('canvas');c.width=600;c.height=400;
      c.style.cssText='position:fixed;inset:0;width:600px;height:400px;z-index:10';document.body.append(c);
      const ctx=c.getContext('2d'), image=ctx.createImageData(600,400);let seed=7;
      for(let i=0;i<image.data.length;i+=4){for(let j=0;j<3;j++){seed=(Math.imul(seed,1664525)+1013904223)|0;image.data[i+j]=seed>>>24}image.data[i+3]=255}
      ctx.putImageData(image,0,0);
    })()`)
    await setTimeout(100)
    const entropyBefore = captures
    noImage(await shot())
    assert(rawBytes > MAX_SCREENSHOT_BYTES)
    assert.equal(captures, entropyBefore + 1, "High entropy fails without retry")
    console.log(
      "PASS size limits",
      JSON.stringify({ highEntropyBytes: rawBytes, rawLimit: MAX_SCREENSHOT_BYTES, responseLimit: MAX_SNAPSHOT_BYTES }),
    )
    await contents.loadURL(url)
    while (contents.isLoadingMainFrame()) await setTimeout(10)
    await contents.executeJavaScript("history.replaceState(null,'','?long='+'x'.repeat(65536))")
    noImage(await shot())
    await contents.loadURL(url)
    while (contents.isLoadingMainFrame()) await setTimeout(10)

    for (const phase of ["capture", "post"] as const) {
      for (const reason of [
        "owner-hide",
        "owner-navigation",
        "owner-crash",
        "selection",
        "detached",
        "revoke",
        "regrant",
        "aba",
        "registration",
        "global",
        "policy",
        "cancel",
        "timeout",
      ] as const) {
        const entered = Promise.withResolvers<void>()
        const release = Promise.withResolvers<void>()
        let held = false
        const hold = async () => {
          held = true
          entered.resolve()
          await release.promise
        }
        if (phase === "capture") captureHook = hold
        else
          afterRoute = async (_message, response) => {
            if (!response.ok || !response.result.screenshot) return
            await hold()
          }
        timeout = reason === "timeout" ? 1000 : 15_000
        contents.backgroundThrottling = true
        // An owned alias lets the real registry unregister/re-register the same ID without closing Chromium.
        const registration =
          reason === "registration"
            ? { ...tab, id: id + "-registration", confirmScreenshot: async () => () => {} }
            : undefined
        let removeRegistration = registration ? registerBrowserTab(registration) : undefined
        const request = await prepare(registration?.id)
        const requestID = `race-${++sequence}`
        const attempts = captures
        const pending = dispatch(request, "screenshots", requestID)
        try {
          await Promise.race([
            entered.promise,
            pending.then((response) => {
              throw new Error(`${phase} ${reason}: completed before hold (${response.ok ? "image" : response.code})`)
            }),
          ])
          assert.equal(tab.navigationAllowed, undefined)
          if (reason === "revoke" || reason === "regrant") {
            await command({ op: "access", tabID: id, enabled: false })
            if (reason === "regrant") await command({ op: "access", tabID: id, enabled: true })
          }
          if (reason === "owner-hide") {
            const hidden = once(win, "hide")
            win.hide()
            await hidden
            win.showInactive()
            layout()
            assert(win.isVisible(), "Restored visibility must not revive approval")
          }
          // Synthetic renderer events exercise the real owner hooks without crashing the fixture process.
          if (reason === "owner-navigation") win.webContents.emit("did-start-navigation", {}, url, false, true)
          if (reason === "owner-crash")
            win.webContents.emit("render-process-gone", {}, { reason: "crashed", exitCode: 1 })
          if (reason === "selection") await command({ op: "select", tabID: other })
          if (reason === "detached") win.contentView.removeChildView(tab.view)
          if (reason === "aba") {
            await contents.loadURL(url + "?b")
            await contents.loadURL(url)
          }
          if (registration) {
            removeRegistration!()
            removeRegistration = registerBrowserTab({ ...registration })
          }
          if (reason === "global") {
            setBrowserAgentEnabled(false)
            setBrowserAgentEnabled(true)
          }
          if (reason === "policy") allowed = false
          if (reason === "cancel")
            child.emit("message", { type: "browser_cancel", id: requestID, sessionID: "screenshots" })
          if (reason === "timeout") await setTimeout(1050)
          if (phase === "capture") {
            assert.equal(contents.backgroundThrottling, false, "Rendering lease held until native settlement")
            if (reason === "cancel" || reason === "timeout") {
              noImage(await pending)
              assert.equal(contents.backgroundThrottling, false, "Early reply does not release the native lease")
              child.emit("message", { type: "browser_request", id: requestID, sessionID: "screenshots", request })
              await setTimeout(20)
              assert.equal(captures, attempts + 1, "Bridge correlation ID remains occupied")
            }
            if (tab.agentAccess && allowed) {
              const busy = await routeBrowserRequest({
                type: "browser_request",
                id: "busy",
                sessionID: "screenshots",
                request: { op: "read_state", tabID: request.tabID },
              })
              assert(!busy.ok && busy.code === "unavailable")
            }
          }
          release.resolve()
          noImage(await pending)
          await settled
          if (phase === "capture") assert.equal(contents.backgroundThrottling, true)
          assert.equal(tab.screenshotConsent, undefined)
          assert.equal(registration?.screenshotConsent, undefined)
          await setTimeout(0)
          assert.deepEqual(posts.get(requestID), { replies: 1, images: 0 })
          assert.equal(captures, attempts + 1)
          console.log(`PASS ${phase} ${reason}: zero delivered images`)
        } finally {
          release.resolve()
          // A failed setup must fail the fixture, not wait forever for a hold it never reached.
          if (!held) win.destroy()
          await pending
          await settled
          captureHook = undefined
          afterRoute = undefined
          timeout = 15_000
          allowed = true
          removeRegistration?.()
          setBrowserAgentEnabled(true)
          if (!contents.isDestroyed()) {
            while (contents.isLoadingMainFrame()) await setTimeout(10)
            if (reason === "selection") await command({ op: "select", tabID: id })
            if (reason === "detached") win.contentView.addChildView(tab.view)
            layout()
            if (!tab.agentAccess) await command({ op: "access", tabID: id, enabled: true })
          }
        }
      }
    }
    assert.equal(browserRegistration("screenshots", id), tab)
    if (process.platform === "win32") {
      dialog.showMessageBox = nativeDialog
      const before = captures
      let complete = false
      const pending = shot().finally(() => {
        complete = true
      })
      const abort = globalThis.setTimeout(() => tab.screenshotConsent?.abort(), 1500)
      try {
        await setTimeout(200)
        assert.equal(complete, false, "Real Windows dialog must remain pending")
        assert.equal(win.isEnabled(), true)
        tab.screenshotConsent?.abort()
        noImage(await pending)
        await settled
        assert.equal(captures, before)
        assert.equal(owner.suspended, 0)
        console.log(
          "PASS real Windows unparented dialog: owner enabled, AbortSignal cancellation, zero captures (not physical usability)",
        )
      } finally {
        clearTimeout(abort)
        tab.screenshotConsent?.abort()
        await pending
      }
    }
  } finally {
    stop()
    dialog.showMessageBox = nativeDialog
    if (!win.isDestroyed()) win.destroy()
    server.closeAllConnections()
    frame.closeAllConnections()
    await Promise.all([
      new Promise<void>((resolve) => server.close(() => resolve())),
      new Promise<void>((resolve) => frame.close(() => resolve())),
    ])
  }
}
