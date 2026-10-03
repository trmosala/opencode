import assert from "node:assert/strict"
import { once } from "node:events"
import { createServer } from "node:http"
import { setTimeout } from "node:timers/promises"
import { BrowserWindow, WebContentsView } from "electron"
import type { ToolContext } from "@opencode-ai/plugin"
import { MAX_SNAPSHOT_BYTES, type Request, type WriteRequest } from "@cookiemonster/cm-browser/protocol"
import { browserTools } from "../../../../cm-browser/src/tools"
import { registerBrowserTab, type BrowserRegistration } from "./registry"
import { routeBrowserRequest } from "./router"

export async function snapshotsSmoke() {
  assert(process.env.CM_BROWSER_SMOKE_PROFILE)
  const server = createServer((_request, response) => {
    response.writeHead(200, { "Content-Type": "text/html" })
    response.end(`<!doctype html><title>Snapshots</title><style>
      body { margin: 8px } button, [role], input, textarea { margin: 3px; min-width: 40px; min-height: 20px }
      </style><body>
      <span id="name">Referenced</span><button aria-labelledby="name" aria-label="Wrong">Content</button>
      <label>Native label<input type="checkbox" checked aria-checked="false"></label>
      <div role="checkbox" aria-label="Custom" aria-checked="mixed" tabindex="0"></div>
      <div role="tab" aria-label="Tab" aria-selected="false"></div>
      <button aria-label="Disclosure" aria-expanded="true"></button>
      <button disabled>Disabled</button><div aria-disabled="true"><button>Inherited disabled</button></div>
      <button><img alt="Alternative"></button>
      <div id="duplicates"><button id="first">Duplicate</button><button id="second">Duplicate</button></div>
      <div id="other"></div>
      <label id="safe">Safe label<textarea>sentinel-textarea</textarea></label>
      <input autocomplete="username" value="sentinel-user">
      <input autocomplete="one-time-code" value="sentinel-otp">
      <input autocomplete="current-password" value="sentinel-revealed">
      <input type="password" value="sentinel-password">
      <div contenteditable><span id="editable">sentinel-editable</span><span id="editable-host"></span></div>
      <button aria-labelledby="safe editable">Safe fallback</button>
      <div id="host"><button slot="item">Slotted</button></div>
      <script>
      window.clicked = [];
      document.addEventListener("click", e => clicked.push({id:e.composedPath()[0].id, trusted:e.isTrusted}));
      const root = document.getElementById("host").attachShadow({mode:"open"});
      root.innerHTML = '<span id="name">Shadow name</span><button id="shadow" aria-labelledby="name">Wrong shadow</button><slot name="item"></slot><div id="nested"></div>';
      root.getElementById("nested").attachShadow({mode:"open"}).innerHTML = '<button>Nested</button><textarea>sentinel-shadow</textarea>';
      document.getElementById("editable-host").attachShadow({mode:"open"}).innerHTML = '<span>sentinel-inherited-shadow</span>';
      </script>`)
  })
  server.listen(0, "127.0.0.1")
  await once(server, "listening")
  const address = server.address()
  assert(address && typeof address === "object")
  const url = `http://127.0.0.1:${address.port}/`
  const win = new BrowserWindow({ show: false, width: 1000, height: 850 })
  const view = new WebContentsView({
    webPreferences: { partition: "snapshots-fixture", sandbox: true, contextIsolation: true, nodeIntegration: false },
  })
  win.contentView.addChildView(view)
  view.setBounds({ x: 0, y: 0, width: 960, height: 800 })
  win.showInactive()
  const contents = view.webContents
  const tab: BrowserRegistration = {
    id: `snapshots-${contents.id}`,
    ownerID: win.id,
    sessionID: "snapshots",
    contents,
    revision: 0,
    agentAccess: true,
  }
  contents.on("dom-ready", () => {
    tab.revision++
  })
  const remove = registerBrowserTab(tab)
  let inputs = 0
  const send = contents.debugger.sendCommand.bind(contents.debugger)
  const clean = (value: unknown) =>
    assert(!JSON.stringify(value).includes("sentinel-"), "No editable values in serialized output")
  contents.debugger.sendCommand = async (method, params) => {
    if (method.startsWith("Input.")) inputs++
    const response = await send(method, params)
    if (method === "Runtime.evaluate" && params?.returnByValue) clean(response)
    return response
  }
  const route = async (request: Request) => {
    const response = await routeBrowserRequest(
      { type: "browser_request", id: "snapshots", sessionID: tab.sessionID, request },
      () => true,
    )
    clean(response)
    assert(Buffer.byteLength(JSON.stringify(response)) <= MAX_SNAPSHOT_BYTES)
    return response
  }
  const write = async (request: WriteRequest) => {
    const prepared = await route({ op: "prepare_write", request })
    assert(prepared.ok && prepared.result.context)
    return route({ ...request, context: prepared.result.context })
  }
  const snapshot = async () => {
    const response = await route({ op: "read_state", tabID: tab.id })
    assert(response.ok, JSON.stringify(response))
    const output = await browserTools({ send: async () => response }).browser_read_state.execute({ tabID: tab.id }, {
      sessionID: tab.sessionID,
      messageID: "snapshot",
      agent: "build",
      directory: ".",
      worktree: ".",
      abort: new AbortController().signal,
      metadata: () => {},
      ask: async () => {},
    } satisfies ToolContext)
    clean(output)
    return response.result
  }
  const denied = async (ref: string) => {
    const before = inputs
    const response = await write({ op: "click", tabID: tab.id, ref })
    assert(!response.ok && response.code === "stale_ref", JSON.stringify(response))
    assert.equal(inputs, before, "Rejected target dispatches zero input")
  }
  try {
    await contents.loadURL(url)
    while (contents.isLoadingMainFrame()) await setTimeout(10)
    const initial = await snapshot()
    const named = (label: string) => {
      const element = initial.elements.find((element) => element.label === label)
      assert(element, `Missing ${label}`)
      return element
    }
    assert.equal(named("Referenced").role, "button")
    assert.equal(named("Native label").checked, true)
    assert.equal(named("Custom").checked, "mixed")
    assert.equal(named("Tab").selected, false)
    assert.equal(named("Disclosure").expanded, true)
    assert.equal(named("Disabled").disabled, true)
    assert.equal(named("Inherited disabled").disabled, true)
    named("Alternative")
    named("Safe label")
    named("Shadow name")
    named("Nested")
    assert.equal(initial.elements.filter((element) => element.label === "Slotted").length, 1)
    await denied(named("Disabled").ref)
    await denied(named("Inherited disabled").ref)
    const duplicates = initial.elements.filter((element) => element.label === "Duplicate")
    assert.equal(duplicates.length, 2)
    await contents.executeJavaScript(
      "document.getElementById('duplicates').prepend(document.getElementById('second')); undefined",
    )
    assert((await write({ op: "click", tabID: tab.id, ref: duplicates[0].ref })).ok)
    assert.deepEqual(await contents.executeJavaScript("clicked"), [{ id: "first", trusted: true }])
    await contents.executeJavaScript(
      "document.getElementById('first').replaceWith(document.getElementById('first').cloneNode(true)); undefined",
    )
    await denied(duplicates[0].ref)
    await contents.executeJavaScript(
      "document.getElementById('other').append(document.getElementById('second')); undefined",
    )
    await denied(duplicates[1].ref)
    assert((await write({ op: "click", tabID: tab.id, ref: named("Shadow name").ref })).ok)
    assert.equal(await contents.executeJavaScript("clicked.at(-1).id"), "shadow")
    await contents.executeJavaScript(
      "document.getElementById('other').attachShadow({mode:'open'}).append(document.getElementById('host').shadowRoot.getElementById('nested')); undefined",
    )
    await denied(named("Nested").ref)
    await contents.executeJavaScript(
      "document.getElementById('host').shadowRoot.querySelector('slot').replaceWith(document.createElement('slot')); undefined",
    )
    await denied(named("Slotted").ref)
    await contents.executeJavaScript(
      "document.getElementById('host').replaceWith(document.getElementById('host').cloneNode(true)); undefined",
    )
    await denied(named("Shadow name").ref)
    const detached = (await snapshot()).elements.find((element) => element.label === "Duplicate")!
    await contents.executeJavaScript("document.getElementById('first').remove(); undefined")
    await denied(detached.ref)
    const current = await snapshot()
    const covered = current.elements.find((element) => element.label === "Referenced")!
    await contents.executeJavaScript(
      "document.body.insertAdjacentHTML('beforeend','<div id=\"cover\" style=\"position:fixed;inset:0;z-index:100;background:white\"></div>'); undefined",
    )
    await denied(covered.ref)
    await contents.executeJavaScript(
      "document.getElementById('cover').remove(); document.querySelectorAll = () => { throw Error('sentinel-monkeypatch') }; Element.prototype.getBoundingClientRect = () => { throw Error('sentinel-monkeypatch') }; undefined",
    )
    const isolated = await snapshot()
    assert(
      isolated.elements.some((element) => element.label === "Referenced"),
      "Main-world monkeypatch cannot forge capture",
    )
    assert(
      (
        await write({
          op: "click",
          tabID: tab.id,
          ref: isolated.elements.find((element) => element.label === "Referenced")!.ref,
        })
      ).ok,
    )
    await contents.executeJavaScript(
      `document.body.insertAdjacentHTML("beforeend", "<div>" + "\\u4e2d\\\\\\"".repeat(30000) + "</div>"); undefined`,
    )
    const bounded = await snapshot()
    assert.equal(bounded.truncated, true)
    assert(bounded.visibleText.includes(String.fromCharCode(0x4e2d, 92, 34)), "Real multibyte and JSON-escaped text")
    const changing = (await snapshot()).elements.find((element) => element.label === "Disclosure")!
    await contents.executeJavaScript(`document.querySelector('[aria-label="Disclosure"]').disabled = true; undefined`)
    await denied(changing.ref)
    await contents.executeJavaScript(
      `document.querySelector('[aria-label="Disclosure"]').disabled = false; document.querySelector('[aria-label="Disclosure"]').style.visibility = "hidden"; undefined`,
    )
    await denied(changing.ref)
    await contents.executeJavaScript(
      `document.querySelector('[aria-label="Disclosure"]').style.visibility = ""; undefined`,
    )
    for (let i = 0; i < 10; i++) await snapshot()
    await denied(isolated.elements.find((element) => element.label === "Referenced")!.ref)
    const mapped = (await snapshot()).elements.find((element) => element.label === "Referenced")!
    const tree = await send("Page.getFrameTree")
    const world = await send("Page.createIsolatedWorld", {
      frameId: tree.frameTree.frame.id,
      worldName: "cm-browser-snapshot",
    })
    await send("Runtime.evaluate", {
      contextId: world.executionContextId,
      expression: "delete globalThis.__cmSnapshot",
    })
    await denied(mapped.ref)
    const original = (await snapshot()).elements.find((element) => element.label === "Referenced")!
    await contents.executeJavaScript(`(() => {
      const next = document.createElement("html");
      next.append(document.head, document.body);
      document.documentElement.replaceWith(next);
    })()`)
    await denied(original.ref)
    await contents.executeJavaScript(
      `document.body.innerHTML = "<div>".repeat(70) + "<button>Too deep</button>".repeat(5000) + "</div>".repeat(70); undefined`,
    )
    const deep = await snapshot()
    assert.equal(deep.truncated, true)
    assert.equal(deep.elements.length, 0)
    await contents.session.setProxy({ mode: "direct" })
    await contents.loadURL(`http://snapshots-http.test:${address.port}/`)
    while (contents.isLoadingMainFrame()) await setTimeout(10)
    assert.equal(await contents.executeJavaScript("isSecureContext"), false)
    const http = await snapshot()
    assert(http.url.startsWith("http://snapshots-http.test:"))
    assert(
      (await write({ op: "click", tabID: tab.id, ref: http.elements.find((el) => el.label === "Referenced")!.ref })).ok,
    )
    assert.equal(await contents.executeJavaScript("clicked.at(-1).trusted"), true)
    console.log("PASS insecure HTTP capture and ref click: isSecureContext=false")

    await contents.executeJavaScript(`document.body.innerHTML = '<form><input id="fill" aria-label="Fill"><textarea aria-label="Area"></textarea><div contenteditable aria-label="Editor" style="min-height:30px">old</div></form>';
      window.fillClicks = 0; window.submits = 0;
      document.querySelector('form').addEventListener('submit', e => { e.preventDefault(); submits++; });
      document.querySelector('form').addEventListener('click', () => fillClicks++);
      undefined`)
    const approvals: string[] = []
    const context = {
      sessionID: tab.sessionID,
      messageID: "fill",
      agent: "build",
      directory: ".",
      worktree: ".",
      abort: new AbortController().signal,
      metadata: () => {},
      ask: async (input) => {
        approvals.push(input.permission)
      },
    } satisfies ToolContext
    const tools = browserTools({ send: async (_session, request) => route(request) })
    const fill = async (ref: string) => {
      const output = await tools.browser_fill.execute({ tabID: tab.id, ref, text: "safe" }, context)
      clean(output)
    }
    const rejectFill = async (ref: string) => {
      const before = inputs
      const clicks = await contents.executeJavaScript("[fillClicks, submits]")
      approvals.length = 0
      await assert.rejects(fill(ref), /stale_ref/)
      // The existing whole-tab grant supplies authority without another tool approval.
      assert.deepEqual(approvals, [])
      assert.equal(inputs, before, "Rejected fill dispatches zero input")
      assert.deepEqual(await contents.executeJavaScript("[fillClicks, submits]"), clicks)
    }
    const editable = await snapshot()
    const oldFill = editable.elements.find((el) => el.label === "Fill")!.ref
    await contents.executeJavaScript("document.getElementById('fill').type = 'submit'; undefined")
    await rejectFill(oldFill)
    await rejectFill((await snapshot()).elements.find((el) => el.label === "Fill")!.ref)
    assert.deepEqual(await contents.executeJavaScript("[fillClicks, submits]"), [0, 0])
    assert(
      (
        await write({
          op: "click",
          tabID: tab.id,
          ref: (await snapshot()).elements.find((el) => el.label === "Fill")!.ref,
        })
      ).ok,
    )
    assert.equal(await contents.executeJavaScript("submits"), 1, "Explicit submit click still works")
    await contents.executeJavaScript("document.getElementById('fill').type = 'text'; undefined")
    const writable = await snapshot()
    for (const label of ["Fill", "Area", "Editor"]) await fill(writable.elements.find((el) => el.label === label)!.ref)
    assert.deepEqual(
      await contents.executeJavaScript(
        "[document.querySelector('input').value, document.querySelector('textarea').value, document.querySelector('[contenteditable]').textContent]",
      ),
      ["safe", "safe", "safe"],
    )
    const readonly = (await snapshot()).elements.find((el) => el.label === "Fill")!.ref
    await contents.executeJavaScript("document.getElementById('fill').readOnly = true; undefined")
    await rejectFill(readonly)
    await rejectFill((await snapshot()).elements.find((el) => el.label === "Fill")!.ref)
    const editor = (await snapshot()).elements.find((el) => el.label === "Editor")!.ref
    await contents.executeJavaScript("document.querySelector('[contenteditable]').contentEditable = 'false'; undefined")
    await rejectFill(editor)
    console.log(
      "PASS fill preflight: changed/fresh submit, readonly and editability rejection; input/textarea/editor success",
    )

    await contents.executeJavaScript(`document.body.innerHTML = '<div id="projection">Save</div>';
      document.getElementById('projection').attachShadow({mode:'open'}).innerHTML = '<button><slot>Fallback</slot></button>';
      undefined`)
    const projected = await snapshot()
    assert.equal(projected.elements.find((el) => el.tag === "button")?.label, "Save")
    assert.equal(projected.visibleText.split("Save").length - 1, 1, "Projected aggregate text is not duplicated")
    assert(!projected.visibleText.includes("Fallback"))
    await contents.executeJavaScript(
      "document.querySelector('#projection').shadowRoot.querySelector('slot').textContent = ''; undefined",
    )
    assert.equal((await snapshot()).elements.find((el) => el.tag === "button")?.label, "Save")
    await contents.executeJavaScript(`document.querySelector('#projection').textContent = '';
      document.querySelector('#projection').shadowRoot.querySelector('slot').textContent = 'Fallback'; undefined`)
    assert.equal((await snapshot()).elements.find((el) => el.tag === "button")?.label, "Fallback")
    await contents.executeJavaScript(
      `document.querySelector('#projection').innerHTML = '<span>Element save</span>'; undefined`,
    )
    assert.equal((await snapshot()).elements.find((el) => el.tag === "button")?.label, "Element save")
    await contents.executeJavaScript(
      `document.querySelector('#projection').firstChild.attachShadow({mode:'open'}).innerHTML = '<slot>Nested fallback</slot>'; undefined`,
    )
    assert.equal((await snapshot()).elements.find((el) => el.tag === "button")?.label, "Element save")
    await contents.executeJavaScript(`document.querySelector('#projection').innerHTML = '<span contenteditable>sentinel-projected</span>';
      undefined`)
    assert.equal((await snapshot()).elements.find((el) => el.tag === "button")?.label, "")
    await contents.executeJavaScript(`document.querySelector('#projection').textContent = 'sentinel-projected-inherited';
      document.querySelector('#projection').shadowRoot.querySelector('button').contentEditable = 'true'; undefined`)
    assert.equal((await snapshot()).elements.find((el) => el.tag === "button")?.label, "")
    await contents.executeJavaScript(`document.body.innerHTML = '<div id="projection" role="button"></div>';
      const host = document.getElementById('projection');
      host.attachShadow({mode:'open'}).innerHTML = '<slot>Wrong fallback</slot>';
      for (let i = 0; i < 4100; i++) host.append(document.createComment(''));
      host.append('Save');
      undefined`)
    const exhausted = await snapshot()
    assert.equal(exhausted.truncated, true)
    assert.equal(
      exhausted.elements.find((el) => el.role === "button")?.label,
      "",
      "Incomplete assignment scan cannot use fallback",
    )
    console.log(
      "PASS projected slot names: text/element/nested, fallback/empty fallback, budget, editable exclusion and unique aggregate text",
    )

    const manualOrder = await contents.executeJavaScript(`(() => {
      document.body.innerHTML = '<div id="manual"></div>';
      const host = document.getElementById('manual');
      host.append(document.createTextNode('file '), document.createTextNode('Delete '));
      const root = host.attachShadow({mode:'open', slotAssignment:'manual'});
      root.innerHTML = '<button title="Wrong title" placeholder="Wrong placeholder"><slot>Wrong fallback</slot></button>';
      const slot = root.querySelector('slot');
      slot.assign(host.lastChild, host.firstChild);
      return slot.assignedNodes().map(node => node.textContent);
    })()`)
    assert.deepEqual(manualOrder, ["Delete ", "file "], "Chromium manual assignment reverses host DOM order")
    const manual = await snapshot()
    assert.equal(manual.elements.find((el) => el.tag === "button")?.label, "", "Manual projection name is omitted")
    assert.equal(manual.elements.find((el) => el.tag === "button")?.text, "")
    assert.equal(manual.truncated, true)
    await contents.executeJavaScript(
      `document.getElementById('manual').shadowRoot.querySelector('button').setAttribute('aria-label', 'Explicit manual'); undefined`,
    )
    const explicitManual = await snapshot()
    assert.equal(explicitManual.elements.find((el) => el.tag === "button")?.label, "Explicit manual")
    assert.equal(explicitManual.elements.find((el) => el.tag === "button")?.text, "")
    assert.equal(explicitManual.truncated, true)
    await contents.executeJavaScript(`(() => {
      const root = document.getElementById('manual').shadowRoot;
      root.querySelector('button').removeAttribute('aria-label');
      root.querySelector('slot').assign();
    })()`)
    const manualFallback = await snapshot()
    assert.equal(manualFallback.elements.find((el) => el.tag === "button")?.label, "")
    assert.equal(manualFallback.truncated, true)
    console.log(
      "PASS manual slot naming: reversed assignment witnessed, omitted with truncation, explicit ARIA retained",
    )

    console.log(
      `PASS snapshots Chromium ${process.versions.chrome}: names/states, editable exclusion, duplicates, shadow/slots, ancestry, overlay, isolated-world tamper witness, bounded output`,
    )
  } finally {
    remove()
    contents.close({ waitForBeforeUnload: false })
    win.destroy()
    await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())))
  }
}
