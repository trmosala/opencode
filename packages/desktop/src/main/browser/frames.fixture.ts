import assert from "node:assert/strict"
import { EventEmitter, once } from "node:events"
import { attachBrowserBridge } from "./bridge"
import type { BrowserIpcResult } from "@cookiemonster/cm-browser/protocol"
import { createServer } from "node:http"
import { setTimeout } from "node:timers/promises"
import { BrowserWindow, WebContentsView, dialog } from "electron"
import { writeFileSync, unlinkSync } from "node:fs"
import { join } from "node:path"
import { allowed, updateAgentHost } from "./allowlist"
import { browserCommand, registerBrowserOwner } from "./tabs"
import { saveTransferRule } from "./transfer-permissions"
import { prepareLoginScript } from "./login-form"
import { browserOperationBusy, setBrowserAgentEnabled } from "./registry"
import type { Request, WriteRequest } from "@cookiemonster/cm-browser/protocol"
import { registerBrowserTab, type BrowserRegistration } from "./registry"
import { routeBrowserRequest } from "./router"
import { browserInputFailure } from "./driver"
import { guardUploads } from "./transfer-permissions"
import { browserTools } from "../../../../cm-browser/src/tools"
import type { ToolContext } from "@opencode-ai/plugin"

export async function framesSmoke() {
  assert(process.env.CM_BROWSER_SMOKE_PROFILE, "Only run through the isolated smoke runner")
  const server = createServer((request, response) => {
    response.writeHead(200, { "Content-Type": "text/html" })
    response.end(
      request.url === "/child"
        ? `<!doctype html><input id="child" value="EDITABLE-SECRET"><p>CHILD-READ</p><div style="height:2000px"></div>
        <script>window.events=[]; for(const type of ["keydown","keyup","input","wheel"])
        document.addEventListener(type,e=>events.push([type,e.isTrusted]),{passive:true});
        onmessage=()=>document.querySelector("input").focus();</script>`
        : `<!doctype html><style>body{margin:0;height:2000px}input{width:120px;height:30px}
        iframe{position:absolute;left:180px;top:80px;width:350px;height:260px}</style>
        <input id="original" aria-label="Original" value="original"><input id="other" value="other" tabindex="-1">
        <iframe src="/child"></iframe>
        <script>window.events=[]; for(const type of ["keydown","keyup","input","wheel"])
        document.addEventListener(type,e=>events.push([type,e.isTrusted]),{passive:true});</script>`,
    )
  })
  server.listen(0, "127.0.0.1")
  await once(server, "listening")
  const address = server.address()
  assert(address && typeof address === "object")
  const url = `http://127.0.0.1:${address.port}/`
  const extra = new WebContentsView()
  extra.webContents.close()
  const win = new BrowserWindow({ show: false, width: 640, height: 480 })
  assert.notEqual(win.id, win.webContents.id, "production owner IDs must not accidentally coincide")
  const owner = registerBrowserOwner(win)
  setBrowserAgentEnabled(true)
  win.showInactive()
  const failures: string[] = []
  const containment = ["paint", "content", "strict", "layout paint", "auto", "hidden"].flatMap((value) =>
    ["ancestor", "owner"].map((target) => `contain-${target}-${value}`),
  )
  try {
    for (const kind of [
      ...containment.map((value) => `${value}-discovery`),
      "border-discovery",
      "clip-discovery",
      "policy",
      "session-overflow",
      "context-overflow",
      "uploads",
      "reads",
      "selects",
      "sessions",
      "key-same",
      "key-cross",
      "fill-click",
      "fill-down",
      "fill-replace",
      "tab-child",
      "wheel-same",
      "wheel-cross",
      "normal",
      "editor-wrap",
      "editor-textarea",
      "editor-shadow",
      "editor-covered",
    ]) {
      if (kind === "uploads") await browserCommand(owner, kind, { op: "open-link", url, destination: "browser" })
      const production = kind === "uploads" ? owner.groups.get(kind)!.tabs.at(-1)! : undefined
      const view =
        production?.view ??
        new WebContentsView({
          webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false },
        })
      win.contentView.addChildView(view)
      view.setBounds({ x: 0, y: 0, width: 600, height: 400 })
      const contents = view.webContents
      const tab: BrowserRegistration = production ?? {
        id: `frames-${contents.id}`,
        ownerID: win.webContents.id,
        sessionID: "frames",
        contents,
        revision: 0,
        agentAccess: true,
      }
      if (production) assert.equal(production.ownerID, win.webContents.id)
      contents.on("did-start-navigation", (_event, _url, _same, main) => {
        if (main) tab.revision++
      })
      contents.on("dom-ready", () => {
        tab.revision++
      })
      const remove = production ? () => {} : registerBrowserTab(tab)
      const input: Record<string, unknown>[] = []
      const send = contents.debugger.sendCommand.bind(contents.debugger)
      const commands: { method: string; sessionID?: string }[] = []
      const attached: string[] = []
      let holdTree: (() => Promise<void>) | undefined
      let holdResult: (() => Promise<void>) | undefined
      const revokeReceiver = async () => {
        updateAgentHost("localhost", true)
        assert(allowed(url) && !allowed(url.replace("127.0.0.1", "localhost")), "receiver only removed")
        updateAgentHost("localhost")
        assert(allowed(url.replace("127.0.0.1", "localhost")), "receiver restored")
      }
      let childReads = 0
      let mutations = 0
      let receiverAllowed = true
      contents.debugger.on("message", (_event, method, params) => {
        if (method === "Target.attachedToTarget") attached.push(params.sessionId)
      })
      contents.debugger.sendCommand = async (method, params, sessionID) => {
        if (method.startsWith("Input.")) input.push(params)
        if (
          method === "Runtime.evaluate" &&
          String(params?.expression).includes("const p = globalThis.__cmFrameDocument")
        )
          childReads++
        if (kind === "sessions") commands.push({ method, sessionID })
        const result = await send(method, params, sessionID)
        if (
          method === "Runtime.evaluate" &&
          String(params?.expression).includes(
            'Object.getOwnPropertyDescriptor(HTMLOptionElement.prototype, "selected")',
          ) &&
          result?.result?.value === true
        )
          mutations++
        if (method === "Page.getFrameTree") await holdTree?.()
        if (
          method === "Runtime.evaluate" &&
          (String(params?.expression).includes("const p = globalThis.__cmFrameDocument") ||
            String(params?.expression).includes(
              'Object.getOwnPropertyDescriptor(HTMLOptionElement.prototype, "selected")',
            ))
        )
          await holdResult?.()
        return result
      }
      const route = (request: Request) =>
        routeBrowserRequest(
          { type: "browser_request", id: kind, sessionID: tab.sessionID, request },
          (destination) =>
            new URL(destination).origin === new URL(url).origin ||
            ((kind === "reads" || kind === "selects") &&
              receiverAllowed &&
              new URL(destination).origin === new URL(url.replace("127.0.0.1", "localhost")).origin),
        )
      const write = async (request: WriteRequest) => {
        const prepared = await route({ op: "prepare_write", request })
        assert(prepared.ok && prepared.result.context)
        return route({ ...request, context: prepared.result.context })
      }
      try {
        await contents.loadURL(url)
        for (let i = 0; contents.isLoading() && i < 200; i++) await setTimeout(10)
        assert(!contents.isLoading(), "bounded fixture load")
        const clipOwner = async (clip: string, baseline = false) => {
          if (clip.startsWith("contain-")) {
            const value = clip.split("-")[2]
            const visibility = value === "auto" || value === "hidden"
            const witness = await contents.executeJavaScript(`(() => {
              const node = document.querySelector("iframe");
              const el = ${clip.includes("-owner-")} ? node : document.body;
              if (${baseline}) {
                document.body.style.cssText = "position:absolute;left:50px;top:50px;width:200px;height:200px;overflow:visible";
                document.querySelectorAll("body > input").forEach(input => input.style.display = "none");
                node.style.cssText = "position:absolute;left:-10px;top:10px;width:200px;height:180px;border:0";
              } else el.style[${JSON.stringify(visibility ? "contentVisibility" : "contain")}] = ${JSON.stringify(value)};
              const r = node.getBoundingClientRect(), css = getComputedStyle(el);
              return {
                rect: [r.left,r.top,r.width,r.height],
                center: document.elementFromPoint(r.left+r.width/2,r.top+r.height/2) === node,
                edge: document.elementFromPoint(r.left+1,r.top+r.height/2) === node,
                value: css[${JSON.stringify(visibility ? "contentVisibility" : "contain")}],
                overflow: [css.overflowX,css.overflowY]
              };
            })()`)
            assert.deepEqual(witness.rect, [40, 60, 200, 180], clip)
            if (clip.includes("-ancestor-")) assert.deepEqual(witness.overflow, ["visible", "visible"], clip)
            assert.equal(witness.value, baseline ? (visibility ? "visible" : "none") : value, clip)
            if (baseline || !visibility) assert(witness.center, clip + ": center still hits")
            if (baseline) assert(witness.edge, clip + ": unclipped baseline edge")
            else if (clip.includes("-ancestor-")) assert(!witness.edge, clip + ": left edge is clipped")
            return
          }
          await contents.executeJavaScript(
            clip.startsWith("border")
              ? `document.body.style.cssText="position:absolute;left:0;top:0;width:560px;height:340px;border:20px solid black;overflow:hidden";document.querySelector("iframe").style.left="-10px";void 0`
              : clip.includes("ancestor")
                ? `document.body.style.cssText="position:absolute;left:0;top:0;width:600px;height:400px;clip:rect(0px, 600px, 400px, 30px)";void 0`
                : `document.querySelector("iframe").style.clip="rect(10px, 500px, 500px, 0px)";void 0`,
          )
          assert(
            await contents.executeJavaScript(
              `(() => { const el=document.querySelector("iframe"),r=el.getBoundingClientRect();return document.elementFromPoint(r.left+r.width/2,r.top+r.height/2)===el })()`,
            ),
            "clipped owner still passes center hit",
          )
        }
        if (kind.endsWith("-discovery")) {
          if (kind.startsWith("contain-")) await clipOwner(kind, true)
          await guardUploads(win, tab, contents)
          const baseline = await route({ op: "read_state", tabID: tab.id })
          assert(baseline.ok && baseline.result.frames?.length === 1, "clipping baseline " + JSON.stringify(baseline))
          await clipOwner(kind)
          const result = await route({ op: "read_state", tabID: tab.id })
          assert(result.ok, JSON.stringify(result))
          assert.equal(result.result.frames?.length, 0, kind + ": clipped owner must not be discovered")
          console.log("PASS", kind)
          continue
        }
        if (kind === "policy") {
          updateAgentHost("127.0.0.1")
          updateAgentHost("localhost")
          await guardUploads(win, tab, contents)
          await contents.executeJavaScript(
            `document.querySelector("iframe").src=${JSON.stringify(url.replace("127.0.0.1", "localhost") + "child")};void 0`,
          )
          for (let i = 0; contents.isLoading() && i < 200; i++) await setTimeout(10)
          const request = (request: Request) =>
            routeBrowserRequest({ type: "browser_request", id: "policy", sessionID: tab.sessionID, request }, allowed)
          const inventory = await request({ op: "read_state", tabID: tab.id })
          assert(inventory.ok && inventory.result.frames?.length === 1)
          const frameRef = inventory.result.frames[0].frameRef
          const prepared = await request({ op: "prepare_frame", tabID: tab.id, frameRef })
          assert(prepared.ok && prepared.result.frameContext)
          updateAgentHost("localhost", true)
          updateAgentHost("localhost")
          assert(allowed(url) && allowed(url.replace("127.0.0.1", "localhost")), "membership restored")
          const response = await request({
            op: "read_state",
            tabID: tab.id,
            frameRef,
            frameContext: prepared.result.frameContext,
          })
          assert(!response.ok, "receiver-only policy A-B-A must invalidate pending approval")
          console.log("PASS", kind)
          continue
        }
        if (kind.endsWith("-overflow")) {
          await guardUploads(win, tab, contents)
          const frames = tab.frameSessions!
          const stale = frames.capture()
          if (kind === "session-overflow") for (let i = 0; i < 128; i++) frames.attached("synthetic-" + i, "")
          else
            for (let i = 0; i < 257; i++)
              frames.message("Runtime.executionContextCreated", {
                context: {
                  id: 10000 + i,
                  uniqueId: "synthetic-" + i,
                  auxData: { isDefault: true, frameId: "synthetic-" + i },
                },
              })
          assert.throws(stale.check)
          const snapshot = await route({ op: "read_state", tabID: tab.id })
          assert(snapshot.ok, kind + ": independent top snapshot " + JSON.stringify(snapshot))
          assert(!snapshot.result.frames?.length)
          const picker = dialog.showOpenDialog
          let picks = 0
          dialog.showOpenDialog = (async () => {
            picks++
            return { canceled: true, filePaths: [] }
          }) as typeof dialog.showOpenDialog
          try {
            tab.agentAccess = false
            setBrowserAgentEnabled(false)
            await contents.executeJavaScript(
              `document.querySelector("iframe").src=${JSON.stringify(url.replace("127.0.0.1", "localhost") + "child")};void 0`,
            )
            for (let i = 0; contents.isLoading() && i < 200; i++) await setTimeout(10)
            const child = contents.mainFrame.frames[0]
            assert.notEqual(child.processId, contents.mainFrame.processId)
            await child.executeJavaScript(
              'document.body.innerHTML=`<input id="cancel-file" type="file">`;window.cancels=0;document.querySelector("input").oncancel=()=>cancels++;void 0',
            )
            await child.executeJavaScript('document.querySelector("input").click();void 0', true)
            await setTimeout(100)
            assert.equal(
              await child.executeJavaScript("cancels"),
              1,
              "revoked OOPIF chooser remains cancelled after cap",
            )
            assert.equal(picks, 0)
            setBrowserAgentEnabled(true)
            tab.agentAccess = true
            for (const navigated of [false, true]) {
              if (navigated) {
                await contents.loadURL(url + "?frame-free")
                for (let i = 0; contents.isLoading() && i < 200; i++) await setTimeout(10)
                await contents.executeJavaScript('document.querySelector("iframe").remove();void 0')
                await setTimeout(30)
              }
              await contents.executeJavaScript(
                'document.body.insertAdjacentHTML("afterbegin",`<input type="file" id="top-upload">`);void 0',
              )
              await contents.executeJavaScript('document.getElementById("top-upload").click();void 0', true)
              await setTimeout(100)
              assert.equal(picks, navigated ? 2 : 1, "top native picker survives cap")
              assert((await route({ op: "read_state", tabID: tab.id })).ok)
              assert.equal(tab.frameSessions, frames, "no reattach/restart")
            }
          } finally {
            dialog.showOpenDialog = picker
            setBrowserAgentEnabled(true)
          }
          console.log("PASS", kind)
          continue
        }
        if (kind === "uploads") {
          const picker = dialog.showOpenDialog,
            consent = dialog.showMessageBox
          const file = join(process.env.CM_BROWSER_SMOKE_PROFILE!, "frame-selected.txt")
          writeFileSync(file, "synthetic frame file")
          await guardUploads(win, tab, contents)
          const loaded = async () => {
            for (let i = 0; contents.isLoading() && i < 200; i++) await setTimeout(10)
            assert(!contents.isLoading())
          }
          try {
            for (const cross of [false, true]) {
              for (const change of [
                "allow",
                "cancel",
                "source",
                "receiver",
                "private",
                "global",
                "source-policy",
                "receiver-policy",
                "revoke",
                "navigate",
                "aba",
                "replace",
                "input-replace",
                "document",
                "directory",
                "sandbox",
                "hidden",
                "type",
                "mode",
                "held-source",
                "held-receiver",
                "held-source-policy",
                "held-receiver-policy",
                "policy-picker",
                "border-held",
                "clip-held",
                "clip-ancestor-held",
                ...containment,
              ]) {
                if (!cross && change === "policy-picker") continue
                updateAgentHost("127.0.0.1")
                updateAgentHost("localhost")
                setBrowserAgentEnabled(true)
                tab.agentAccess = true
                for (const host of [url, url.replace("127.0.0.1", "localhost")])
                  saveTransferRule({ origin: host, uploads: "ask", downloads: "ask" })
                await contents.loadURL(url)
                await loaded()
                const destination = (cross ? url.replace("127.0.0.1", "localhost") : url) + "child"
                await contents.executeJavaScript(`(() => {
                  const first=document.querySelector("iframe");first.style.cssText="left:10px;top:100px;width:240px;height:220px";
                  first.src=${JSON.stringify(destination)};
                  const sibling=first.cloneNode();sibling.style.left="300px";document.body.append(sibling);
                  const file=document.createElement("input");file.type="file";document.body.prepend(file);
                })()`)
                await loaded()
                const children = contents.mainFrame.frames
                assert.equal(children.length, 2)
                for (const child of children) {
                  if (cross) assert.notEqual(child.processId, contents.mainFrame.processId)
                  await child.executeJavaScript(
                    `document.body.innerHTML='<input type="file" id="upload" style="width:180px"><form method="post"><input autocomplete="username" value="USER"><input type="password" value="SECRET"></form>';window.cancelled=0;upload.oncancel=()=>cancelled++;void 0`,
                  )
                }
                if (change.startsWith("contain-")) await clipOwner(change, true)
                if (change === "source") updateAgentHost("127.0.0.1", true)
                if (change === "receiver") updateAgentHost(cross ? "localhost" : "127.0.0.1", true)
                if (change === "private") tab.agentAccess = false
                if (change === "global") setBrowserAgentEnabled(false)
                if (change === "source-policy") saveTransferRule({ origin: url, uploads: "block", downloads: "ask" })
                if (change === "receiver-policy")
                  saveTransferRule({ origin: destination, uploads: "block", downloads: "ask" })
                if (change === "directory") await children[0].executeJavaScript("upload.webkitdirectory=true;void 0")
                if (change === "sandbox")
                  await contents.executeJavaScript(
                    'document.querySelector("iframe").setAttribute("sandbox","allow-scripts allow-same-origin");void 0',
                  )
                if (change === "hidden")
                  await contents.executeJavaScript('document.querySelector("iframe").style.opacity="0";void 0')
                let prompts = 0,
                  picks = 0,
                  filesSent = 0
                const observed = Promise.withResolvers<{ frameId: string; backendNodeId: number; sessionID: string }>()
                const onChooser = (
                  _event: unknown,
                  method: string,
                  params: { frameId: string; backendNodeId: number },
                  sessionID?: string,
                ) => {
                  if (method === "Page.fileChooserOpened") observed.resolve({ ...params, sessionID: sessionID ?? "" })
                }
                contents.debugger.on("message", onChooser)
                const dispatch = contents.debugger.sendCommand
                contents.debugger.sendCommand = async (method, params, sessionID) => {
                  if (method === "DOM.setFileInputFiles" && params?.files?.length) filesSent++
                  return dispatch(method, params, sessionID)
                }
                dialog.showMessageBox = (async (_win, options) => {
                  prompts++
                  assert(options?.detail?.includes(new URL(url).origin))
                  assert(options?.detail?.includes(new URL(destination).origin))
                  assert.equal(options?.defaultId, 0)
                  assert.equal(options?.cancelId, 0)
                  return { response: change === "deny" ? 0 : 1, checkboxChecked: false }
                }) as typeof dialog.showMessageBox
                dialog.showOpenDialog = (async () => {
                  picks++
                  assert(browserOperationBusy.has(tab.id))
                  assert(
                    !(await route({ op: "read_state", tabID: tab.id })).ok,
                    "pending child picker excludes agent reads",
                  )
                  for (const child of children)
                    assert.equal(
                      await child.executeJavaScript("upload.files.length"),
                      0,
                      "held picker exposes no files",
                    )
                  if (change === "revoke") {
                    tab.accessRevision = (tab.accessRevision ?? 0) + 1
                    tab.agentAccess = false
                    tab.agentAccess = true
                  }
                  if (change === "policy-picker") await revokeReceiver()
                  if (change.startsWith("border-") || change.startsWith("clip-") || change.startsWith("contain-"))
                    await clipOwner(change)
                  if (change === "held-source") updateAgentHost("127.0.0.1", true)
                  if (change === "held-receiver") updateAgentHost(cross ? "localhost" : "127.0.0.1", true)
                  if (change === "held-source-policy")
                    saveTransferRule({ origin: url, uploads: "block", downloads: "ask" })
                  if (change === "held-receiver-policy")
                    saveTransferRule({ origin: destination, uploads: "block", downloads: "ask" })
                  if (change === "replace")
                    await contents.executeJavaScript(
                      'const el=document.querySelector("iframe");el.replaceWith(el.cloneNode());void 0',
                    )
                  if (change === "input-replace")
                    await children[0].executeJavaScript("upload.replaceWith(upload.cloneNode());void 0")
                  if (change === "type") await children[0].executeJavaScript('upload.type="text";void 0')
                  if (change === "mode") await children[0].executeJavaScript("upload.multiple=true;void 0")
                  if (change === "document")
                    await children[0].executeJavaScript(
                      'document.open();document.write("<p>replaced</p>");document.close();void 0',
                    )
                  if (change === "navigate" || change === "aba") {
                    await contents.executeJavaScript(
                      `document.querySelector("iframe").src=${JSON.stringify(destination + "?away")};void 0`,
                    )
                    await loaded()
                    if (change === "aba") {
                      await contents.executeJavaScript(
                        `document.querySelector("iframe").src=${JSON.stringify(destination)};void 0`,
                      )
                      await loaded()
                    }
                  }
                  await loaded()
                  return { canceled: change === "cancel", filePaths: change === "cancel" ? [] : [file] }
                }) as typeof dialog.showOpenDialog
                try {
                  await children[0].executeJavaScript("upload.click();void 0", true)
                  const event = await Promise.race([
                    observed.promise,
                    setTimeout(2000).then(() => {
                      throw new Error("Missing native chooser")
                    }),
                  ])
                  await setTimeout(100)
                  for (let i = 0; browserOperationBusy.has(tab.id) && i < 200; i++) await setTimeout(10)
                  assert(!browserOperationBusy.has(tab.id), "chooser settled")
                  const hostEdit = ["source", "receiver", "held-source", "held-receiver", "policy-picker"].includes(
                    change,
                  )
                  assert.equal(filesSent, change === "allow" || hostEdit ? 1 : 0, change)
                  const blocked = [
                    "private",
                    "global",
                    "source-policy",
                    "receiver-policy",
                    "directory",
                    "sandbox",
                    "hidden",
                  ].includes(change)
                  assert.equal(prompts, 0, `${change}: whole-tab grant has no receiver approval`)
                  assert.equal(picks, blocked ? 0 : 1, `${change}: exact picker count`)
                  const counts = []
                  for (const child of contents.mainFrame.frames)
                    counts.push(
                      await child.executeJavaScript('document.querySelector("input[type=file]")?.files.length || 0'),
                    )
                  assert.equal(
                    await contents.executeJavaScript('document.querySelector("input[type=file]").files.length'),
                    0,
                  )
                  if (change === "allow" || hostEdit) {
                    assert.deepEqual(counts, [1, 0], "exact native receiver, not identical-URL sibling")
                    assert.equal(await children[0].executeJavaScript("upload.files[0].text()"), "synthetic frame file")
                    assert.equal(
                      await children[0].executeJavaScript("cancelled"),
                      1,
                      "cancel:true precedes approved native delivery",
                    )
                    assert.equal(prompts, 0)
                    assert.equal(picks, 1)
                    const world = await send(
                      "Page.createIsolatedWorld",
                      { frameId: event.frameId, worldName: "fixture-password-negative" },
                      event.sessionID || undefined,
                    )
                    for (const field of [undefined, "username", "password"] as const) {
                      const rejected = await send(
                        "Runtime.evaluate",
                        {
                          contextId: world.executionContextId,
                          expression: prepareLoginScript(new URL(destination).origin, "no-ticket", field),
                          returnByValue: true,
                        },
                        event.sessionID || undefined,
                      )
                      assert(rejected.exceptionDetails, "child login preparation must reject")
                    }
                    const ticket = await send(
                      "Runtime.evaluate",
                      {
                        contextId: world.executionContextId,
                        expression: "!!document.__cmLoginTicket",
                        returnByValue: true,
                      },
                      event.sessionID || undefined,
                    )
                    assert.equal(ticket.result.value, false, "no child credential grant")
                    assert.deepEqual(
                      await children[0].executeJavaScript(
                        'Array.from(document.querySelectorAll("form input"),el=>el.value)',
                      ),
                      ["USER", "SECRET"],
                    )
                    console.log("PASS child password boundary", cross ? "OOPIF" : "same")
                  } else assert.deepEqual(counts, [0, 0], "negative chooser shares zero files")
                  console.log("PASS frame upload", cross ? "OOPIF" : "same", change)
                } finally {
                  contents.debugger.removeListener("message", onChooser)
                  contents.debugger.sendCommand = dispatch
                }
              }
            }
          } finally {
            dialog.showOpenDialog = picker
            dialog.showMessageBox = consent
            updateAgentHost("127.0.0.1")
            updateAgentHost("localhost")
            setBrowserAgentEnabled(true)
            for (const host of [url, url.replace("127.0.0.1", "localhost")])
              saveTransferRule({ origin: host, uploads: "ask", downloads: "ask" }, true)
            unlinkSync(file)
          }
          continue
        }
        if (kind === "reads") {
          await guardUploads(win, tab, contents)
          const loaded = async () => {
            for (let i = 0; contents.isLoading() && i < 200; i++) await setTimeout(10)
            assert(!contents.isLoading(), "bounded child load")
          }
          for (const cross of [false, true]) {
            for (const change of [
              "allow",
              "replace",
              "navigate",
              "aba",
              "revoke",
              "hidden",
              "covered",
              "transform",
              "border-held",
              "clip-held",
              "clip-ancestor-held",
              ...containment,
              "policy-approval",
              "policy-dispatch",
              "policy-result",
              "sandbox",
              "document",
            ]) {
              if (!cross && change.startsWith("policy-")) continue
              receiverAllowed = true
              tab.agentAccess = true
              await contents.loadURL(url)
              await loaded()
              const destination = (cross ? url.replace("127.0.0.1", "localhost") : url) + "child"
              if (cross) {
                await contents.executeJavaScript(
                  `document.querySelector("iframe").src=${JSON.stringify(destination)}; void 0`,
                )
                await loaded()
                assert.notEqual(contents.mainFrame.frames[0].processId, contents.mainFrame.processId)
              }
              if (change.startsWith("contain-")) await clipOwner(change, true)
              const before = childReads
              const inventory = await route({ op: "read_state", tabID: tab.id })
              assert(inventory.ok, JSON.stringify(inventory))
              assert.equal(childReads, before, "discovery never snapshots children")
              assert(!JSON.stringify(inventory).includes("CHILD-READ"))
              assert.equal(inventory.result.frames?.length, 1, JSON.stringify(inventory))
              const frame = inventory.result.frames![0]
              assert.equal(frame.origin, new URL(destination).origin)
              let prompts = 0
              const context: ToolContext = {
                sessionID: tab.sessionID,
                messageID: "frame-read",
                agent: "build",
                directory: ".",
                worktree: ".",
                abort: new AbortController().signal,
                metadata: () => {},
                ask: async () => {
                  prompts++
                  throw new Error("Whole-tab access must not ask for per-frame approval")
                },
              }
              if (change.startsWith("border-") || change.startsWith("clip-") || change.startsWith("contain-"))
                await clipOwner(change)
              if (change === "policy-approval") await revokeReceiver()
              if (change === "policy-dispatch")
                holdTree = async () => {
                  holdTree = undefined
                  await revokeReceiver()
                }
              if (change === "policy-result")
                holdResult = async () => {
                  holdResult = undefined
                  await revokeReceiver()
                }
              if (change === "revoke") {
                tab.accessRevision = (tab.accessRevision ?? 0) + 1
                tab.agentAccess = false
                tab.agentAccess = true
              }
              if (change === "replace")
                await contents.executeJavaScript(
                  'const el=document.querySelector("iframe");el.replaceWith(el.cloneNode());void 0',
                )
              if (change === "hidden")
                await contents.executeJavaScript('document.querySelector("iframe").style.display="none";void 0')
              if (change === "covered")
                await contents.executeJavaScript(
                  'const el=document.createElement("div");el.style.cssText="position:fixed;inset:0;z-index:999";document.body.append(el);void 0',
                )
              if (change === "transform")
                await contents.executeJavaScript('document.querySelector("iframe").style.transform="scale(.9)";void 0')
              if (change === "sandbox")
                await contents.executeJavaScript(
                  'document.querySelector("iframe").setAttribute("sandbox","allow-scripts allow-same-origin");void 0',
                )
              if (change === "document")
                await contents.mainFrame.frames[0].executeJavaScript(
                  'document.open();document.write("<p>REPLACED</p>");document.close();void 0',
                )
              if (change === "navigate" || change === "aba") {
                await contents.executeJavaScript(
                  `document.querySelector("iframe").src=${JSON.stringify(destination + "?changed")};void 0`,
                )
                await loaded()
                if (change === "aba") {
                  await contents.executeJavaScript(
                    `document.querySelector("iframe").src=${JSON.stringify(destination)};void 0`,
                  )
                  await loaded()
                }
              }
              await loaded()
              const tools = browserTools({ send: (_session, request) => route(request) })
              const promise = tools.browser_read_state.execute({ tabID: tab.id, frameRef: frame.frameRef }, context)
              if (change === "allow") {
                const output = await promise
                assert(JSON.stringify(output).includes("CHILD-READ"))
                assert(!JSON.stringify(output).includes("EDITABLE-SECRET"))
                assert.equal(childReads, before + 1)
                const ref = JSON.stringify(output).match(/frame\.[a-f0-9-]+:[a-f0-9]+/)?.[0]
                assert(ref, "read-only child element descriptions have separate refs")
                assert(
                  !(await write({ op: "click", tabID: tab.id, ref })).ok,
                  "child ref cannot dispatch through top driver",
                )
                assert.equal(childReads, before + 1)
              } else {
                await assert.rejects(promise)
                assert.equal(
                  childReads,
                  before + (change === "policy-result" ? 1 : 0),
                  `${change}: no follow-on snapshot dispatch`,
                )
              }
              assert.equal(prompts, 0, "whole-tab grant needs no frame approval")
              assert.deepEqual(input, [], "frame reads never dispatch native input")
              console.log("PASS approved frame", cross ? "OOPIF" : "same", change)
            }
          }
          await contents.loadURL(url)
          await loaded()
          await contents.executeJavaScript(
            `document.querySelector("iframe").src=${JSON.stringify(url.replace("127.0.0.1", "localhost") + "child")};void 0`,
          )
          await loaded()
          receiverAllowed = true
          for (const denyPost of [false, "aba", true]) {
            const deliveryInventory = await route({ op: "read_state", tabID: tab.id })
            assert(deliveryInventory.ok && deliveryInventory.result.frames?.length === 1)
            const deliveryRef = deliveryInventory.result.frames[0].frameRef
            const prepared = await route({ op: "prepare_frame", tabID: tab.id, frameRef: deliveryRef })
            assert(prepared.ok && prepared.result.frameContext)
            const posted = Promise.withResolvers<BrowserIpcResult>()
            const emitter = new EventEmitter()
            const child = Object.assign(emitter, {
              postMessage: (message: BrowserIpcResult) => posted.resolve(message),
            })
            let replies = 0
            const stop = attachBrowserBridge(child, async (message, _allowed, control) => {
              const response = await routeBrowserRequest(
                message,
                (destination) =>
                  new URL(destination).origin === new URL(url).origin ||
                  (receiverAllowed &&
                    new URL(destination).origin === new URL(url.replace("127.0.0.1", "localhost")).origin),
                control,
              )
              assert(
                response.ok && response.result.visibleText.includes("CHILD-READ"),
                "native snapshot completed before post seam",
              )
              if (denyPost === "aba") await revokeReceiver()
              if (denyPost === true) receiverAllowed = false
              replies++
              return response
            })
            const timer = globalThis.setTimeout(() => posted.reject(new Error("bounded frame IPC delivery")), 3000)
            try {
              emitter.emit("message", {
                type: "browser_request",
                id: "frame-delivery",
                sessionID: tab.sessionID,
                request: {
                  op: "read_state",
                  tabID: tab.id,
                  frameRef: deliveryRef,
                  frameContext: prepared.result.frameContext,
                },
              })
              const response = await posted.promise
              assert.equal(response.response.ok, !denyPost)
              assert.equal(JSON.stringify(response).includes("CHILD-READ"), !denyPost)
              assert.equal(replies, 1)
            } finally {
              globalThis.clearTimeout(timer)
              stop()
            }
          }
          console.log("PASS native frame IPC delivery and receiver-policy revocation")
          receiverAllowed = false
          const blocked = await route({ op: "read_state", tabID: tab.id })
          assert(blocked.ok)
          assert.deepEqual(blocked.result.frames, [])
          assert(!JSON.stringify(blocked).includes("localhost"))
          console.log("PASS denied receiver metadata")
          continue
        }
        if (kind === "selects") {
          await guardUploads(win, tab, contents)
          const loaded = async () => {
            for (let i = 0; contents.isLoading() && i < 200; i++) await setTimeout(10)
            assert(!contents.isLoading(), "bounded select fixture load")
          }
          for (const cross of [false, true]) {
            for (const change of [
              "allow",
              "wrong-frame",
              "wrong-tab",
              "wrong-token",
              "read-token",
              "select-token-read",
              "wrong-option",
              "stale",
              "replace",
              "navigate",
              "aba",
              "revoke",
              "hidden",
              "covered",
              "transform",
              "border-held",
              "clip-held",
              "clip-ancestor-held",
              ...containment,
              "policy-approval",
              "policy-dispatch",
              "policy-result",
              "sandbox",
              "document",
              "select-replace",
              "option-replace",
              "disabled",
              "multiple",
              "reparent",
              "read-prepare",
              "policy-post",
              "expired",
            ]) {
              if (!cross && change.startsWith("policy-")) continue
              tab.agentAccess = true
              receiverAllowed = true
              await contents.loadURL(url)
              await loaded()
              const destination = (cross ? url.replace("127.0.0.1", "localhost") : url) + "child"
              await contents.executeJavaScript(`(() => {
                const first = document.querySelector("iframe");
                first.style.cssText = "left:10px;top:100px;width:240px;height:220px";
                first.src = ${JSON.stringify(destination)};
                const second = first.cloneNode();
                second.style.left = "300px";
                document.body.append(second);
              })()`)
              await loaded()
              const children = contents.mainFrame.frames
              assert.equal(children.length, 2)
              for (const child of children) {
                if (cross) assert.notEqual(child.processId, contents.mainFrame.processId, "proven select OOPIF")
                await child.executeJavaScript(`(() => {
                  const select = document.createElement("select");
                  select.id = "choice";
                  select.innerHTML = '<option>First</option><option>Second</option>';
                  document.body.prepend(select);
                  window.selectionEvents = [];
                  for (const type of ["input", "change"])
                    select.addEventListener(type, event => selectionEvents.push([type,event.isTrusted]));
                })()`)
              }
              if (change.startsWith("contain-")) await clipOwner(change, true)
              const inventory = await route({ op: "read_state", tabID: tab.id })
              assert(inventory.ok && inventory.result.frames?.length === 2, JSON.stringify(inventory))
              const [frame, sibling] = inventory.result.frames
              assert.notEqual(frame.frameRef, sibling.frameRef)
              assert.equal(frame.origin, sibling.origin, "identical URL siblings remain independent")
              let observed: import("@cookiemonster/cm-browser/protocol").BrowserState | undefined
              let readBinding: import("@cookiemonster/cm-browser/protocol").FrameContext | undefined
              let selectionRequest: Request | undefined
              const abort = new AbortController()
              let prompts = 0
              const context: ToolContext = {
                sessionID: tab.sessionID,
                messageID: "frame-select",
                agent: "build",
                directory: ".",
                worktree: ".",
                abort: abort.signal,
                metadata: () => {},
                ask: async () => {
                  prompts++
                  throw new Error("Whole-tab access must not ask for per-frame approval")
                },
              }
              const tools = browserTools({
                send: async (_session, request) => {
                  if (request.op === "select_option" && "frameRef" in request) {
                    selectionRequest = request
                    if (change === "policy-post") {
                      const posted = Promise.withResolvers<BrowserIpcResult>()
                      const emitter = new EventEmitter()
                      const child = Object.assign(emitter, {
                        postMessage: (message: BrowserIpcResult) => posted.resolve(message),
                      })
                      const stop = attachBrowserBridge(child, async (message, _allowed, control) => {
                        const response = await routeBrowserRequest(message, undefined, control)
                        assert(response.ok && mutations === 1, "selection completed before bridge post")
                        await revokeReceiver()
                        return response
                      })
                      const timer = globalThis.setTimeout(
                        () => posted.reject(new Error("bounded selection post")),
                        3000,
                      )
                      try {
                        emitter.emit("message", {
                          type: "browser_request",
                          id: "select-post",
                          sessionID: tab.sessionID,
                          request,
                        })
                        const response = await posted.promise
                        assert(!response.response.ok, "stale selection acknowledgement must not be posted")
                        return response.response
                      } finally {
                        globalThis.clearTimeout(timer)
                        stop()
                      }
                    }
                    if (change === "wrong-token")
                      request = {
                        ...request,
                        frameSelectContext: { ...request.frameSelectContext, approval: "a".repeat(36) },
                      }
                    if (change === "read-token")
                      request = {
                        ...request,
                        frameSelectContext: { ...request.frameSelectContext, approval: readBinding!.approval },
                      }
                    if (change === "select-token-read") {
                      const { op: _op, ref: _ref, optionRef: _optionRef, ...frameContext } = request.frameSelectContext
                      return route({ op: "read_state", tabID: tab.id, frameRef: frame.frameRef, frameContext })
                    }
                    if (change === "expired")
                      return routeBrowserRequest(
                        { type: "browser_request", id: "expired-select", sessionID: tab.sessionID, request },
                        () => true,
                        { deadline: Date.now() - 1 },
                      )
                  }
                  const response = await route(request)
                  if (response.ok && request.op === "read_state") observed = response.result
                  if (response.ok && request.op === "prepare_frame") readBinding = response.result.frameContext
                  return response
                },
              })
              await tools.browser_read_state.execute({ tabID: tab.id, frameRef: frame.frameRef }, context)
              const page = observed!
              const select = page.elements.find((element) => element.tag === "select")
              assert(select?.options?.length === 2, "frame read exposes bounded option refs")
              const args = {
                tabID: tab.id,
                frameRef: frame.frameRef,
                ref: select.ref,
                optionRef: select.options[1].ref,
              }
              mutations = 0
              if (change === "stale") await route({ op: "read_state", tabID: tab.id })
              if (change.startsWith("border-") || change.startsWith("clip-") || change.startsWith("contain-"))
                await clipOwner(change)
              if (change === "policy-approval") await revokeReceiver()
              if (change === "policy-dispatch")
                holdTree = async () => {
                  holdTree = undefined
                  await revokeReceiver()
                }
              if (change === "policy-result")
                holdResult = async () => {
                  holdResult = undefined
                  await revokeReceiver()
                }
              if (change === "revoke") {
                tab.accessRevision = (tab.accessRevision ?? 0) + 1
                tab.agentAccess = false
                tab.agentAccess = true
              }
              if (change === "replace")
                await contents.executeJavaScript(
                  'const el=document.querySelector("iframe");el.replaceWith(el.cloneNode());void 0',
                )
              if (change === "hidden")
                await contents.executeJavaScript('document.querySelector("iframe").style.display="none";void 0')
              if (change === "covered")
                await contents.executeJavaScript(
                  'const el=document.createElement("div");el.style.cssText="position:fixed;inset:0;z-index:999";document.body.append(el);void 0',
                )
              if (change === "transform")
                await contents.executeJavaScript('document.querySelector("iframe").style.transform="scale(.9)";void 0')
              if (change === "sandbox")
                await contents.executeJavaScript(
                  'document.querySelector("iframe").setAttribute("sandbox","allow-scripts allow-same-origin");void 0',
                )
              if (change === "document")
                await children[0].executeJavaScript(
                  'document.open();document.write("<p>REPLACED</p>");document.close();void 0',
                )
              if (change === "select-replace")
                await children[0].executeJavaScript(
                  'const el=document.querySelector("select");el.replaceWith(el.cloneNode(true));void 0',
                )
              if (change === "option-replace")
                await children[0].executeJavaScript(
                  'const el=document.querySelectorAll("option")[1];el.replaceWith(el.cloneNode(true));void 0',
                )
              if (change === "disabled")
                await children[0].executeJavaScript('document.querySelector("select").disabled=true;void 0')
              if (change === "multiple")
                await children[0].executeJavaScript('document.querySelector("select").multiple=true;void 0')
              if (change === "reparent")
                await children[0].executeJavaScript(
                  'const el=document.querySelector("select");const wrap=document.createElement("div");el.replaceWith(wrap);wrap.append(el);void 0',
                )
              if (change === "navigate" || change === "aba") {
                await contents.executeJavaScript(
                  `document.querySelector("iframe").src=${JSON.stringify(destination + "?changed")};void 0`,
                )
                await loaded()
                if (change === "aba") {
                  await contents.executeJavaScript(
                    `document.querySelector("iframe").src=${JSON.stringify(destination)};void 0`,
                  )
                  await loaded()
                }
              }
              if (change === "read-prepare") {
                const prepared = await route({ op: "prepare_frame", tabID: tab.id, frameRef: frame.frameRef })
                assert(prepared.ok, "read preparation preserves the original selection snapshot")
              }
              await loaded()
              const promise = tools.browser_select_option.execute(
                {
                  ...args,
                  ...(change === "wrong-frame" ? { frameRef: sibling.frameRef } : {}),
                  ...(change === "wrong-tab" ? { tabID: "missing-tab" } : {}),
                  ...(change === "wrong-option" ? { optionRef: select.ref } : {}),
                },
                context,
              )
              const positive = change === "allow" || change === "read-prepare"
              if (positive) {
                await promise
                assert.equal(mutations, 1)
                assert(selectionRequest)
                assert(!(await route(selectionRequest)).ok, "selection consent is one-use")
                assert.equal(mutations, 1, "replay cannot mutate")
              } else {
                await assert.rejects(promise)
                assert.equal(
                  mutations,
                  ["policy-result", "policy-post"].includes(change) ? 1 : 0,
                  `${change}: already-dispatched effects cannot be recalled`,
                )
              }
              const witnesses = await Promise.all(
                contents.mainFrame.frames.map(
                  async (child) =>
                    (await child.executeJavaScript(
                      '({index:document.querySelector("select")?.selectedIndex, events:window.selectionEvents || []})',
                    )) as { index?: number; events: [string, boolean][] },
                ),
              )
              if (positive || ["policy-result", "policy-post"].includes(change)) {
                assert.deepEqual(witnesses.map((value) => value.index).sort(), [0, 1])
                assert.deepEqual(
                  witnesses.flatMap((value) => value.events),
                  [
                    ["input", false],
                    ["change", false],
                  ],
                )
                assert.equal(prompts, 0, "whole-tab grant needs no frame approval")
              } else
                assert(
                  witnesses.every((value) => value.events.length === 0),
                  "negative selection produces no DOM events",
                )
              assert.deepEqual(input, [], "frame selection never falls back to native top input")
              console.log("PASS frame selection", cross ? "OOPIF" : "same", change)
            }
          }
          continue
        }
        if (kind === "sessions") {
          await guardUploads(win, tab, contents)
          const frames = tab.frameSessions!
          const tree = (await frames.capture().tree()) as {
            frameTree: { frame: { id: string }; childFrames: { frame: { id: string; url: string } }[] }
          }
          assert.equal(tree.frameTree.childFrames.length, 1)
          assert.equal(tree.frameTree.childFrames[0].frame.url, url + "child")
          const original = frames.capture()
          await contents.executeJavaScript(
            `document.querySelector("iframe").src=${JSON.stringify(url.replace("127.0.0.1", "localhost") + "child")}; void 0`,
          )
          for (let i = 0; (!attached.length || contents.isLoading()) && i < 200; i++) await setTimeout(10)
          assert(attached.length && !contents.isLoading(), "real OOPIF attachment")
          assert.throws(original.check, /changed/)
          assert.notEqual(contents.mainFrame.frames[0].processId, contents.mainFrame.processId, "proven OOPIF")
          const child = frames.capture(attached[0])
          const childTree = (await child.tree()) as { frameTree: { frame: { id: string; url: string } } }
          assert.equal(childTree.frameTree.frame.url, url.replace("127.0.0.1", "localhost") + "child")
          assert.notEqual(childTree.frameTree.frame.id, tree.frameTree.frame.id)
          assert.equal(commands.at(-1)?.sessionID, attached[0], "CDP session preserved")
          await contents.executeJavaScript('document.body.append(document.querySelector("iframe").cloneNode()); void 0')
          for (let i = 0; (attached.length < 2 || contents.isLoading()) && i < 200; i++) await setTimeout(10)
          assert.equal(attached.length, 2, "identical-URL sibling has independent CDP session")
          const siblingTree = (await frames.capture(attached[1]).tree()) as typeof childTree
          assert.equal(siblingTree.frameTree.frame.url, childTree.frameTree.frame.url)
          assert.notEqual(siblingTree.frameTree.frame.id, childTree.frameTree.frame.id)
          assert.throws(child.check, /changed/)
          const current = frames.capture(attached[0])
          const entered = Promise.withResolvers<void>()
          const release = Promise.withResolvers<void>()
          holdTree = async () => {
            entered.resolve()
            await release.promise
          }
          const pending = current.tree()
          try {
            await entered.promise
            await contents.executeJavaScript('document.querySelector("iframe").remove(); void 0')
          } finally {
            holdTree = undefined
            release.resolve()
          }
          await assert.rejects(pending, /changed/)
          assert.throws(() => frames.capture(attached[0]), /unavailable/)
          const retained = frames.capture(attached[1])
          const before = commands.length
          frames.message("Runtime.executionContextsCleared")
          assert.throws(retained.check, /changed/)
          await assert.rejects(retained.tree(), /changed/)
          assert.equal(commands.length, before, "stale generation sends no command")
          assert.equal(commands.filter((entry) => entry.method === "Runtime.evaluate").length, 0)
          assert.deepEqual(input, [])
          console.log(
            "PASS sessions: same-origin tree, proven OOPIF, identical-URL siblings, held detach, context epoch, zero evaluation/input",
          )
          continue
        }
        if (kind.startsWith("editor-")) {
          const text = kind === "editor-shadow" ? "shadow editor" : "wrap ".repeat(40).trimEnd()
          await contents.executeJavaScript(`(() => {
            document.querySelector("iframe").remove();
            const editor = document.createElement(${JSON.stringify(kind === "editor-textarea" ? "textarea" : "div")});
            editor.setAttribute("aria-label", "Editor");
            if (editor.localName !== "textarea") editor.contentEditable = "true";
            editor.style.cssText = "display:block;width:60px;min-height:32px;font:20px/32px monospace;overflow-wrap:anywhere";
            if (${JSON.stringify(kind)} === "editor-shadow") {
              const host = document.createElement("div");
              document.getElementById("original").replaceWith(host);
              host.attachShadow({mode:"open"}).append(editor);
            } else document.getElementById("original").replaceWith(editor);
            window.fixtureEditor = editor;
            window.editorEvents = [];
            for (const type of ["keydown", "keyup", "input"])
              editor.addEventListener(type, event => editorEvents.push([type, event.isTrusted]));
          })()`)
          const snapshot = await route({ op: "read_state", tabID: tab.id })
          assert(snapshot.ok)
          const ref = snapshot.result.elements.find((element) => element.label === "Editor")?.ref
          assert(ref)
          if (kind === "editor-covered") {
            await contents.executeJavaScript(`(() => {
              fixtureEditor.focus();
              const cover = document.createElement("div");
              cover.style.cssText = "position:fixed;inset:0;z-index:999";
              document.body.append(cover);
            })()`)
            assert(!(await write({ op: "fill", tabID: tab.id, ref, text })).ok)
            assert.deepEqual(input, [], "focused but covered editor still fails pointer preflight")
            assert.equal(browserInputFailure(contents), undefined)
            console.log("PASS", kind)
            continue
          }
          const response = await write({ op: "fill", tabID: tab.id, ref, text })
          const witness = await contents.executeJavaScript(`(() => {
            const el = window.fixtureEditor, rect = el.getBoundingClientRect();
            return {
              exact: (el.localName === "textarea" ? el.value : el.textContent) === ${JSON.stringify(text)},
              focused: el.getRootNode().activeElement === el,
              connected: el.isConnected,
              scroll: scrollY,
              centerOffscreen: rect.y + rect.height / 2 < 0 || rect.y + rect.height / 2 > innerHeight,
              trusted: editorEvents.length > 0 && editorEvents.every(event => event[1]),
              downs: editorEvents.filter(event => event[0] === "keydown").length,
              ups: editorEvents.filter(event => event[0] === "keyup").length,
            };
          })()`)
          console.log(
            "OBSERVE",
            kind,
            JSON.stringify({ ok: response.ok, held: Boolean(browserInputFailure(contents)), ...witness }),
          )
          assert(response.ok, `${kind}: native fill must complete after caret scrolling`)
          assert(witness.exact && witness.focused && witness.connected && witness.trusted, kind)
          assert.equal(witness.downs, witness.ups, `${kind}: complete key pairs`)
          assert.equal(browserInputFailure(contents), undefined, `${kind}: no quarantine`)
          if (kind === "editor-wrap")
            assert(witness.scroll > 0 && witness.centerOffscreen, "native caret scroll moved center offscreen")
          console.log("PASS", kind)
          continue
        }
        if (kind.endsWith("cross")) {
          await contents.executeJavaScript(
            `document.querySelector("iframe").src=${JSON.stringify(url.replace("127.0.0.1", "localhost") + "child")}; void 0`,
          )
          for (let i = 0; i < 100 && !contents.mainFrame.frames.some((frame) => frame.url.includes("localhost")); i++)
            await setTimeout(10)
        }
        const child = contents.mainFrame.frames[0]
        assert(child)
        assert.equal(new URL(child.url).hostname, kind.endsWith("cross") ? "localhost" : "127.0.0.1")
        // Fixture-only child inspection witnesses native effects; production must never read this document.
        await child.executeJavaScript("document.readyState")
        const snapshot = await route({ op: "read_state", tabID: tab.id })
        assert(snapshot.ok)
        const ref = snapshot.result.elements.find((element) => element.label === "Original")?.ref
        assert(ref)
        if (kind.startsWith("key")) {
          await child.executeJavaScript('document.querySelector("input").focus()')
          assert.equal(contents.focusedFrame, child)
        } else {
          await contents.executeJavaScript('document.getElementById("original").focus()')
          assert.equal(contents.focusedFrame, contents.mainFrame)
        }
        if (kind === "fill-click" || kind === "fill-down" || kind === "fill-replace") {
          await contents.executeJavaScript(`(() => {
            const el=document.getElementById("original");
            el.addEventListener(${JSON.stringify(kind === "fill-down" ? "keydown" : "click")}, () => {
              ${kind === "fill-replace" ? "const clone=el.cloneNode(true);el.replaceWith(clone);clone.focus();" : 'document.getElementById("other").focus();'}
            }, {once:true});
          })()`)
        }
        const response = await write(
          kind.startsWith("wheel")
            ? { op: "scroll", tabID: tab.id, deltaX: 0, deltaY: 120 }
            : kind.startsWith("fill") || kind === "normal"
              ? { op: "fill", tabID: tab.id, ref, text: "OK" }
              : { op: "press_key", tabID: tab.id, modifiers: [], key: kind === "tab-child" ? "Tab" : "x" },
        )
        await setTimeout(50)
        const childEvents = await child.executeJavaScript("events")
        if (kind === "normal") {
          assert(response.ok)
          assert.equal(await contents.executeJavaScript('document.getElementById("original").value'), "OK")
          assert((await write({ op: "press_key", tabID: tab.id, modifiers: [], key: "x" })).ok)
          assert.equal(await contents.executeJavaScript('document.getElementById("original").value'), "OKx")
          assert.equal(await contents.executeJavaScript('events.some(e=>e[0]==="input" && e[1])'), true)
          await contents.executeJavaScript('document.querySelector("iframe").remove()')
          assert((await write({ op: "scroll", tabID: tab.id, deltaX: 0, deltaY: 120 })).ok)
          assert.equal(await contents.executeJavaScript('events.some(e=>e[0]==="wheel" && e[1])'), true)
        } else {
          const keys = input.filter((event) => event.type === "keyDown" || event.type === "keyUp")
          const held = kind === "fill-down" || kind === "tab-child"
          console.log(
            "OBSERVE",
            kind,
            JSON.stringify({ ok: response.ok, input: input.map((event) => event.type), childEvents }),
          )
          assert(!response.ok, `${kind}: unsupported target must reject`)
          if (kind.startsWith("wheel") || kind.startsWith("key")) assert.deepEqual(input, [])
          if (kind === "tab-child") assert.equal(contents.focusedFrame, child)
          assert.deepEqual(childEvents, [], `${kind}: no child input`)
          assert.equal(keys.length, held ? 1 : 0, `${kind}: no unsafe release or typing`)
          assert.equal(Boolean(browserInputFailure(contents)), held, `${kind}: only interrupted down quarantines`)
          assert.equal(await contents.executeJavaScript('document.getElementById("other").value'), "other")
          if (held) {
            const count = input.length
            assert(!(await route({ op: "read_state", tabID: tab.id })).ok)
            assert.equal(input.length, count, "no recovery input")
          }
        }
        console.log("PASS", kind)
      } catch (error) {
        failures.push(`${kind}: ${String(error)}`)
        console.log("FAIL", kind, String(error))
      } finally {
        remove()
        contents.close({ waitForBeforeUnload: false })
        win.contentView.removeChildView(view)
      }
    }
    assert.deepEqual(failures, [])
    console.log(`PASS frames prerequisite Electron ${process.versions.electron} Chromium ${process.versions.chrome}`)
  } finally {
    win.destroy()
    server.closeAllConnections()
    await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())))
  }
}
