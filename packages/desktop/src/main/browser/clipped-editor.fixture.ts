import assert from "node:assert/strict"
import { once } from "node:events"
import { createServer } from "node:http"
import { setTimeout } from "node:timers/promises"
import { BrowserWindow, dialog } from "electron"
import { browserCommand, browserViewport, registerBrowserOwner } from "./tabs"
import { routeBrowserRequest } from "./router"
import type { FrameAction, Request, WriteRequest } from "@cookiemonster/cm-browser/protocol"

export async function clippedEditorSmoke() {
  assert(process.env.CM_BROWSER_SMOKE_PROFILE, "Only run through the isolated smoke runner")
  const lines = Number(process.env.CM_BROWSER_EDITOR_LINES ?? 30)
  assert(Number.isInteger(lines) && lines > 0 && lines <= 200)
  const overflow = process.env.CM_BROWSER_EDITOR_CLIP === "0" ? "visible" : "auto"
  const server = createServer((request, response) => {
    response.writeHead(200, { "Content-Type": "text/html; charset=utf-8" })
    response.end(`<!doctype html><title>Synthetic growing composer</title>
      <style>body{margin:0;height:580px}#composer{position:fixed;left:24px;top:24px;width:400px;height:180px;overflow:${overflow}}
      #editor{white-space:pre-wrap;line-height:24px;min-height:48px;outline:1px solid green}</style>
      <div id="composer"><span id="wrapper" style="display:contents"><div id="editor" contenteditable="true" role="textbox" aria-label="Growing draft"></div></span></div>
      ${request.url === "/" ? '<iframe src="/frame" style="position:fixed;left:24px;top:260px;width:500px;height:280px"></iframe>' : ""}
      <script>
      window.inputs=0;window.keys=0;window.clicks=0;window.submissions=0;window.wheels=0;
      editor.addEventListener('input',()=>window.inputs++);editor.addEventListener('keydown',e=>{window.keys++;if(e.key==='Enter')window.submissions++});
      editor.addEventListener('click',()=>window.clicks++);
      editor.addEventListener('wheel',e=>{if(e.isTrusted)window.wheels++});
      editor.innerText=Array.from({length:${lines}},(_,i)=>'Unsent synthetic line '+i).join('\\n');
      </script>`)
  })
  server.listen(0, "127.0.0.1")
  await once(server, "listening")
  const address = server.address()
  assert(address && typeof address === "object")
  const url = `http://127.0.0.1:${address.port}/`
  const win = new BrowserWindow({ show: false, width: 680, height: 640 })
  const owner = registerBrowserOwner(win)
  const sessionID = `clipped-editor-${win.webContents.id}`
  const originalDialog = dialog.showMessageBox.bind(dialog)
  let sequence = 0
  const route = (request: Request) =>
    routeBrowserRequest({
      type: "browser_request",
      id: `clipped-editor-${++sequence}`,
      sessionID,
      request,
    })
  try {
    await win.loadURL("about:blank")
    win.showInactive()
    browserViewport(owner, { sessionID, lease: "clipped-editor", bounds: { x: 0, y: 0, width: 620, height: 580 } })
    await browserCommand(owner, sessionID, { op: "open-link", url, destination: "browser" })
    const tab = owner.groups.get(sessionID)!.tabs.at(-1)!
    const contents = tab.view.webContents
    for (let attempt = 0; (contents.isLoading() || contents.getURL() !== url) && attempt < 150; attempt++)
      await setTimeout(20)
    assert(!contents.isLoading() && contents.getURL() === url)
    dialog.showMessageBox = (async () => ({ response: 1, checkboxChecked: false })) as typeof dialog.showMessageBox
    await browserCommand(owner, sessionID, { op: "access", tabID: tab.id, enabled: true })
    dialog.showMessageBox = originalDialog
    const longText = Array.from(
      { length: 80 },
      (_, index) => `Synthetic report line ${index}: completed controlled qualification without private event details.`,
    ).join("\n")
    for (const embedded of process.env.CM_BROWSER_EDITOR_FRAME_ONLY === "1" ? [true] : [false, true]) {
      const frame = embedded ? contents.mainFrame.frames[0] : contents.mainFrame
      assert(frame, "Synthetic nested document is attached")
      const reset = () =>
        frame.executeJavaScript(`
        composer.style.overflow=${JSON.stringify(overflow)};composer.style.top='24px';wrapper.style.cssText='display:contents';editor.style.cssText='';
        document.querySelector('#cover')?.remove();editor.contentEditable='true';
        editor.innerText=Array.from({length:${lines}},(_,i)=>'Unsent synthetic line '+i).join('\\n');
        composer.scrollTop=0;window.inputs=0;window.keys=0;window.clicks=0;window.submissions=0;window.wheels=0;
      `)
      const prepare = async (input: string | { op: "scroll"; deltaX: number; deltaY: number }) => {
        const state = await route({ op: "read_state", tabID: tab.id })
        assert(state.ok, JSON.stringify(state))
        const document = state.result.documents?.find((document) => document.url.endsWith("/frame"))
        const editor = (embedded ? document?.elements : state.result.elements)?.find(
          (element) => element.label === "Growing draft",
        )
        assert(editor, "The live clipped editor receives a real snapshot ref")
        const action: FrameAction =
          typeof input === "string" ? { op: "fill", ref: editor.ref, text: input } : { ...input, ref: editor.ref }
        if (embedded) {
          assert(document)
          const prepared = await route({
            op: "prepare_frame_input",
            tabID: tab.id,
            frameRef: document.frameRef,
            action,
          })
          assert(prepared.ok && prepared.result.frameContext, JSON.stringify(prepared))
          return () =>
            route({
              op: "frame_input",
              tabID: tab.id,
              frameRef: document.frameRef,
              action,
              frameContext: prepared.result.frameContext!,
            })
        }
        const request: WriteRequest = { ...action, tabID: tab.id }
        const prepared = await route({ op: "prepare_write", request })
        assert(prepared.ok && prepared.result.context)
        return () => route({ ...request, context: prepared.result.context! })
      }
      const witness = async () => {
        const result: unknown = await frame.executeJavaScript(
          "({inputs:window.inputs,keys:window.keys,clicks:window.clicks,submissions:window.submissions,wheels:window.wheels,scrollTop:composer.scrollTop,text:editor.innerText})",
        )
        assert(result && typeof result === "object")
        assert("inputs" in result && typeof result.inputs === "number")
        assert("keys" in result && typeof result.keys === "number")
        assert("clicks" in result && typeof result.clicks === "number")
        assert("submissions" in result && typeof result.submissions === "number")
        assert("wheels" in result && typeof result.wheels === "number")
        assert("scrollTop" in result && typeof result.scrollTop === "number")
        assert("text" in result && typeof result.text === "string")
        return {
          inputs: result.inputs,
          keys: result.keys,
          clicks: result.clicks,
          submissions: result.submissions,
          wheels: result.wheels,
          scrollTop: result.scrollTop,
          text: result.text,
        }
      }
      await reset()
      const scroll = await prepare({ op: "scroll", deltaX: 0, deltaY: 160 })
      const beforeScroll = await witness()
      assert.equal(beforeScroll.scrollTop, 0)
      const scrolled = await scroll()
      assert(
        scrolled.ok,
        `Clipped ${embedded ? "embedded" : "top-level"} anchor scroll failed: ${JSON.stringify(scrolled)}`,
      )
      await setTimeout(100)
      const afterScroll = await witness()
      assert(
        afterScroll.scrollTop > beforeScroll.scrollTop,
        "Actual native wheel scroll moves the editor scroll container",
      )
      assert(afterScroll.wheels > 0, "Clipped editor receives a trusted native wheel event")
      assert.equal(
        afterScroll.inputs + afterScroll.keys + afterScroll.clicks + afterScroll.submissions,
        0,
        "Scroll does not edit, click, or submit the draft",
      )
      console.log(
        `PASS ${embedded ? "embedded" : "top-level"} clipped anchor native wheel scroll ${beforeScroll.scrollTop}->${afterScroll.scrollTop} without draft input`,
      )
      for (const text of ["Replacement\nSynthetic\tdraft", longText]) {
        await reset()
        const fill = await prepare(text)
        const started = Date.now()
        const response = await fill()
        const observed = await witness()
        assert(
          response.ok,
          `Fresh ${embedded ? "embedded" : "top-level"} clipped editor fill failed: ${JSON.stringify(response)}; native input counts ${observed.inputs}/${observed.keys}/${observed.clicks}`,
        )
        assert.equal(observed.text, text)
        assert.equal(observed.submissions, 0, "Fill inserts whitespace without invoking Enter-to-send")
        assert(observed.keys > 0 && observed.inputs > 0, "Native input replaces the existing synthetic draft")
        console.log(
          `PASS ${embedded ? "embedded" : "top-level"} clipped native fill ${text.length} characters in ${Date.now() - started}ms without submission`,
        )
      }
      for (const display of ["inline", "contents"]) {
        await reset()
        await frame.executeJavaScript(
          `wrapper.style.display=${JSON.stringify(display)};wrapper.style.overflow='hidden'`,
        )
        const response = await (await prepare("Visible wrapper draft"))()
        assert(response.ok, `Non-clipping ${display} wrapper rejected a visible editor: ${JSON.stringify(response)}`)
      }
      for (const position of ["fixed", "absolute"]) {
        await reset()
        await frame.executeJavaScript(`wrapper.style.cssText='display:block;overflow:hidden;width:0;height:0';
          editor.style.cssText='position:${position};left:24px;top:24px;width:300px;height:100px;overflow:auto'`)
        const response = await (await prepare("Visible positioned draft"))()
        assert(
          response.ok,
          `Overflow wrapper outside ${position} containing block rejected a visible editor: ${JSON.stringify(response)}`,
        )
      }
      for (const mutation of [
        "composer.style.top='-1000px'",
        "document.body.insertAdjacentHTML('beforeend', '<div id=cover style=\"position:fixed;inset:0;background:white;z-index:100\"></div>')",
      ]) {
        await reset()
        const fill = await prepare("Must not edit")
        await frame.executeJavaScript(mutation)
        const response = await fill()
        assert(!response.ok, "Fully clipped or covered editor must reject the original ref")
        const observed = await witness()
        assert.equal(observed.inputs + observed.keys + observed.clicks, 0, "Refusal dispatches no native input")
      }
      await reset()
    }
    console.log("PASS native clipped editor visibility and occlusion guards")
  } finally {
    dialog.showMessageBox = originalDialog
    owner.shutting = true
    owner.groups.forEach((group) =>
      group.tabs.slice().forEach((tab) => {
        if (!tab.contents.isDestroyed()) tab.view.webContents.close({ waitForBeforeUnload: false })
      }),
    )
    win.destroy()
    server.closeAllConnections()
    await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())))
  }
}
