import assert from "node:assert/strict"
import { EventEmitter, once } from "node:events"
import { mkdirSync, writeFileSync } from "node:fs"
import { createServer } from "node:http"
import { join } from "node:path"
import { setTimeout } from "node:timers/promises"
import { BrowserWindow, dialog, nativeImage } from "electron"
import {
  MAX_SCREENSHOT_BYTES,
  MAX_SCREENSHOT_EDGE,
  MAX_SCREENSHOT_PIXELS,
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
    response.end(
      '<!doctype html><body style="margin:0;height:800px;background:rgb(20,40,220)"><button style="width:120px;height:100px;padding:0;border:0;background:transparent" onclick="document.body.style.background=String.fromCharCode(114,103,98,40,50,48,44,50,48,48,44,52,48,41)">embedded target</button></body>',
    )
  })
  frame.listen(0, "0.0.0.0")
  await once(frame, "listening")
  const frameAddress = frame.address()
  assert(frameAddress && typeof frameAddress === "object")
  const html = `<!doctype html><title>Synthetic screenshot fixture</title>
<style>body{margin:0;height:2400px;background:#eee}
input,canvas,iframe{position:fixed;top:40px;width:120px;height:100px;border:0;padding:0}
input{left:20px;background:rgb(20,200,40);color:rgb(220,20,180);font:30px monospace}
canvas{left:180px}iframe{left:340px}
canvas#detail{position:fixed;inset:0;width:600px;height:400px;z-index:0;pointer-events:none}
input,canvas:not(#detail),iframe,img,#closed-widget{z-index:2}
img{position:fixed;left:470px;top:40px;width:120px;height:100px}
#closed-widget{position:fixed;left:500px;top:180px;width:80px;height:80px}</style>
<input aria-label="Synthetic revealed password" autocomplete="current-password" value="&#x2588;&#x2588;&#x2588;">
<canvas id="detail" width="600" height="400"></canvas>
<canvas width="120" height="100"></canvas>
<iframe src="http://127.0.0.1:${frameAddress.port}/"></iframe>
<img alt="Synthetic detailed image" src="data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='240' height='200'%3E%3Crect width='240' height='200' fill='%23fff'/%3E%3Cpath d='M0 0L240 200M240 0L0 200' stroke='%23000'/%3E%3Ctext x='8' y='100' font-size='20'%3EDETAIL-123456%3C/text%3E%3C/svg%3E">
<div id="closed-widget"></div>
<script>
const canvas=document.querySelector('canvas:not(#detail)');const c=canvas.getContext('2d');c.fillStyle='rgb(220,30,20)';c.fillRect(0,0,120,100);
canvas.addEventListener('click',()=>window.canvasClicks=(window.canvasClicks||0)+1);
const detail=document.querySelector('#detail'),detailContext=detail.getContext('2d'),pixels=detailContext.createImageData(600,400);
let seed=123456789;for(let i=0;i<pixels.data.length;i+=4){seed=(1664525*seed+1013904223)>>>0;pixels.data[i]=seed&255;pixels.data[i+1]=(seed>>>8)&255;pixels.data[i+2]=(seed>>>16)&255;pixels.data[i+3]=255;}detailContext.putImageData(pixels,0,0);
const root=document.querySelector('#closed-widget').attachShadow({mode:'closed'});
const button=document.createElement('button');button.textContent='Synthetic closed target';button.style.cssText='width:80px;height:80px';
button.addEventListener('click',()=>window.closedTargetClicks=(window.closedTargetClicks||0)+1);root.append(button);
</script>`
  const server = createServer((_request, response) => {
    response.writeHead(200, { "Content-Type": "text/html" })
    response.end(html)
  })
  server.listen(0, "0.0.0.0")
  await once(server, "listening")
  const address = server.address()
  assert(address && typeof address === "object")
  const url = `http://localhost:${address.port}/`
  const win = new BrowserWindow({
    show: false,
    width: 760,
    height: 600,
    webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false },
  })
  const owner = registerBrowserOwner(win)
  const command = (value: Parameters<typeof browserCommand>[2]) => browserCommand(owner, "screenshots", value)
  const nativeDialog = dialog.showMessageBox.bind(dialog)
  let prompts = 0
  dialog.showMessageBox = (async () => {
    prompts++
    return { response: 1, checkboxChecked: false }
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
    let embeddedChanged = false
    let oversizedMetrics: { width: number; height: number } | undefined
    let oversizedMetricsApplied = false
    const oversizedViewport = new Map<number, { width: number; height: number }>()
    let captureHook: (() => Promise<void>) | undefined
    const methods: string[] = []
    contents.debugger.sendCommand = async (method, params, sessionID) => {
      methods.push(method)
      if (method === "Page.getLayoutMetrics" && oversizedMetrics) {
        await send("Emulation.setDeviceMetricsOverride", { ...oversizedMetrics, deviceScaleFactor: 1, mobile: false })
        oversizedMetricsApplied = true
      }
      if (method !== "Page.captureScreenshot") {
        const result = await send(method, params, sessionID)
        if (
          method === "Runtime.evaluate" &&
          oversizedMetricsApplied &&
          String(params?.expression).includes("__cmVisualGuard")
        ) {
          const value = (result as { result?: { value?: { width?: number; height?: number } } }).result?.value
          if (typeof value?.width === "number" && typeof value.height === "number")
            oversizedViewport.set(0, { width: value.width, height: value.height })
        }
        return result
      }
      assert.equal(params?.format, "jpeg")
      assert.equal(params?.fromSurface, true)
      assert.equal(params?.captureBeyondViewport, false)
      assert.equal(typeof params?.quality, "number")
      captures++
      const result = await send(method, params, sessionID)
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
    const visualAction = async (request: {
      readonly tabID: string
      readonly visualRef: string
      readonly action: "click" | "hover"
      readonly x: number
      readonly y: number
    }) => {
      const prepared = await dispatch({ op: "prepare_write", request: { op: "visual_action", ...request } })
      assert(prepared.ok && prepared.result.context, "Visual action preparation")
      return dispatch({ op: "visual_action", ...request, context: prepared.result.context })
    }
    const noImage = (response: Response<BrowserState>) => {
      assert.equal(response.ok, false, "Must reject without pixels")
      assert(!("result" in response))
      assert(!JSON.stringify(response).includes("data:image"))
      assert(!JSON.stringify(response).includes("/9j/"))
    }
    const visualRegions = async () =>
      JSON.parse(
        await contents.executeJavaScript(`JSON.stringify({
      input: document.querySelector('input').getBoundingClientRect().toJSON(),
      canvas: document.querySelector('canvas:not(#detail)').getBoundingClientRect().toJSON(),
      iframe: document.querySelector('iframe').getBoundingClientRect().toJSON(),
    })`),
      ) as Record<"input" | "canvas" | "iframe", { x: number; y: number; width: number; height: number }>
    const regionHas = (
      bitmap: Buffer,
      imageWidth: number,
      scaleX: number,
      scaleY: number,
      rect: { x: number; y: number; width: number; height: number },
      matches: (color: number[]) => boolean,
    ) => {
      for (let y = Math.max(0, Math.floor(rect.y)); y < rect.y + rect.height; y += 2)
        for (let x = Math.max(0, Math.floor(rect.x)); x < rect.x + rect.width; x += 2) {
          const offset = (Math.floor(y * scaleY) * imageWidth + Math.floor(x * scaleX)) * 4
          if (matches([bitmap[offset + 2]!, bitmap[offset + 1]!, bitmap[offset]!])) return true
        }
      return false
    }
    const assertWidgetPixels = async (
      image: NonNullable<BrowserState["screenshot"]>,
      decoded: Electron.NativeImage,
      expectedFrame: "blue" | "green",
    ) => {
      const rects = await visualRegions()
      const bitmap = decoded.toBitmap()
      const scaleX = image.scaleX!
      const scaleY = image.scaleY!
      assert(
        regionHas(
          bitmap,
          image.width,
          scaleX,
          scaleY,
          rects.input,
          (color) => color[0] < 60 && color[1] > 160 && color[2] < 80,
        ),
        "Input background is visible in its own bounds",
      )
      assert(
        regionHas(
          bitmap,
          image.width,
          scaleX,
          scaleY,
          rects.input,
          (color) => color[0] > 150 && color[1] < 80 && color[2] > 100,
        ),
        "Revealed field value is visible in its own bounds",
      )
      assert(
        regionHas(
          bitmap,
          image.width,
          scaleX,
          scaleY,
          rects.canvas,
          (color) => color[0] > 170 && color[1] < 70 && color[2] < 70,
        ),
        "Canvas pixels are visible in canvas bounds",
      )
      assert(
        regionHas(
          bitmap,
          image.width,
          scaleX,
          scaleY,
          rects.iframe,
          expectedFrame === "blue"
            ? (color) => color[0] < 70 && color[1] < 80 && color[2] > 150
            : (color) => color[0] < 70 && color[1] > 150 && color[2] < 80,
        ),
        `Embedded frame ${expectedFrame} pixels are visible in its own bounds`,
      )
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
      const proof = join(process.cwd(), "../../node_modules/.cache/cm-browser-review/visual-proof.jpg")
      mkdirSync(join(process.cwd(), "../../node_modules/.cache/cm-browser-review"), { recursive: true })
      writeFileSync(proof, bytes)
      assert.deepEqual(decoded.getSize(), { width: image.width, height: image.height })
      assert(bytes.length <= MAX_SCREENSHOT_BYTES)
      assert(rawBytes > MAX_SCREENSHOT_BYTES, "Detailed synthetic raster exercises the reduction path")
      assert(typeof image.scaleX === "number" && typeof image.scaleY === "number")
      assert(image.scaleX >= 0.5 && image.scaleY >= 0.5, "Supported captures retain at least half viewport resolution")
      assert(image.visualRef && image.viewportWidth && image.viewportHeight && image.scaleX && image.scaleY)
      assert(Math.abs(image.scaleX - image.width / image.viewportWidth) < 0.002)
      assert(Math.abs(image.scaleY - image.height / image.viewportHeight) < 0.002)
      assert.equal(state.url, contents.getURL())
      assert.equal(state.title, "")
      assert.equal(state.visibleText, "")
      assert.equal(state.elements.length, 0)
      const viewport = await contents.executeJavaScript(
        "({width:visualViewport.width,height:visualViewport.height,dpr:devicePixelRatio,scroll:visualViewport.pageTop})",
      )
      const scaleX = image.scaleX!
      const scaleY = image.scaleY!
      assert(Math.abs(image.height - viewport.height * scaleY) <= 2, "Viewport-only aspect ratio")
      const bitmap = decoded.toBitmap()
      await assertWidgetPixels(image, decoded, embeddedChanged ? "green" : "blue")
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
    const mainFrameTree = (await send("Page.getFrameTree")) as { frameTree?: { frame?: { id?: unknown } } }
    const mainFrameID = mainFrameTree.frameTree?.frame?.id
    assert(typeof mainFrameID === "string")
    for (
      let attempt = 0;
      attempt < 50 && !tab.frameSessions?.list().some((frame) => frame.frameId !== mainFrameID && frame.sessionID);
      attempt++
    )
      await setTimeout(20)
    assert(
      tab.frameSessions?.list().some((frame) => frame.frameId !== mainFrameID && frame.sessionID),
      "Cross-site fixture has a tracked out-of-process iframe session",
    )
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
      assert.equal(prompts, count, "Tab authority requires no capture prompt")
      assert(methods.includes("Page.captureScreenshot"))
      assert.equal(methods.filter((method) => method === "Page.captureScreenshot").length, 1)
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

    const visual = await shot()
    assert(visual.ok && visual.result.screenshot?.visualRef, "Bounded visual screenshot includes a one-use reference")
    const image = visual.result.screenshot
    assert(typeof image.scaleX === "number" && typeof image.scaleY === "number")
    const pixel = (cssX: number, cssY: number) => ({
      tabID: id,
      visualRef: image.visualRef!,
      action: "click" as const,
      x: Math.floor(cssX * image.scaleX!),
      y: Math.floor(cssY * image.scaleY!),
    })
    const inputCount = () => methods.filter((method) => method === "Input.dispatchMouseEvent").length
    const beforeClosed = inputCount()
    const closedAction = await visualAction(pixel(540, 220))
    assert(closedAction.ok, closedAction.ok ? "" : closedAction.error)
    assert.equal(
      await contents.executeJavaScript("window.closedTargetClicks"),
      1,
      "Closed-root button received the click",
    )
    assert.equal(inputCount() - beforeClosed, 3, "One acknowledged mouse move/down/up sequence")
    const replay = await visualAction(pixel(540, 220))
    assert(!replay.ok && replay.code === "stale_ref", "A visual reference is consumed before dispatch")
    assert.equal(inputCount() - beforeClosed, 3, "A replayed ref dispatches no additional input")

    const canvasShot = await shot()
    assert(canvasShot.ok && canvasShot.result.screenshot?.visualRef)
    const canvas = canvasShot.result.screenshot
    assert(typeof canvas.scaleX === "number" && typeof canvas.scaleY === "number")
    const canvasClicks = await visualAction({
      tabID: id,
      visualRef: canvas.visualRef!,
      action: "click",
      x: Math.floor(240 * canvas.scaleX!),
      y: Math.floor(90 * canvas.scaleY!),
    })
    assert(
      canvasClicks.ok,
      canvasClicks.ok ? "" : `${canvasClicks.code}/${canvasClicks.actionStatus}: ${canvasClicks.error}`,
    )
    assert.equal(await contents.executeJavaScript("window.canvasClicks"), 1, "Canvas received the coordinate click")

    const embeddedShot = await shot()
    assert(embeddedShot.ok && embeddedShot.result.screenshot?.visualRef)
    const embedded = embeddedShot.result.screenshot
    assert(typeof embedded.scaleX === "number" && typeof embedded.scaleY === "number")
    const embeddedClick = await visualAction({
      tabID: id,
      visualRef: embedded.visualRef!,
      action: "click",
      x: Math.floor(400 * embedded.scaleX!),
      y: Math.floor(90 * embedded.scaleY!),
    })
    assert(embeddedClick.ok, embeddedClick.ok ? "" : embeddedClick.error)
    const embeddedPixels = await shot()
    assert(embeddedPixels.ok && embeddedPixels.result.screenshot)
    assert(
      typeof embeddedPixels.result.screenshot.scaleX === "number" &&
        typeof embeddedPixels.result.screenshot.scaleY === "number",
    )
    const embeddedBitmap = nativeImage.createFromBuffer(Buffer.from(embeddedPixels.result.screenshot.data, "base64"))
    await assertWidgetPixels(embeddedPixels.result.screenshot, embeddedBitmap, "green")
    embeddedChanged = true
    const proof = join(process.cwd(), "../../node_modules/.cache/cm-browser-review/visual-proof.jpg")
    writeFileSync(proof, Buffer.from(embeddedPixels.result.screenshot.data, "base64"))

    const staleShot = await shot()
    assert(staleShot.ok && staleShot.result.screenshot?.visualRef)
    const staleImage = staleShot.result.screenshot
    assert(typeof staleImage.scaleX === "number" && typeof staleImage.scaleY === "number")
    await contents.executeJavaScript("scrollTo(0,240)")
    const staleVisual = await visualAction({
      tabID: id,
      visualRef: staleImage.visualRef!,
      action: "click",
      x: Math.floor(540 * staleImage.scaleX!),
      y: Math.floor(220 * staleImage.scaleY!),
    })
    assert(!staleVisual.ok && staleVisual.code === "stale_ref", "Scrolling invalidates prior visual coordinates")

    const iframeScrollShot = await shot()
    assert(iframeScrollShot.ok && iframeScrollShot.result.screenshot?.visualRef)
    await send("Input.dispatchMouseEvent", { type: "mouseWheel", x: 400, y: 90, deltaX: 0, deltaY: 50 })
    await setTimeout(50)
    const staleIframe = await visualAction({
      tabID: id,
      visualRef: iframeScrollShot.result.screenshot.visualRef!,
      action: "click",
      x: Math.floor(400 * iframeScrollShot.result.screenshot.scaleX!),
      y: Math.floor(90 * iframeScrollShot.result.screenshot.scaleY!),
    })
    assert(
      !staleIframe.ok && staleIframe.code === "stale_ref",
      "Embedded document scroll invalidates visual coordinates",
    )

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
    const promptCount = prompts
    const screenshot = await tool.execute(
      { tabID: id },
      {
        sessionID: "screenshots",
        messageID: "whole-tab-grant",
        agent: "build",
        directory: ".",
        worktree: ".",
        abort: new AbortController().signal,
        metadata: () => {},
        ask: async (input) => {
          permissions.push(input.permission)
          throw new Error("Whole-tab access must not ask for per-tool approval")
        },
      },
    )
    assert(typeof screenshot !== "string")
    const attachment = screenshot.attachments?.[0]
    assert(attachment)
    assert.equal(attachment.mime, "image/jpeg")
    assert(attachment.url.startsWith("data:image/jpeg;base64,"))
    assert.deepEqual(permissions, [])
    assert.equal(prompts, promptCount, "Whole-tab grant requires no screenshot dialog")
    console.log("PASS private/wrong-task and whole-tab screenshot without per-tool or native reapproval")

    for (const dimensions of [
      [12_291, 100],
      [12_291, 4_096],
    ]) {
      oversizedMetrics = { width: dimensions[0]!, height: dimensions[1]! }
      oversizedMetricsApplied = false
      oversizedViewport.delete(0)
      assert(oversizedMetrics.width > 0 && oversizedMetrics.height > 0, "Oversized device metrics are valid")
      const before = captures
      const response = await shot()
      console.log(
        "Oversized viewport witness",
        JSON.stringify({
          requested: oversizedMetrics,
          measured: oversizedViewport.get(0),
          ok: response.ok,
          code: response.ok ? undefined : response.code,
          viewportWidth: response.ok ? response.result.screenshot?.viewportWidth : undefined,
          viewportHeight: response.ok ? response.result.screenshot?.viewportHeight : undefined,
          captures: captures - before,
        }),
      )
      await send("Emulation.clearDeviceMetricsOverride")
      oversizedMetrics = undefined
      oversizedMetricsApplied = false
      const width = Math.ceil(oversizedViewport.get(0)?.width ?? 0)
      const height = Math.ceil(oversizedViewport.get(0)?.height ?? 0)
      assert(
        width > MAX_SCREENSHOT_EDGE || height > MAX_SCREENSHOT_EDGE || width * height > MAX_SCREENSHOT_PIXELS,
        `Driver-observed viewport must exceed screenshot bounds: ${width}x${height}`,
      )
      noImage(response)
      assert.equal(captures, before, `Oversized driver-observed viewport ${width}x${height}: zero captures`)
    }
    await contents.executeJavaScript(`(() => {
      const c=document.createElement('canvas');c.width=600;c.height=400;
      c.style.cssText='position:fixed;inset:0;width:600px;height:400px;z-index:10';document.body.append(c);
      const ctx=c.getContext('2d'), image=ctx.createImageData(600,400);let seed=7;
      for(let i=0;i<image.data.length;i+=4){for(let j=0;j<3;j++){seed=(Math.imul(seed,1664525)+1013904223)|0;image.data[i+j]=seed>>>24}image.data[i+3]=255}
      ctx.putImageData(image,0,0);
    })()`)
    await setTimeout(100)
    const entropyBefore = captures
    const entropy = await shot()
    assert(rawBytes > MAX_SCREENSHOT_BYTES)
    assert.equal(captures, entropyBefore + 1, "High-entropy bounded capture uses one native screenshot")
    if (entropy.ok) {
      const image = entropy.result.screenshot
      assert(image, "A fitting high-entropy capture returns a screenshot")
      const bytes = Buffer.from(image.data, "base64")
      assert(bytes.length <= MAX_SCREENSHOT_BYTES, "A successful high-entropy screenshot stays under the byte cap")
      assert(image.width <= MAX_SCREENSHOT_EDGE && image.height <= MAX_SCREENSHOT_EDGE)
      assert(image.width * image.height <= MAX_SCREENSHOT_PIXELS)
      assert(image.scaleX !== undefined && image.scaleX >= 0.5)
      assert(image.scaleY !== undefined && image.scaleY >= 0.5)
      console.log(
        "PASS bounded high-entropy screenshot",
        JSON.stringify({ bytes: bytes.length, width: image.width, height: image.height }),
      )
    } else {
      assert.equal(entropy.code, "unavailable", "An unfit high-entropy capture returns a typed bounded failure")
      noImage(entropy)
      console.log("PASS high-entropy screenshot rejected with a bounded failure")
    }
    console.log(
      "PASS size limits",
      JSON.stringify({ highEntropyBytes: rawBytes, rawLimit: MAX_SCREENSHOT_BYTES, responseLimit: MAX_SNAPSHOT_BYTES }),
    )
    await contents.loadURL(url)
    while (contents.isLoadingMainFrame()) await setTimeout(10)
    embeddedChanged = false
    await contents.executeJavaScript("history.replaceState(null,'','?long='+'x'.repeat(65536))")
    noImage(await shot())
    await contents.loadURL(url)
    while (contents.isLoadingMainFrame()) await setTimeout(10)
    embeddedChanged = false

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
          reason === "registration" ? { ...tab, id: id + "-registration", captureOwner: tab.captureOwner } : undefined
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
            embeddedChanged = false
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
            if (reason === "registration") {
              const replaced = await routeBrowserRequest({
                type: "browser_request",
                id: "replaced-registration",
                sessionID: "screenshots",
                request: { op: "read_state", tabID: request.tabID },
              })
              assert(!replaced.ok && replaced.code === "access_denied", JSON.stringify(replaced))
            } else if (tab.agentAccess && allowed) {
              const busy = await routeBrowserRequest({
                type: "browser_request",
                id: "busy",
                sessionID: "screenshots",
                request: { op: "read_state", tabID: request.tabID },
              })
              assert(!busy.ok && busy.code === "unavailable", JSON.stringify(busy))
            }
          }
          release.resolve()
          noImage(await pending)
          await settled
          if (phase === "capture") assert.equal(contents.backgroundThrottling, true)
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
    const finalPrompts = prompts
    await pixels(await shot(), "final-tab-authority")
    assert.equal(prompts, finalPrompts)
    assert.equal(win.isEnabled(), true)
    assert.equal(owner.suspended, 0)
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
