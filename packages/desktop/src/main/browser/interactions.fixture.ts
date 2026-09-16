import assert from "node:assert/strict"
import { once } from "node:events"
import { createServer } from "node:http"
import { setTimeout } from "node:timers/promises"
import { BrowserWindow, WebContentsView } from "electron"
import contextMenu from "electron-context-menu"
import type { Request, WriteRequest } from "@cookiemonster/cm-browser/protocol"
import { registerBrowserTab, type BrowserRegistration } from "./registry"
import { routeBrowserRequest, type BrowserOperation } from "./router"
import { browserInputFailure, shouldShowBrowserContextMenu } from "./driver"

const html = `<!doctype html><title>Interactions fixture</title>
<style>
button { position:absolute; top:20px; width:110px; height:50px }
#hover { left:20px } #stable { left:150px } #replace { left:280px } #right { left:410px }
#hoverMenu, #domMenu { display:none; position:absolute; top:100px }
</style>
<button id="hover">Hover</button><button id="stable">Stable</button>
<button id="replace">Replace</button><button id="right">Right</button>
<div id="hoverMenu">Hover DOM menu</div><div id="domMenu">Context DOM menu</div>
<script>
window.events = [];
for (const type of ["mousemove", "mousedown", "mouseup", "click", "dblclick", "contextmenu"])
  document.addEventListener(type, e => events.push({type, id:e.target.id, trusted:e.isTrusted, detail:e.detail}));
document.getElementById("hover").addEventListener("mouseenter", () => document.getElementById("hoverMenu").style.display="block");
document.getElementById("replace").addEventListener("click", e => e.currentTarget.replaceWith(e.currentTarget.cloneNode(true)));
document.getElementById("right").addEventListener("contextmenu", () => document.getElementById("domMenu").style.display="block");
</script>`

export async function interactionsSmoke() {
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
  const view = new WebContentsView({
    webPreferences: {
      partition: "interactions-fixture",
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false,
    },
  })
  win.contentView.addChildView(view)
  view.setBounds({ x: 0, y: 0, width: 600, height: 400 })
  win.showInactive()
  const contents = view.webContents
  const tab: BrowserRegistration = {
    id: `interactions-${contents.id}`,
    ownerID: win.id,
    sessionID: "interactions",
    contents,
    revision: 0,
    agentAccess: true,
  }
  contents.on("did-start-navigation", (_event, _url, _sameDocument, main) => {
    if (main) tab.revision++
  })
  contents.on("did-navigate-in-page", (_event, _url, main) => {
    if (main) tab.revision++
  })
  contents.on("dom-ready", () => {
    tab.revision++
  })
  const remove = registerBrowserTab(tab)
  const menuDecisions: boolean[] = []
  let popups = 0
  const disposeMenu = contextMenu({
    window: contents,
    showSearchWithGoogle: false,
    showLookUpSelection: false,
    showSaveImageAs: true,
    shouldShowMenu: () => {
      const show = shouldShowBrowserContextMenu(contents)
      menuDecisions.push(show)
      return show
    },
    onShow: () => {
      popups++
    },
  })
  const input: Record<string, unknown>[] = []
  const send = contents.debugger.sendCommand.bind(contents.debugger)
  contents.debugger.sendCommand = async (method, params) => {
    if (method.startsWith("Input.")) input.push(params)
    return send(method, params)
  }
  const route = (request: Request, control: BrowserOperation = {}) =>
    routeBrowserRequest(
      { type: "browser_request", id: "fixture", sessionID: tab.sessionID, request },
      (destination) => new URL(destination).origin === new URL(url).origin,
      control,
    )
  const write = async (request: WriteRequest) => {
    const prepared = await route({ op: "prepare_write", request })
    assert(prepared.ok && prepared.result.context)
    return route({ ...request, context: prepared.result.context })
  }
  const ref = async (text: string) => {
    const response = await route({ op: "read_state", tabID: tab.id })
    assert(response.ok)
    const ref = response.result.elements.find((element) => (element.label || element.text) === text)?.ref
    assert(ref)
    return ref
  }
  const load = async () => {
    await contents.loadURL(url)
    while (contents.isLoadingMainFrame()) await setTimeout(10)
    contents.sendInputEvent({ type: "mouseMove", x: 580, y: 300 })
    await setTimeout(30)
    input.length = 0
  }
  try {
    await dragSmoke(win, url)
    await load()
    const hovered = await write({ op: "hover", tabID: tab.id, ref: await ref("Hover") })
    assert(hovered.ok && hovered.result.visibleText.includes("Hover DOM menu"))
    assert.deepEqual(
      input.map((event) => event.type),
      ["mouseMoved"],
    )
    assert.equal(await contents.executeJavaScript("events.some(e => e.type==='mousemove' && e.trusted)"), true)

    await load()
    const stable = await write({ op: "click", tabID: tab.id, ref: await ref("Stable"), mode: "double" })
    assert(stable.ok)
    assert.equal(
      await contents.executeJavaScript(
        "events.some(e => e.type==='dblclick' && e.id==='stable' && e.trusted && e.detail===2)",
      ),
      true,
    )
    assert.deepEqual(
      input.filter((event) => event.type === "mousePressed").map((event) => event.clickCount),
      [1, 2],
    )

    await load()
    const replacement = await write({ op: "click", tabID: tab.id, ref: await ref("Replace"), mode: "double" })
    assert(!replacement.ok && replacement.code === "stale_ref")
    assert.deepEqual(
      input.map((event) => event.type),
      ["mouseMoved", "mousePressed", "mouseReleased"],
    )
    assert.equal(
      await contents.executeJavaScript("events.filter(e => e.type==='click' && e.id==='replace' && e.trusted).length"),
      1,
    )
    assert.equal(await contents.executeJavaScript("events.some(e => e.type==='dblclick')"), false)

    for (const mutation of ["replace", "type", "move", "stable-fill"] as const) {
      await load()
      await contents.executeJavaScript(`(() => {
        const mode = ${JSON.stringify(mutation)};
        let el = document.getElementById("stable");
        if (mode === "type" || mode === "stable-fill") {
          const input = document.createElement("input");
          input.id = "stable"; input.type = "text"; input.setAttribute("aria-label", "Stable");
          input.style.cssText = "position:absolute;left:150px;top:20px;width:110px;height:50px;box-sizing:border-box";
          el.replaceWith(input); el = input;
        }
        window.mutationObserved = false;
        el.addEventListener("mouseenter", event => {
          window.mutationObserved = event.isTrusted;
          if (mode === "replace") el.replaceWith(el.cloneNode(true));
          if (mode === "type") el.type = "submit";
          if (mode === "move") el.style.left = "160px";
        }, { once: true });
      })()`)
      const original = await ref("Stable")
      const response = await write(
        mutation === "type" || mutation === "stable-fill"
          ? { op: "fill", tabID: tab.id, ref: original, text: "filled" }
          : { op: "click", tabID: tab.id, ref: original },
      )
      assert.equal(await contents.executeJavaScript("window.mutationObserved"), true, mutation)
      if (mutation === "stable-fill") {
        assert(response.ok)
        assert.equal(await contents.executeJavaScript("document.getElementById('stable').value"), "filled")
      } else {
        assert(!response.ok && response.code === "stale_ref", mutation)
        assert.deepEqual(
          input.map((event) => event.type),
          ["mouseMoved"],
          mutation + ": no press or keys",
        )
      }
    }
    console.log(
      "PASS post-move identical replacement, text-to-submit and moved center reject before press; stable fill works",
    )

    await load()
    const right = await write({ op: "click", tabID: tab.id, ref: await ref("Right"), mode: "right" })
    assert(right.ok && right.result.visibleText.includes("Context DOM menu"))
    assert.equal(
      await contents.executeJavaScript("events.some(e => e.type==='contextmenu' && e.id==='right' && e.trusted)"),
      true,
    )
    assert.deepEqual(menuDecisions, [false], "production hook witnessed the real Electron context-menu event")
    assert.equal(popups, 0, "agent event never opens an app-native menu")
    assert.deepEqual(
      input.filter((event) => event.type !== "mouseMoved").map((event) => [event.button, event.buttons]),
      [
        ["right", 2],
        ["right", 0],
      ],
    )

    // Native select metadata is available while collapsed; fixtures inspect values only as booleans.
    const selectState = async () => {
      const response = await route({ op: "read_state", tabID: tab.id })
      assert(response.ok)
      const select = response.result.elements.find((el) => el.tag === "select" && el.label === "Choice")
      const other = response.result.elements.find((el) => el.tag === "select" && el.label === "Other")
      assert(select?.options?.length === 4 && other?.options?.length === 2)
      assert(!response.result.elements.some((el) => el.tag === "option"))
      assert(!JSON.stringify(response).includes("private-value"))
      return { select, other }
    }
    const selectLoad = async () => {
      await load()
      await contents.executeJavaScript(`(() => {
        const container = document.createElement("div");
        container.style.cssText = "position:absolute;top:170px;left:20px";
        container.innerHTML = '<select aria-label="Choice" id="choice"><option value="private-value-1">Same</option><option value="private-value-2">Same</option><optgroup label="Disabled" disabled><option>Group</option></optgroup><option disabled>Disabled</option></select><select aria-label="Other" id="otherChoice"><option>One</option><option>Two</option></select>';
        document.body.append(container);
        window.selectEvents = [];
        for (const type of ["input", "change"]) document.addEventListener(type, event => {
          if (event.target instanceof HTMLSelectElement) selectEvents.push([type, event.isTrusted]);
        });
      })()`)
      return selectState()
    }
    const choose = (select: Awaited<ReturnType<typeof selectState>>["select"], optionRef = select.options![1].ref) =>
      write({ op: "select_option", tabID: tab.id, ref: select.ref, optionRef })
    let choices = await selectLoad()
    assert.notEqual(choices.select.options![0].ref, choices.select.options![1].ref)
    assert((await choose(choices.select)).ok)
    assert.equal(
      await contents.executeJavaScript("choice.options[1].selected && choice.value === 'private-value-2'"),
      true,
    )
    assert.deepEqual(await contents.executeJavaScript("selectEvents"), [
      ["input", false],
      ["change", false],
    ])
    choices = await selectState()
    assert.equal(choices.select.options![1].selected, true)
    assert((await choose(choices.select)).ok)
    assert.deepEqual(await contents.executeJavaScript("selectEvents"), [
      ["input", false],
      ["change", false],
    ])
    assert.equal(input.length, 0, "selection emits no pointer/keyboard input")

    for (const kind of [
      "group",
      "option",
      "disabled",
      "multiple",
      "owner",
      "snapshot",
      "tab",
      "replace",
      "move",
      "cover",
      "generic",
    ] as const) {
      choices = await selectLoad()
      let optionRef = choices.select.options![1].ref
      if (kind === "group") optionRef = choices.select.options![2].ref
      if (kind === "option") optionRef = choices.select.options![3].ref
      if (kind === "owner") optionRef = choices.other.options![1].ref
      if (kind === "snapshot") optionRef = (await selectState()).select.options![1].ref
      if (kind === "tab") optionRef = "another-tab." + optionRef
      await contents.executeJavaScript(`(() => {
        const kind = ${JSON.stringify(kind)};
        if (kind === "disabled") choice.disabled = true;
        if (kind === "multiple") choice.multiple = true;
        if (kind === "replace") choice.options[1].replaceWith(choice.options[1].cloneNode(true));
        if (kind === "move") { const group = document.createElement("optgroup"); choice.append(group); group.append(choice.options[1]); }
        if (kind === "cover") { const cover = document.createElement("div"); cover.style.cssText = "position:fixed;inset:0;z-index:999"; document.body.append(cover); }
      })()`)
      if (kind === "generic") {
        for (const request of [
          { op: "click", tabID: tab.id, ref: optionRef },
          { op: "hover", tabID: tab.id, ref: optionRef },
          { op: "fill", tabID: tab.id, ref: optionRef, text: "never" },
          { op: "scroll", tabID: tab.id, ref: optionRef, deltaX: 0, deltaY: 1 },
        ] as const)
          assert(!(await write(request)).ok)
      } else assert(!(await choose(choices.select, optionRef)).ok, kind)
      assert.equal(await contents.executeJavaScript("choice.value === 'private-value-1'"), true, kind)
      assert.deepEqual(await contents.executeJavaScript("selectEvents"), [], kind)
      assert.deepEqual(input, [], kind)
    }
    for (const reason of ["stale", "cancel", "revoke", "ack-cancel", "ack-fail"] as const) {
      choices = await selectLoad()
      const request = {
        op: "select_option",
        tabID: tab.id,
        ref: choices.select.ref,
        optionRef: choices.select.options![1].ref,
      } as const
      const prepared = await route({ op: "prepare_write", request })
      assert(prepared.ok && prepared.result.context)
      if (reason === "stale") {
        tab.accessRevision = (tab.accessRevision ?? 0) + 1
        assert(!(await route({ ...request, context: prepared.result.context })).ok)
        assert.equal(await contents.executeJavaScript("choice.value === 'private-value-1'"), true)
        continue
      }
      const controller = new AbortController()
      const entered = Promise.withResolvers<void>(),
        held = Promise.withResolvers<void>(),
        settled = Promise.withResolvers<void>()
      const dispatch = contents.debugger.sendCommand.bind(contents.debugger)
      let commands = 0
      contents.debugger.sendCommand = async (method, params) => {
        commands++
        const result = await dispatch(method, params)
        if (
          ((reason === "cancel" || reason === "revoke") && method === "Page.createIsolatedWorld") ||
          (reason !== "cancel" && reason !== "revoke" && String(params?.expression).includes("const validated ="))
        ) {
          entered.resolve()
          await held.promise
          if (reason === "ack-fail") throw new Error("Fixture selection acknowledgement failed")
        }
        return result
      }
      const pending = route(
        { ...request, context: prepared.result.context },
        {
          signal: controller.signal,
          onSettled: (operation) => {
            void operation.finally(() => settled.resolve())
          },
        },
      )
      try {
        await entered.promise
        const count = commands
        if (reason === "revoke") tab.accessRevision = (tab.accessRevision ?? 0) + 1
        else if (reason !== "ack-fail") {
          controller.abort()
          assert(!(await pending).ok)
        }
        assert(!(await route({ op: "read_state", tabID: tab.id })).ok, "busy until real settlement")
        held.resolve()
        assert(!(await pending).ok)
        await settled.promise
        assert.equal(commands, count, "no retry or follow-on snapshot")
        const changed = reason === "ack-cancel" || reason === "ack-fail"
        assert.equal(await contents.executeJavaScript("choice.options[1].selected"), changed)
        assert.deepEqual(
          await contents.executeJavaScript("selectEvents"),
          changed
            ? [
                ["input", false],
                ["change", false],
              ]
            : [],
        )
      } finally {
        held.resolve()
        controller.abort()
        await settled.promise
        contents.debugger.sendCommand = dispatch
      }
    }
    console.log(
      "PASS native select identity, untrusted changed-only events, disabled/multiple/owner/stale/replaced/moved rejection and held settlement",
    )
    await load()

    const other = new WebContentsView({
      webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false },
    })
    try {
      for (const reason of ["success", "cancel", "reject"] as const) {
        await load()
        const request = { op: "click", tabID: tab.id, ref: await ref("Right"), mode: "right" } as const
        const prepared = await route({ op: "prepare_write", request })
        assert(prepared.ok && prepared.result.context)
        const controller = new AbortController()
        const entered = Promise.withResolvers<void>()
        const held = Promise.withResolvers<void>()
        const settled = Promise.withResolvers<void>()
        const dispatch = contents.debugger.sendCommand.bind(contents.debugger)
        contents.debugger.sendCommand = async (method, params) => {
          const value = await dispatch(method, params)
          if (params?.type === "mouseReleased") {
            entered.resolve()
            await held.promise
            if (reason === "reject") throw new Error("Fixture native acknowledgement rejected")
          }
          return value
        }
        const agentMenu = once(contents, "context-menu", { signal: AbortSignal.timeout(2000) })
        const pending = route(
          { ...request, context: prepared.result.context },
          {
            signal: controller.signal,
            onSettled: (operation) => {
              void operation.finally(() => settled.resolve())
            },
          },
        )
        try {
          await entered.promise
          await agentMenu
          if (reason === "cancel") {
            controller.abort()
            const cancelled = await pending
            assert(!cancelled.ok && cancelled.code === "cancelled")
          }
          assert.equal(shouldShowBrowserContextMenu(contents), false)
          assert.equal(shouldShowBrowserContextMenu(other.webContents), true, "other tab remains unsuppressed")
          // Real native events at repeated and different coordinates while CDP acknowledgement is held.
          for (const x of [465, 465, 205]) {
            const count = menuDecisions.length
            const menu = once(contents, "context-menu", { signal: AbortSignal.timeout(2000) })
            contents.sendInputEvent({ type: "mouseDown", x, y: 45, button: "right", clickCount: 1 })
            contents.sendInputEvent({ type: "mouseUp", x, y: 45, button: "right", clickCount: 1 })
            const [, params] = await menu
            assert.equal(params.x, x, "native event coordinates witnessed")
            assert.equal(params.y, 45)
            assert.equal(menuDecisions.length, count + 1, "native menu query observed")
            assert.equal(menuDecisions.at(-1), false, reason)
            assert.equal(shouldShowBrowserContextMenu(contents), false, "query does not consume suppression")
          }
          assert.equal(popups, 0)
          held.resolve()
          const response = await pending
          await settled.promise
          assert(
            reason === "success"
              ? response.ok
              : !response.ok && response.code === (reason === "cancel" ? "cancelled" : "unavailable"),
          )
          assert.equal(shouldShowBrowserContextMenu(contents), true, "guard released after native settlement")
          assert.deepEqual(
            input.map((event) => event.type),
            ["mouseMoved", "mousePressed", "mouseReleased"],
          )
        } finally {
          held.resolve()
          controller.abort()
          await settled.promise
          contents.debugger.sendCommand = dispatch
        }
      }
    } finally {
      other.webContents.close({ waitForBeforeUnload: false })
    }
    console.log("PASS tab-scoped repeated native menu suppression through success/cancel/reject settlement")

    // Positive control: the same hook permits non-agent input after the operation.
    contents.sendInputEvent({ type: "mouseDown", x: 465, y: 45, button: "right", clickCount: 1 })
    contents.sendInputEvent({ type: "mouseUp", x: 465, y: 45, button: "right", clickCount: 1 })
    for (let i = 0; i < 100; i++) {
      if (popups > 0) break
      await setTimeout(20)
    }
    assert(menuDecisions.slice(0, -1).every((show) => !show))
    assert.equal(menuDecisions.at(-1), true)
    assert.equal(popups, 1, "real native menu remains available to non-agent input")
    console.log(
      `PASS interactions Chromium ${process.versions.chrome} Electron ${process.versions.electron}: hover DOM menu, trusted double, identical replacement zero second input, trusted right DOM handler, native suppression and non-agent popup`,
    )
  } finally {
    disposeMenu()
    remove()
    contents.close({ waitForBeforeUnload: false })
    win.destroy()
    await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())))
  }
}

async function dragSmoke(win: BrowserWindow, url: string) {
  for (const kind of [
    "accept",
    "reject",
    "same",
    "tab",
    "snapshot",
    "source-replace-pre",
    "target-replace-pre",
    "source-parent-pre",
    "source-replace-hover",
    "target-replace-hover",
    "target-move-hover",
    "target-replace-move",
    "target-parent-move",
    "target-move-move",
    "target-disabled-move",
    "target-cover-move",
    "revoke-held",
  ]) {
    const view = new WebContentsView({
      webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false },
    })
    win.contentView.addChildView(view)
    view.setBounds({ x: 0, y: 0, width: 600, height: 400 })
    const contents = view.webContents
    const tab: BrowserRegistration = {
      id: `drag-${contents.id}`,
      ownerID: win.id,
      sessionID: "drag-fixture",
      contents,
      revision: 0,
      agentAccess: true,
    }
    const remove = registerBrowserTab(tab)
    const input: Record<string, unknown>[] = []
    const send = contents.debugger.sendCommand.bind(contents.debugger)
    const entered = Promise.withResolvers<void>(),
      held = Promise.withResolvers<void>()
    let settlement: Promise<unknown> | undefined
    const route = (request: Request, control: BrowserOperation = {}) =>
      routeBrowserRequest(
        { type: "browser_request", id: kind, sessionID: tab.sessionID, request },
        (destination) => new URL(destination).origin === new URL(url).origin,
        control,
      )
    contents.debugger.sendCommand = async (method, params) => {
      if (method.startsWith("Input.")) input.push(params)
      const result = await send(method, params)
      if (kind === "revoke-held" && params?.type === "mouseMoved" && params.buttons === 1) {
        entered.resolve()
        await held.promise
      }
      return result
    }
    try {
      await contents.loadURL(url)
      while (contents.isLoadingMainFrame()) await setTimeout(10)
      await contents.executeJavaScript(`(() => {
        document.body.innerHTML = '<button id="source">Source</button><button id="target">Target</button><div id="plain">Plain drop div</div>';
        const source = document.getElementById("source"), target = document.getElementById("target");
        source.style.cssText = "left:20px;top:180px;width:100px;height:50px;touch-action:none";
        target.style.cssText = "left:400px;top:180px;width:100px;height:50px";
        const kind = ${JSON.stringify(kind)};
        window.dragWitness = { down:0, moves:0, up:0, accepted:false, trusted:true, mutation:false };
        let dragging = false;
        const mutate = () => {
          const el = kind.startsWith("source-") ? source : target;
          if (kind.includes("-replace-")) el.replaceWith(el.cloneNode(true));
          if (kind.includes("-parent-")) { const parent = document.createElement("div"); document.body.append(parent); parent.append(el); }
          if (kind.includes("-move-")) el.style.left = "410px";
          if (kind.includes("-disabled-")) el.disabled = true;
          if (kind.includes("-cover-")) { const cover = document.createElement("div"); cover.style.cssText = "position:fixed;inset:0;z-index:999"; document.body.append(cover); }
          dragWitness.mutation = true;
        };
        window.dragMutate = mutate;
        source.addEventListener("pointerenter", () => { if (kind.endsWith("-hover")) mutate(); }, { once:true });
        source.addEventListener("pointerdown", event => {
          dragging = true; dragWitness.down++; dragWitness.trusted &&= event.isTrusted;
          source.setPointerCapture(event.pointerId);
        });
        document.addEventListener("pointermove", event => {
          if (!dragging) return;
          dragWitness.moves++; dragWitness.trusted &&= event.isTrusted;
          if (kind.endsWith("-move") && dragWitness.moves === 1) mutate();
        });
        document.addEventListener("pointerup", event => {
          if (!dragging) return;
          dragWitness.up++; dragWitness.trusted &&= event.isTrusted;
          dragWitness.accepted = kind === "accept" && document.elementFromPoint(event.clientX, event.clientY) === target;
          dragging = false;
        });
      })()`)
      contents.sendInputEvent({ type: "mouseMove", x: 580, y: 300 })
      await setTimeout(30)
      const snapshot = await route({ op: "read_state", tabID: tab.id })
      assert(snapshot.ok)
      assert(
        !snapshot.result.elements.some((el) => el.text === "Plain drop div"),
        "noninteractive targets not discovered",
      )
      const sourceRef = snapshot.result.elements.find((el) => el.text === "Source")?.ref
      let targetRef = snapshot.result.elements.find((el) => el.text === "Target")?.ref
      assert(sourceRef && targetRef)
      if (kind === "same") targetRef = sourceRef
      if (kind === "tab") targetRef = "another." + targetRef
      if (kind === "snapshot") {
        const next = await route({ op: "read_state", tabID: tab.id })
        assert(next.ok)
        targetRef = next.result.elements.find((el) => el.text === "Target")!.ref
      }
      if (kind.endsWith("-pre")) await contents.executeJavaScript("dragMutate()")
      const request = { op: "drag", tabID: tab.id, sourceRef, targetRef } as const
      const prepared = await route({ op: "prepare_write", request })
      assert(prepared.ok && prepared.result.context)
      contents.backgroundThrottling = true
      const pending = route(
        { ...request, context: prepared.result.context },
        {
          onSettled: (operation) => {
            settlement = operation
          },
        },
      )
      if (kind === "revoke-held") {
        await entered.promise
        tab.accessRevision = (tab.accessRevision ?? 0) + 1
        assert(browserInputFailure(contents))
        assert.equal(contents.backgroundThrottling, false)
        assert(tab.navigationAllowed)
        const busy = await route({ op: "read_state", tabID: tab.id })
        assert(!busy.ok && busy.error.includes("Another operation"))
        held.resolve()
      }
      const response = await pending
      await settlement
      const completed = kind === "accept" || kind === "reject"
      assert.equal(response.ok, completed, kind + ": completion")
      if (!response.ok) assert.equal(response.code, kind === "revoke-held" ? "unavailable" : "stale_ref", kind)
      const witness = await contents.executeJavaScript("dragWitness")
      assert.equal(witness.trusted, true, kind)
      assert.equal(witness.accepted, kind === "accept", kind + ": site acceptance")
      const pressed = completed || kind.endsWith("-move") || kind === "revoke-held"
      assert.equal(witness.down, pressed ? 1 : 0, kind + ": native presses")
      assert.equal(witness.up, completed ? 1 : 0, kind + ": native releases")
      assert.equal(input.filter((event) => event.type === "mouseReleased").length, completed ? 1 : 0, kind)
      assert.equal(Boolean(browserInputFailure(contents)), pressed && !completed, kind + ": quarantine")
      if (!pressed) assert.equal(input.length, kind.endsWith("-hover") ? 1 : 0, kind + ": input boundary")
      if (completed) assert.equal(input.length, 7, kind + ": bounded gesture")
      if (kind.includes("-pre") || kind.includes("-hover") || kind.endsWith("-move")) assert(witness.mutation, kind)
      if (pressed && !completed) {
        const count = input.length
        const blocked = await route({ op: "read_state", tabID: tab.id })
        assert(!blocked.ok && blocked.error.includes("Close this tab"), kind)
        assert.equal(input.length, count, "no recovery input")
      }
      assert.equal(contents.backgroundThrottling, true)
      assert.equal(tab.navigationAllowed, undefined)
    } finally {
      held.resolve()
      await settlement
      remove()
      contents.close({ waitForBeforeUnload: false })
      win.contentView.removeChildView(view)
    }
  }
  console.log(
    "PASS drag trusted accepted/rejected pointer drops, joint pre-down identity, hover mutation, movement replacement/ancestry/center/disabled/overlay rejection, no release with quarantine, held revocation and cross-tab/snapshot zero input",
  )
}
