import assert from "node:assert/strict"
import { execFile } from "node:child_process"
import { once } from "node:events"
import { createServer } from "node:http"
import { setTimeout } from "node:timers/promises"
import { promisify } from "node:util"
import { BrowserWindow, screen } from "electron"
import { browserCommand, browserViewport, registerBrowserOwner } from "./tabs"

export async function dragRegionsSmoke() {
  assert(process.env.CM_BROWSER_SMOKE_PROFILE, "Only run through the isolated smoke runner")
  assert.equal(process.platform, "win32", "Native caption hit testing requires Windows")
  const server = createServer((_request, response) => {
    response.writeHead(200, { "Content-Type": "text/html" })
    response.end(`<!doctype html><title>Drag fixture</title>
      <style>body { margin:0; height:1000px; app-region:drag !important }
      input { position:absolute; left:200px; top:100px; app-region:drag !important }</style>
      <input id="input">`)
  })
  server.listen(0, "127.0.0.1")
  await once(server, "listening")
  const address = server.address()
  assert(address && typeof address === "object")
  const url = `http://127.0.0.1:${address.port}/`
  const win = new BrowserWindow({
    width: 1000,
    height: 750,
    show: false,
    frame: false,
    titleBarStyle: "hidden",
    titleBarOverlay: { height: 36 },
    webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false },
  })
  const owner = registerBrowserOwner(win)
  const command = (value: Parameters<typeof browserCommand>[2]) => browserCommand(owner, "drag", value)
  try {
    await win.loadURL(
      "data:text/html,<style>header{height:36px;app-region:drag}body{margin:0}</style><header></header>",
    )
    win.showInactive()
    const first = (await command({ op: "new" })).activeID!
    for (const destination of [url, `${url}?navigated`]) {
      await command({ op: "navigate", tabID: first, url: destination })
      await check(first)
    }
    await owner.groups
      .get("drag")!
      .tabs[0].view.webContents.executeJavaScript(`void window.open(${JSON.stringify(url)})`, true)
    for (let attempt = 0; attempt < 100 && owner.groups.get("drag")!.tabs.length < 2; attempt++) await setTimeout(30)
    assert.equal(owner.groups.get("drag")!.tabs.length, 2)
    await check(owner.groups.get("drag")!.tabs[1].id)
    console.log(
      "PASS native hit tests: header stays caption; browser input/background stay client after navigation/popup",
    )
  } finally {
    win.destroy()
    server.close()
  }

  async function check(tabID: string) {
    const tab = owner.groups.get("drag")!.tabs.find((tab) => tab.id === tabID)!
    for (let attempt = 0; attempt < 100 && tab.contents.isLoadingMainFrame(); attempt++) await setTimeout(30)
    assert.equal(tab.contents.isLoadingMainFrame(), false)
    await command({ op: "select", tabID })
    browserViewport(owner, { sessionID: "drag", lease: "drag", bounds: { x: 0, y: 100, width: 800, height: 500 } })
    await tab.view.webContents.executeJavaScript(
      "new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))",
    )
    await setTimeout(200)
    const bounds = win.getContentBounds()
    const points = [
      { x: 100, y: 18 },
      { x: 250, y: 215 },
      { x: 700, y: 450 },
    ].map((point) => screen.dipToScreenPoint({ x: bounds.x + point.x, y: bounds.y + point.y }))
    // Query this owned fixture's native routing; do not synthesize mouse or keyboard input.
    const script = `Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
public static class CaptionHitTest {
  [DllImport("user32.dll")] static extern uint GetWindowThreadProcessId(IntPtr hwnd, out uint pid);
  [DllImport("user32.dll")] static extern IntPtr SendMessageTimeoutW(IntPtr hwnd, uint message, IntPtr wp, IntPtr lp, uint flags, uint timeout, out UIntPtr result);
  public static ulong Query(long handle, uint expected, int x, int y) {
    var hwnd = new IntPtr(handle); uint actual; GetWindowThreadProcessId(hwnd, out actual);
    if(actual != expected) throw new Exception("Fixture window ownership changed");
    UIntPtr result; uint point = ((uint)y & 65535) << 16 | ((uint)x & 65535);
    if(SendMessageTimeoutW(hwnd, 0x84, IntPtr.Zero, new IntPtr((long)point), 2, 500, out result) == IntPtr.Zero)
      throw new Exception("Fixture hit test timed out");
    return result.ToUInt64();
  }
}
'@
${points.map((point) => `[CaptionHitTest]::Query(${win.getNativeWindowHandle().readBigUInt64LE()}, ${process.pid}, ${point.x}, ${point.y})`).join("\n")}`
    const result = await promisify(execFile)("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", script], {
      windowsHide: true,
      timeout: 10_000,
    })
    assert.deepEqual(result.stdout.trim().split(/\s+/).map(Number), [2, 1, 1], "Only the shell header may be HTCAPTION")
  }
}
