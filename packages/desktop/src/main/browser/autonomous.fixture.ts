import assert from "node:assert/strict"
import { once } from "node:events"
import { createServer } from "node:http"
import { BrowserWindow, dialog, session } from "electron"
import type { ToolContext } from "@opencode-ai/plugin"
import { browserTools } from "../../../../cm-browser/src/tools"
import { routeBrowserRequest } from "./router"
import { browserCommand, browserLinkContext, browserViewport, registerBrowserOwner } from "./tabs"
import { BROWSER_PARTITION } from "./policy"
import { saveTabs } from "./tab-recovery"
import { desktopPanelFixture } from "./desktop-panel.fixture"

export async function autonomousBrowserSmoke() {
  assert(process.env.CM_BROWSER_SMOKE_PROFILE, "Run only through the isolated smoke runner")
  const server = createServer((_request, response) => {
    response.writeHead(200, { "Content-Type": "text/html" }).end(`<!doctype html><title>Autonomous browser</title>
      <p id="cookie"></p><input aria-label="Draft"><button onclick="document.querySelector('#result').textContent='Clicked'">Click me</button>
      <p id="result"></p><button onclick="window.onbeforeunload=e=>{e.preventDefault();e.returnValue='stay'}">Protect draft</button>
      <script>document.querySelector('#cookie').textContent=document.cookie</script>`)
  })
  server.listen(0, "127.0.0.1")
  await once(server, "listening")
  const address = server.address()
  assert(address && typeof address === "object")
  const url = `http://127.0.0.1:${address.port}/`
  const win = new BrowserWindow({ show: false, width: 800, height: 600 })
  const owner = registerBrowserOwner(win)
  const panels = desktopPanelFixture(owner)
  const task = "autonomous-browser"
  const original = dialog.showMessageBox
  let confirmations = 0
  let leave = false
  dialog.showMessageBox = (async () => {
    confirmations++
    return { response: leave ? 1 : 0, checkboxChecked: false }
  }) as typeof dialog.showMessageBox
  const tools = browserTools({
    send: (sessionID, request, signal) =>
      routeBrowserRequest({ type: "browser_request", id: crypto.randomUUID(), sessionID, request }, undefined, {
        signal,
      }),
  })
  const context: ToolContext = {
    sessionID: task,
    messageID: "autonomous",
    agent: "build",
    directory: ".",
    worktree: ".",
    abort: new AbortController().signal,
    metadata() {},
    async ask(input) {
      // The actual plugin config regression checks these defaults and user overrides.
      assert(
        ["browser_create_tab", "browser_select_tab", "browser_close_tab", "desktop_set_panel"].includes(
          input.permission,
        ),
      )
    },
  }
  const run = (name: string, args: Record<string, unknown>) => tools[name].execute(args, context)
  const text = async (name: string, args: Record<string, unknown>) => {
    const result = await run(name, args)
    return typeof result === "string" ? result : result.output
  }
  const viewport = () =>
    browserViewport(owner, {
      sessionID: context.sessionID,
      lease: "autonomous",
      bounds: { x: 0, y: 0, width: 760, height: 540 },
    })
  try {
    await win.loadURL("about:blank")
    win.show()
    browserLinkContext(owner, task, "autonomous")
    await session.fromPartition(BROWSER_PARTITION).cookies.set({ url, name: "cm_session", value: "signed-in-fixture" })
    const tabID = (await text("browser_create_tab", {})).split(" ")[1]
    assert(tabID)
    assert.equal(owner.attached?.id, tabID, "Create waits for native blank-tab readiness")
    await run("desktop_set_panel", { view: "review" })
    assert.equal(Boolean(owner.attached), false)
    await run("desktop_set_panel", { view: "hidden" })
    await run("desktop_set_panel", { view: "browser", tabID })
    assert.equal(owner.attached?.id, tabID)
    const privateID = (await browserCommand(owner, task, { op: "new" })).activeID!
    await run("browser_select_tab", { tabID })
    viewport()
    assert.match(await text("browser_navigate", { tabID, url }), /signed-in-fixture/)
    const read = await text("browser_read_state", { tabID })
    const click = read
      .split("\n")
      .find((line) => line.startsWith("[") && line.includes("Click me"))
      ?.match(/^\[([^\]]+)\]/)?.[1]
    const input = read
      .split("\n")
      .find((line) => line.startsWith("[") && line.includes("Draft"))
      ?.match(/^\[([^\]]+)\]/)?.[1]
    assert(click && input, read)
    await run("browser_fill", { tabID, ref: input, text: "Agent draft" })
    const fresh = await text("browser_read_state", { tabID })
    const button = fresh
      .split("\n")
      .find((line) => line.startsWith("[") && line.includes("Click me"))
      ?.match(/^\[([^\]]+)\]/)?.[1]
    assert(button)
    assert.match(await text("browser_click", { tabID, ref: button }), /Clicked/)
    const screenshot = await run("browser_screenshot", { tabID })
    assert(typeof screenshot === "object" && "attachments" in screenshot && screenshot.attachments?.length)
    assert.equal(confirmations, 0, "No native create/select/page/screenshot prompts")
    const inventory = await text("browser_read_state", {})
    assert(inventory.includes(tabID) && !inventory.includes(privateID))
    await assert.rejects(run("browser_read_state", { tabID: privateID }))
    await browserCommand(owner, task, { op: "agent-pause", paused: true })
    for (const [name, args] of [
      ["browser_create_tab", {}],
      ["browser_read_state", {}],
      ["browser_navigate", { tabID, url }],
      ["browser_screenshot", { tabID }],
    ] as const)
      await assert.rejects(run(name, args), /taken over/)
    assert.equal(owner.groups.get(task)?.tabs.length, 2, "Takeover cannot be bypassed with a replacement tab")
    await browserCommand(owner, task, { op: "agent-pause", paused: false })
    assert.match(await text("browser_read_state", { tabID }), /Clicked/)
    assert(!owner.groups.get(task)?.tabs.find((tab) => tab.id === privateID)?.agentAccess)
    const protectedState = await text("browser_read_state", { tabID })
    const protect = protectedState
      .split("\n")
      .find((line) => line.startsWith("[") && line.includes("Protect draft"))
      ?.match(/^\[([^\]]+)\]/)?.[1]
    assert(protect)
    await run("browser_click", { tabID, ref: protect })
    await assert.rejects(run("browser_close_tab", { tabID }))
    assert.equal(confirmations, 1, "Closing an unsaved page still asks")
    leave = true
    await run("browser_close_tab", { tabID })
    assert.equal(owner.groups.get(task)?.tabs.length, 1)

    // A saved task must not force manual restoration before autonomous browsing.
    const recovered = "autonomous-recovered"
    saveTabs({ sessionID: recovered, tabs: [{ url, title: "Saved private tab" }], active: 0, closed: [] })
    browserViewport(owner, { sessionID: task, lease: "autonomous", bounds: null })
    browserLinkContext(owner, recovered, "recovered")
    context.sessionID = recovered
    const restoredAgent = (await text("browser_create_tab", {})).split(" ")[1]
    const restored = owner.groups.get(recovered)!
    assert.equal(restored.tabs.length, 2)
    assert.equal(restored.tabs.filter((tab) => tab.agentAccess).length, 1)
    assert.equal(restored.tabs.find((tab) => tab.agentAccess)?.id, restoredAgent)
    console.log(
      "PASS autonomous CM browser: create, shared login, navigate, fill, click, screenshot, takeover/resume, private tabs, unsaved close, recovery",
    )
  } finally {
    dialog.showMessageBox = original
    panels.close()
    win.destroy()
    server.closeAllConnections()
    await new Promise<void>((resolve) => server.close(() => resolve()))
  }
}
