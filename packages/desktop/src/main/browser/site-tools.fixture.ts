import assert from "node:assert/strict"
import { createServer } from "node:http"
import { BrowserWindow } from "electron"
import { discoverSiteTools, invokeSiteTool, prepareSiteTool } from "./site-tools"

const page = `<!doctype html><title>WebMCP fixture</title><script>
  window.registration = new AbortController();
  window.fixtureReady = document.modelContext.registerTool({
    name: "fixture_echo",
    description: "Echo bounded fixture input",
    inputSchema: {
      type: "object",
      properties: { value: { type: "string" }, hold: { type: "boolean" } },
    },
    annotations: { readOnlyHint: true, untrustedContentHint: true, consequentialHint: false },
    execute: async (input, context) => {
      window.lastInput = input;
      if (!input.hold) return JSON.stringify({ echoed: input });
      window.started = true;
      return new Promise((resolve, reject) => {
        window.release = resolve;
        context?.signal?.addEventListener("abort", () => {
          window.cancelled = true;
          reject(context.signal.reason);
        }, { once: true });
      });
    },
  }, { signal: window.registration.signal });
</script>`

const wait = async (check: () => boolean | Promise<boolean>) => {
  for (let attempt = 0; attempt < 100; attempt++) {
    if (await check()) return
    await new Promise((resolve) => setTimeout(resolve, 30))
  }
  throw new Error("Native WebMCP condition timed out")
}

export async function siteToolsSmoke() {
  const server = createServer((request, response) => {
    response.writeHead(200, {
      "Content-Type": "text/html",
      "Cross-Origin-Opener-Policy": "same-origin",
      "Cross-Origin-Embedder-Policy": "require-corp",
    })
    response.end(request.url === "/empty" ? "<!doctype html><title>No tools</title>" : page)
  })
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve))
  const address = server.address()
  assert(address && typeof address !== "string")
  const url = `http://127.0.0.1:${address.port}/`
  const win = new BrowserWindow({
    show: false,
    webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false },
  })
  const check = () => {
    assert(!win.isDestroyed())
    assert(!win.webContents.isDestroyed())
    assert(!win.webContents.isLoadingMainFrame())
  }
  const load = async (url: string) => {
    await win.loadURL(url)
    await wait(() => !win.webContents.isLoadingMainFrame())
  }
  try {
    await load(url)
    assert.equal(
      await win.webContents
        .executeJavaScript(
          `fixtureReady.then(() => ({ isolated: crossOriginIsolated, type: typeof document.modelContext }))`,
        )
        .then((value) => value.isolated && value.type),
      "object",
    )
    const discovered = await discoverSiteTools(win.webContents, check)
    assert.equal(discovered.tools.length, 1)
    assert.deepEqual(
      {
        name: discovered.tools[0]?.name,
        readOnly: discovered.tools[0]?.readOnly,
        untrustedContent: discovered.tools[0]?.untrustedContent,
        consequential: discovered.tools[0]?.consequential,
      },
      { name: "fixture_echo", readOnly: true, untrustedContent: true, consequential: undefined },
    )
    const prepared = await prepareSiteTool(win.webContents, discovered.tools[0].ref, '{"value":"native"}', check)
    assert.deepEqual(
      await invokeSiteTool(win.webContents, prepared, '{"value":"native"}', check, new AbortController().signal),
      {
        name: "fixture_echo",
        origin: new URL(url).origin,
        content: '{"echoed":{"value":"native"}}',
      },
    )

    const held = await prepareSiteTool(win.webContents, discovered.tools[0].ref, '{"hold":true}', check)
    const controller = new AbortController()
    const pending = invokeSiteTool(win.webContents, held, '{"hold":true}', check, controller.signal)
    await wait(() => win.webContents.executeJavaScript("Boolean(window.started)"))
    controller.abort()
    await assert.rejects(pending)
    assert.equal(await win.webContents.executeJavaScript("Boolean(window.started)"), true)

    const stale = await prepareSiteTool(win.webContents, discovered.tools[0].ref, "{}", check)
    await load(`${url}next`)
    await win.webContents.executeJavaScript("fixtureReady")
    await assert.rejects(invokeSiteTool(win.webContents, stale, "{}", check, new AbortController().signal))
    const current = await discoverSiteTools(win.webContents, check)
    assert.equal(current.tools.length, 1)
    await win.webContents.executeJavaScript("window.registration.abort()")
    await wait(async () => (await discoverSiteTools(win.webContents, check)).tools.length === 0)
    await load(url)
    await win.webContents.executeJavaScript("fixtureReady")
    const beforeReload = await discoverSiteTools(win.webContents, check)
    await load(url)
    await win.webContents.executeJavaScript("fixtureReady")
    const afterReload = await discoverSiteTools(win.webContents, check)
    assert.equal(afterReload.tools.length, 1)
    assert.notEqual(afterReload.tools[0].ref, beforeReload.tools[0].ref)
    const otherOrigin = url.replace("127.0.0.1", "localhost")
    await load(`${otherOrigin}empty`)
    const empty = await discoverSiteTools(win.webContents, check)
    assert.equal(empty.origin, new URL(otherOrigin).origin)
    assert.equal(empty.tools.length, 0)
    console.log("PASS native WebMCP discovery, execution, cancellation, navigation and removal")
  } finally {
    if (win.webContents.debugger.isAttached()) win.webContents.debugger.detach()
    if (!win.isDestroyed()) win.destroy()
    await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())))
  }
}
