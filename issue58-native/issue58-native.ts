import assert from "node:assert/strict"
import { app, BrowserWindow, desktopCapturer, screen } from "electron"
import { createServer } from "node:http"
import { join } from "node:path"
import { readFile, writeFile, mkdir } from "node:fs/promises"
import { browserCommand, browserViewport, registerBrowserOwner } from "../../packages/desktop/src/main/browser/tabs"

console.log('Corner entry started')
const directory = process.env.CM_BROWSER_SMOKE_PROFILE!
const output = process.env.CM_CORNER_OUTPUT!
assert(directory && output, "Requires an isolated profile and output path")
app.setPath("userData", join(directory, "profile"))
app.setPath("sessionData", join(directory, "session"))
app.commandLine.appendSwitch("force-color-profile", "srgb")
app.commandLine.appendSwitch("force-device-scale-factor", process.env.CM_CORNER_SCALE ?? "1")
app.commandLine.appendSwitch("disable-features", "CalculateNativeWinOcclusion")
app.on("window-all-closed", () => {})
async function run() {
await app.whenReady()
console.log('Corner Electron ready')
await mkdir(output, { recursive: true })
const server = createServer(async (request, response) => {
  if (request.url === "/page") {
    response.writeHead(200, { "content-type": "text/html" })
    response.end('<!doctype html><body style="margin:0;background:rgb(40,180,80);color:black;font:24px sans-serif"><p>Native page — corner review</p>')
    return
  }
  if (request.url === "/") {
    response.writeHead(200, { "content-type": "text/html" })
    response.end('<html data-theme="oc-2"><head><link rel="stylesheet" href="/app.css"></head><body><script type="module" src="/review.mjs"></script></body></html>')
    return
  }
  const name = new URL(request.url!, "http://localhost").pathname
  const bytes = await readFile(join(output, name.slice(1))).catch(() => undefined)
  response.writeHead(bytes ? 200 : 404, { "content-type": name.endsWith(".css") ? "text/css" : name.endsWith(".mjs") ? "text/javascript" : "application/octet-stream" })
  response.end(bytes)
})
await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve))
const address = server.address()
assert(address && typeof address !== "string")
const win = new BrowserWindow({ width: 940, height: 780, frame: false, show: false, title: "CM Browser #58 — isolated corner review" })
const owner = registerBrowserOwner(win)
const results: unknown[] = []
const failures: unknown[] = []
const wait = async (check: () => boolean | Promise<boolean>) => {
  for (let attempt = 0; attempt < 150; attempt++) {
    if (await check()) return
    await new Promise(resolve => setTimeout(resolve, 20))
  }
  console.log('timeout state', owner.viewport, await win.webContents.executeJavaScript("({dimensions:[innerWidth,innerHeight],bounds:window.reviewBounds,host:document.getElementById('review-panel').getBoundingClientRect().toJSON(),active:document.activeElement?.outerHTML,overlays:[...document.querySelectorAll('[role=tooltip],[role=menu],[role=listbox]')].map(el=>el.outerHTML)})"))
  throw Error("Corner fixture timed out")
}
try {
  await win.loadURL(`http://127.0.0.1:${address.port}/`)
  console.log('Corner renderer loaded')
  win.showInactive()
  await wait(() => win.webContents.executeJavaScript("!!window.reviewPlatform"))
  console.log('Corner panel mounted')
  const state = await browserCommand(owner, "review", { op: "new" })
  const tab = owner.groups.get("review")!.tabs.find(tab => tab.id === state.activeID)!
  await browserCommand(owner, "review", { op: "navigate", tabID: tab.id, url: `http://127.0.0.1:${address.port}/page` })
  await wait(() => !tab.contents.isLoading())
  win.webContents.debugger.attach("1.3")
  await win.webContents.debugger.sendCommand("Runtime.enable")
  await win.webContents.debugger.sendCommand("Runtime.addBinding", { name: "cornerViewport" })
  win.webContents.debugger.on("message", (_event, method, params) => {
    if (method !== "Runtime.bindingCalled" || params.name !== "cornerViewport") return
    const input = JSON.parse(params.payload)
    try { browserViewport(owner, input) } catch(error) { failures.push(String(error)) }
  })
  await win.webContents.executeJavaScript(`
    window.reviewPlatform.browserPanel.viewport = async input => { window.reviewBounds=input.bounds; window.cornerViewport(JSON.stringify(input)); };
    document.body.style.background='#e000e0';
    document.activeElement?.blur();
    const host=document.getElementById('host');
    host.style.cssText='position:absolute;left:24px;top:24px;width:calc(100vw - 48px);height:calc(100vh - 48px)';
    host.id='review-panel';
    window.reviewState(${JSON.stringify(await browserCommand(owner, "review", { op: "state" }))}); true
  `)
  for (const layout of ["classic", "new"]) for (const direction of ["ltr", "rtl"]) for (const zoom of [0.8, 1, 1.25]) for (const width of [940, 620, 390]) {
    console.log('Checking',layout,direction,zoom,width)
    win.setContentSize(width, 700)
    win.webContents.setZoomFactor(zoom)
    await win.webContents.executeJavaScript(`
      document.body.toggleAttribute('data-new-layout',${layout === "new"});
      document.documentElement.dir=${JSON.stringify(direction)};
      document.getElementById('review-panel').className=${JSON.stringify("relative min-w-0 flex overflow-hidden h-full " + (layout === "new" ? "bg-v2-background-bg-base rounded-[10px] shadow-[var(--v2-elevation-raised)]" : "bg-background-base"))}; document.activeElement?.blur(); true
    `)
    await browserCommand(owner, "review", { op: "zoom", tabID: tab.id, factor: zoom })
    await wait(() => owner.attached === tab)
    await new Promise(resolve => setTimeout(resolve, 100))
    const metrics = await win.webContents.executeJavaScript(`(() => {
      const host=document.getElementById('review-panel'), css=getComputedStyle(host);
      return {host:host.getBoundingClientRect().toJSON(), radius:parseFloat(css.borderBottomLeftRadius), viewport:window.reviewBounds, dpr:devicePixelRatio, zoom:visualViewport.scale};
    })()`)
    const native = tab.view.getBounds()
    const bottom = (metrics.host.bottom - metrics.radius) * zoom
    assert(native.y + native.height <= Math.ceil(bottom) + 1, "Native page intersects the bottom corner band")
    assert(native.x >= Math.floor(metrics.host.left * zoom), "Native page crosses host left edge")
    assert(native.x + native.width <= Math.ceil(metrics.host.right * zoom) + 1, "Native page crosses host right edge")
    results.push({ layout, direction, zoom, width, display: screen.getDisplayMatching(win.getBounds()).scaleFactor, metrics, native })
    if ((zoom === 1 && width === 940) || (zoom === 1.25 && width === 390)) {
      // Window capture must include native child pixels; DOM-only capture is not evidence for this issue.
      const sources = await desktopCapturer.getSources({ types: ["window"], thumbnailSize: { width: 1880, height: 1400 } })
      const source = sources.find(source => source.id === win.getMediaSourceId())
      assert(source && !source.thumbnail.isEmpty(), "Owned native window capture unavailable")
      const bitmap = source.thumbnail.toBitmap()
      const green = Array.from({ length: Math.floor(bitmap.length / 4) }, (_, i) => i * 4).some(i => Math.abs(bitmap[i] - 80) < 5 && Math.abs(bitmap[i+1] - 180) < 5 && Math.abs(bitmap[i+2] - 40) < 5)
      assert(green, "Capture omitted the native green page")
      const name = `native-${layout}-${direction}-scale-${process.env.CM_CORNER_SCALE}${width === 390 ? '-narrow-zoom' : ''}.png`
      await writeFile(join(output, name), source.thumbnail.toPNG())
      if(width === 940) {
        const size=source.thumbnail.getSize()
        const factor=size.width/width
        const y=Math.max(0,Math.floor((metrics.host.bottom-24)*zoom*factor))
        const height=Math.min(64,size.height-y)
        await writeFile(join(output,name.replace('.png','-corners.png')),source.thumbnail.crop({x:Math.floor(metrics.host.left*zoom*factor),y,width:Math.floor(metrics.host.width*zoom*factor),height}).resize({width:1880}).toPNG())
      }
      console.log("Captured", name, source.thumbnail.getSize())
    }
  }
  assert.deepEqual(failures, [])
  const control = await win.webContents.executeJavaScript("document.getElementById('review-panel').style.borderRadius='24px'; document.getElementById('review-panel').getBoundingClientRect().toJSON()")
  assert(tab.view.getBounds().y + tab.view.getBounds().height > (control.bottom - 24) * win.webContents.getZoomFactor(), "Detector must reject a host radius larger than its inset")
  await writeFile(join(output, `native-scale-${process.env.CM_CORNER_SCALE}.json`), JSON.stringify({ results, failures }, null, 2))
  console.log("PASS", results.length, "native corner geometry cases")
  if(process.env.CM_CORNER_HOLD==='1') {
    win.setContentSize(940,700)
    win.webContents.setZoomFactor(1)
    tab.contents.setZoomFactor(1)
    await win.webContents.debugger.sendCommand('Runtime.addBinding',{name:'cornerControl'})
    win.webContents.debugger.on('message',(_event,method,params)=>{
      if(method!=='Runtime.bindingCalled'||params.name!=='cornerControl')return
      const value=JSON.parse(params.payload)
      if(value.close){win.close();return}
      void (async()=>{
        win.setContentSize(value.width,700)
        win.webContents.setZoomFactor(value.zoom)
        tab.contents.setZoomFactor(value.zoom)
        await win.webContents.executeJavaScript(`document.body.toggleAttribute('data-new-layout',${value.layout==='new'});document.documentElement.dir=${JSON.stringify(value.direction)};document.getElementById('review-panel').className=${JSON.stringify('relative min-w-0 flex overflow-hidden '+(value.layout==='new'?'bg-v2-background-bg-base rounded-[10px] shadow-[var(--v2-elevation-raised)]':'bg-background-base'))}; document.activeElement?.blur();true`)
      })().catch(error=>console.error(error))
    })
    await win.webContents.executeJavaScript(`
      document.getElementById('review-panel').style.borderRadius='';
      document.getElementById('review-panel').style.top='56px';
      document.getElementById('review-panel').style.height='calc(100vh - 80px)';
      document.body.toggleAttribute('data-new-layout',true);document.documentElement.dir='ltr';
      const controls=document.createElement('div');controls.style.cssText='position:fixed;top:8px;left:8px;background:white;color:black;padding:4px;font:14px sans-serif;z-index:9999';
      controls.innerHTML='<label>Layout <select id="corner-layout"><option value="new">New</option><option>classic</option></select></label> <label>Direction <select id="corner-dir"><option>ltr</option><option>rtl</option></select></label> <label>Width <select id="corner-width"><option>940</option><option>620</option><option>390</option></select></label> <label>Zoom <select id="corner-zoom"><option value="1">100%</option><option value="0.8">80%</option><option value="1.25">125%</option></select></label> <button id="corner-close">Close fixture</button>';
      controls.addEventListener('change',()=>window.cornerControl(JSON.stringify({layout:document.getElementById('corner-layout').value,direction:document.getElementById('corner-dir').value,width:Number(document.getElementById('corner-width').value),zoom:Number(document.getElementById('corner-zoom').value)})));
      document.body.append(controls);document.getElementById('corner-close').onclick=()=>window.cornerControl(JSON.stringify({close:true}));true
    `)
    console.log('READY HUMAN REVIEW — isolated native dev fixture with layout, direction, width and zoom controls')
    await new Promise<void>(resolve=>win.once('closed',()=>resolve()))
  }
} finally {
  if(!win.isDestroyed())win.destroy()
  await new Promise<void>(resolve => server.close(() => resolve()))
  app.quit()
}
}
run().then(() => app.exit(0), error => { console.error(error); app.exit(1) })
