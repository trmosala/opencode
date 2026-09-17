import assert from "node:assert/strict"
import { EventEmitter, once } from "node:events"
import { createServer } from "node:http"
import { setTimeout } from "node:timers/promises"
import { BrowserWindow, dialog } from "electron"
import type { ToolContext } from "@opencode-ai/plugin"
import type { BrowserIpcResult, BrowserState, Request, Response, TabRequest } from "@cookiemonster/cm-browser/protocol"
import { browserTools } from "../../../../cm-browser/src/tools"
import { attachBrowserBridge } from "./bridge"
import { routeBrowserRequest } from "./router"
import { browserOperationBusy, setBrowserAgentEnabled } from "./registry"
import { browserCommand, browserLinkContext, browserViewport, registerBrowserOwner } from "./tabs"
import { savedTabs, saveTabs } from "./tab-recovery"
import { browserInputFailure } from "./driver"

const wait = async (check: () => boolean | Promise<boolean>) => {
  for (let i = 0; i < 150; i++) {
    if (await check()) return
    await setTimeout(20)
  }
  throw new Error("Tab lifecycle fixture condition timed out")
}

export async function tabLifecycleSmoke() {
  assert(process.env.CM_BROWSER_SMOKE_PROFILE, "Only run through the isolated smoke runner")
  const requests: string[] = []
  let recoveryResponse: "ok" | "empty" | "hold" | "disconnect" | "resource" = "ok"
  let releaseResource: (() => void) | undefined
  let releaseRecovery: (() => void) | undefined
  const server = createServer((request, response) => {
    requests.push(request.url ?? "/")
    if (request.url === "/permission-resource") {
      releaseResource = () => {
        releaseResource = undefined
        response.writeHead(204).end()
      }
      return
    }
    if (request.url === "/permission-recovery") {
      if (recoveryResponse === "resource") {
        response.writeHead(200, { "Content-Type": "text/html" })
        response.end(`<!doctype html><script>
          window.oldDocument = true;
          navigator.mediaDevices.getUserMedia({video:true,audio:true}).then(stream => window.stream = stream);
        </script><img src="/permission-resource">`)
        return
      }
      if (recoveryResponse === "empty") {
        response.writeHead(204).end()
        return
      }
      if (recoveryResponse === "hold") {
        releaseRecovery = () => {
          releaseRecovery = undefined
          response
            .writeHead(recoveryResponse === "empty" ? 204 : 200, { "Content-Type": "text/html" })
            .end("<!doctype html><title>Replacement</title>")
        }
        return
      }
      if (recoveryResponse === "disconnect") {
        response.destroy()
        return
      }
    }
    response.writeHead(200, { "Content-Type": "text/html" })
    response.end(`<!doctype html><title>PRIVATE-LIFECYCLE-TITLE</title>
      <button style="position:absolute;left:10px;top:10px;width:180px;height:80px"
        onclick="window.trusted=event.isTrusted;window.onbeforeunload=e=>{window.unloads=(window.unloads||0)+1;e.preventDefault();e.returnValue='stay'}">Arm unload</button>`)
  })
  server.listen(0, "127.0.0.1")
  await once(server, "listening")
  const address = server.address()
  assert(address && typeof address === "object")
  const url = `http://127.0.0.1:${address.port}/PRIVATE-LIFECYCLE-PATH`
  const task = "lifecycle-A"
  const win = new BrowserWindow({ show: false, width: 640, height: 480 })
  const other = new BrowserWindow({ show: false, width: 640, height: 480 })
  const owner = registerBrowserOwner(win)
  const foreign = registerBrowserOwner(other)
  const consent = dialog.showMessageBox
  const unloadConsent = dialog.showMessageBoxSync
  const clock = Date.now
  const prompts: Electron.MessageBoxOptions[] = []
  let answer = 1
  let dialogHook: ((options: Electron.MessageBoxOptions) => Promise<void>) | undefined
  const controlledConsent = (async (
    windowOrOptions: Electron.BaseWindow | Electron.MessageBoxOptions,
    options?: Electron.MessageBoxOptions,
  ) => {
    const settings = options ?? ("message" in windowOrOptions ? windowOrOptions : undefined)
    assert(settings)
    assert.equal(settings.defaultId, 0)
    assert.equal(settings.cancelId, 0)
    assert(settings.signal)
    if (!settings.detail?.includes(url)) assert(!JSON.stringify(settings).includes("PRIVATE-LIFECYCLE"))
    prompts.push(settings)
    await dialogHook?.(settings)
    return { response: answer, checkboxChecked: false }
  }) as typeof dialog.showMessageBox
  dialog.showMessageBox = controlledConsent
  const replies = new Map<string, (response: Response<BrowserState>) => void>()
  const posts = new Map<string, number>()
  const settlements = new Map<string, Promise<unknown>>()
  let routes = 0
  let deadline = Infinity
  let sequence = 0
  const child = Object.assign(new EventEmitter(), {
    postMessage(message: BrowserIpcResult) {
      posts.set(message.id, (posts.get(message.id) ?? 0) + 1)
      const text = JSON.stringify(message.response)
      assert(!text.includes("PRIVATE-LIFECYCLE"))
      if (message.response.ok && (message.response.result.tabToken || message.response.result.tabResult)) {
        const { tabToken, tabResult, ...empty } = message.response.result
        assert.deepEqual(empty, { tabID: "", url: "", title: "", visibleText: "", elements: [] })
        assert(tabToken || tabResult)
      }
      replies.get(message.id)?.(message.response)
      replies.delete(message.id)
    },
  })
  const stop = attachBrowserBridge(child, (message, allowed, control = {}) => {
    routes++
    return routeBrowserRequest(message, allowed, {
      ...control,
      deadline: Math.min(control.deadline ?? Infinity, deadline),
      onSettled(pending) {
        settlements.set(message.id, pending)
        control.onSettled?.(pending)
      },
    })
  })
  const dispatch = async (request: Request, sessionID = task, signal?: AbortSignal, id = `lifecycle-${++sequence}`) => {
    const reply = Promise.withResolvers<Response<BrowserState>>()
    replies.set(id, reply.resolve)
    const abort = () => child.emit("message", { type: "browser_cancel", id, sessionID })
    child.emit("message", { type: "browser_request", id, sessionID, request })
    signal?.addEventListener("abort", abort, { once: true })
    if (signal?.aborted) abort()
    try {
      return await reply.promise
    } finally {
      signal?.removeEventListener("abort", abort)
    }
  }
  const tools = browserTools({ send: (sessionID, request, signal) => dispatch(request, sessionID, signal) })
  const asks: Parameters<ToolContext["ask"]>[0][] = []
  let askHook: (() => Promise<void>) | undefined
  const context: ToolContext = {
    sessionID: task,
    messageID: "lifecycle",
    agent: "build",
    directory: ".",
    worktree: ".",
    abort: new AbortController().signal,
    metadata() {},
    async ask(input) {
      asks.push(input)
      await askHook?.()
    },
  }
  const command = (value: Parameters<typeof browserCommand>[2]) => browserCommand(owner, task, value)
  const plugin = (request: TabRequest) =>
    tools[`browser_${request.op}`].execute("tabID" in request ? { tabID: request.tabID } : {}, context)
  const prepare = async <T extends TabRequest>(request: T) => {
    const result = await dispatch({ op: "prepare_tab", request })
    assert(result.ok && result.result.tabToken, JSON.stringify(result))
    return { ...request, token: result.result.tabToken }
  }
  const denied = (response: Response<BrowserState>) => assert(!response.ok, "Expected denial")
  const group = () => owner.groups.get(task)!
  const tab = (id: string) => {
    const found = group().tabs.find((entry) => entry.id === id)
    assert(found)
    return found
  }
  const layout = () =>
    browserViewport(owner, {
      sessionID: task,
      lease: "lifecycle",
      bounds: { x: 0, y: 0, width: 600, height: 400 },
    })
  const create = async () => {
    const result = await plugin({ op: "create_tab" })
    assert.equal(typeof result, "string")
    const id = String(result).split(" ")[1]
    const created = tab(id)
    await wait(() => !created.contents.isLoadingMainFrame() && created.contents.getURL() === "about:blank")
    assert.equal(created.agentAccess, false)
    return created
  }
  const arm = async (target: ReturnType<typeof tab>) => {
    await command({ op: "select", tabID: target.id })
    await target.view.webContents.loadURL(url)
    await wait(() => !target.contents.isLoadingMainFrame())
    layout()
    win.focus()
    target.view.webContents.focus()
    target.view.webContents.sendInputEvent({ type: "mouseDown", x: 80, y: 45, button: "left", clickCount: 1 })
    target.view.webContents.sendInputEvent({ type: "mouseUp", x: 80, y: 45, button: "left", clickCount: 1 })
    await wait(() => target.view.webContents.executeJavaScript("window.trusted === true"))
    assert(await target.view.webContents.executeJavaScript("navigator.userActivation.hasBeenActive"))
  }

  try {
    await win.loadURL("about:blank")
    await other.loadURL("about:blank")
    win.showInactive()
    other.showInactive()
    browserLinkContext(owner, task, "A")
    browserLinkContext(foreign, "lifecycle-foreign", "foreign")

    const noTabs = await prepare({ op: "create_tab" })
    setBrowserAgentEnabled(false)
    denied(await dispatch({ op: "prepare_tab", request: { op: "create_tab" } }))
    setBrowserAgentEnabled(true)
    denied(await dispatch(noTabs))
    assert.equal(owner.groups.size, 0)
    for (const closedOnly of [false, true]) {
      const sessionID = `recovery-${closedOnly}`
      const record = {
        sessionID,
        tabs: closedOnly
          ? []
          : [
              { url: `${url}/restore-one`, title: "PRIVATE-LIFECYCLE-ONE" },
              { url: `${url}/restore-two`, title: "PRIVATE-LIFECYCLE-TWO" },
            ],
        active: closedOnly ? -1 : 1,
        closed: [{ id: "closed", url: `${url}/closed`, title: "PRIVATE-LIFECYCLE-CLOSED", time: 123 }],
      }
      browserLinkContext(owner, sessionID, sessionID)
      const early = closedOnly
        ? await dispatch({ op: "prepare_tab", request: { op: "create_tab" } }, sessionID)
        : undefined
      saveTabs(record)
      assert.deepEqual(savedTabs(sessionID), record)
      const prepared = early ?? (await dispatch({ op: "prepare_tab", request: { op: "create_tab" } }, sessionID))
      const result =
        prepared.ok && prepared.result.tabToken
          ? await dispatch({ op: "create_tab", token: prepared.result.tabToken }, sessionID)
          : prepared
      assert.deepEqual(savedTabs(sessionID), record, "Creation must preserve the complete unloaded recovery record")
      assert(!result.ok && result.code === "unavailable")
      assert.match(result.error, /manually/i)
      assert(!owner.groups.has(sessionID))
      assert.deepEqual(requests, [])
    }
    browserLinkContext(owner, task, "A")
    assert.equal(prompts.length, 0)
    const first = await create()
    assert.equal(group().tabs.length, 1)
    assert.deepEqual(requests, [])
    assert.deepEqual(
      asks.map((input) => input.permission),
      ["browser_create_tab"],
    )
    assert.equal(prompts.length, 1)
    assert(prompts[0].detail?.includes(task))
    denied(await dispatch({ op: "read_state", tabID: first.id }))
    const inventory = await dispatch({ op: "list_tabs" })
    assert(inventory.ok)
    assert.deepEqual(inventory.result.tabs, [])
    const second = await create()
    await second.view.webContents.loadURL(url)
    await wait(() => !second.contents.isLoadingMainFrame())
    layout()
    await command({ op: "access", tabID: second.id, enabled: true })
    for (const operation of ["screenshot", "press_key"] as const) {
      if (operation === "press_key") {
        win.focus()
        second.view.webContents.focus()
        await wait(() => second.view.webContents.focusedFrame === second.view.webContents.mainFrame)
      }
      const actions = await Promise.all([
        prepare({ op: "create_tab" }),
        prepare({ op: "select_tab", tabID: first.id }),
        prepare({ op: "close_tab", tabID: first.id }),
      ])
      const request =
        operation === "screenshot"
          ? { op: operation, tabID: second.id }
          : { op: operation, tabID: second.id, key: "a", modifiers: [] }
      const binding = await dispatch({ op: "prepare_write", request })
      assert(binding.ok && binding.result.context)
      const debug = second.view.webContents.debugger
      const send = debug.sendCommand.bind(debug)
      const entered = Promise.withResolvers<void>()
      const held = Promise.withResolvers<void>()
      debug.sendCommand = async (method, params) => {
        const result = await send(method, params)
        if (
          method === "Page.captureScreenshot" ||
          (method === "Input.dispatchKeyEvent" && params?.type === "keyDown")
        ) {
          entered.resolve()
          await held.promise
        }
        return result
      }
      const controller = new AbortController()
      const pending = dispatch(
        { ...request, context: binding.result.context },
        task,
        controller.signal,
        `source-${operation}`,
      )
      try {
        await Promise.race([
          entered.promise,
          pending.then((result) => {
            throw new Error(`Held ${operation} never dispatched: ${JSON.stringify(result)}`)
          }),
        ])
        const before: number = prompts.length
        assert.equal(owner.attached, second)
        for (const action of actions) {
          const { token, ...request } = action
          const result = await dispatch(action)
          assert(!result.ok && result.code === "unavailable", `${operation} must block ${request.op} admission`)
          denied(await dispatch({ op: "prepare_tab", request }))
          assert(browserOperationBusy.has(second.id))
          assert(!browserOperationBusy.has(first.id))
          assert.equal(owner.attached, second)
          assert.equal(prompts.length, before)
        }
      } finally {
        controller.abort()
        denied(await pending)
        held.resolve()
        await settlements.get(`source-${operation}`)
        debug.sendCommand = send
      }
      assert(!browserOperationBusy.has(second.id))
      console.log(`PASS lifecycle distinct active source held real ${operation}: no consent or detachment`)
    }
    await first.view.webContents.loadURL(url)
    await wait(() => !first.contents.isLoadingMainFrame())
    assert.equal(await plugin({ op: "select_tab", tabID: first.id }), `select_tab ${first.id}`)
    assert.equal(group().activeID, first.id)
    assert.equal(first.agentAccess, false)
    assert.equal(await plugin({ op: "close_tab", tabID: second.id }), `close_tab ${second.id}`)
    assert(second.contents.isDestroyed())
    assert(!first.contents.isDestroyed())
    assert.deepEqual(
      asks.map((input) => input.permission),
      ["browser_create_tab", "browser_create_tab", "browser_select_tab", "browser_close_tab"],
    )
    assert.equal(prompts.length, 6)
    assert(asks.every((input) => !input.permission.includes("read")))
    const foreignID = (await browserCommand(foreign, "lifecycle-foreign", { op: "new" })).activeID!
    const before = prompts.length
    for (const id of ["missing", foreignID]) {
      for (const op of ["select_tab", "close_tab"] as const)
        denied(await dispatch({ op: "prepare_tab", request: { op, tabID: id } }))
    }
    denied(await dispatch({ op: "prepare_tab", request: { op: "create_tab" } }, "unknown-task"))
    assert.equal(prompts.length, before)

    for (const mismatch of ["action", "target", "task", "reuse", "expired"] as const) {
      const prepared = await prepare({ op: "select_tab", tabID: first.id })
      if (mismatch === "action") denied(await dispatch({ ...prepared, op: "close_tab" }))
      if (mismatch === "target") denied(await dispatch({ ...prepared, tabID: foreignID }))
      if (mismatch === "task") denied(await dispatch(prepared, "lifecycle-foreign"))
      if (mismatch === "reuse") assert((await dispatch(prepared)).ok)
      if (mismatch === "expired") {
        Date.now = () => clock() + 60_001
        try {
          denied(await dispatch(prepared))
        } finally {
          Date.now = clock
        }
      }
      denied(await dispatch(prepared))
      assert(!first.contents.isDestroyed())
    }
    const evicted = await prepare({ op: "create_tab" })
    for (let i = 0; i < 128; i++) await prepare({ op: "create_tab" })
    denied(await dispatch(evicted))
    console.log(
      "PASS lifecycle private blank/no restore, exact targets, plugin asks, one-use/action/target/task/TTL/cap",
    )

    answer = 0
    const count = group().tabs.length
    await assert.rejects(plugin({ op: "create_tab" }))
    assert.equal(group().tabs.length, count)
    answer = 1
    askHook = async () => {
      throw new Error("Fixture plugin denial")
    }
    const promptCount = prompts.length
    await assert.rejects(plugin({ op: "create_tab" }))
    assert.equal(prompts.length, promptCount)
    askHook = undefined

    for (const change of ["global", "task", "hide", "viewport", "access"] as const) {
      if (change === "access") await command({ op: "access", tabID: first.id, enabled: true })
      const prepared = await prepare({ op: "close_tab", tabID: first.id })
      dialogHook = async () => {
        if (change === "global") {
          setBrowserAgentEnabled(false)
          setBrowserAgentEnabled(true)
        }
        if (change === "task") {
          browserLinkContext(owner, "lifecycle-B", "B")
          browserLinkContext(owner, task, "A")
        }
        if (change === "hide") {
          win.hide()
          win.showInactive()
        }
        if (change === "viewport") {
          layout()
          browserViewport(owner, { sessionID: task, lease: "lifecycle", bounds: null })
          layout()
        }
        if (change === "access") await command({ op: "access", tabID: first.id, enabled: false })
      }
      denied(await dispatch(prepared))
      dialogHook = undefined
      assert(!first.contents.isDestroyed())
      assert.equal(owner.suspended, 0)
      assert.equal(owner.tabConsent, undefined)
      console.log(`PASS lifecycle pending consent invalidation: ${change}`)
    }
    // Regrant is possible while plugin approval is pending, not while a native prompt owns the owner.
    await command({ op: "access", tabID: first.id, enabled: true })
    askHook = async () => {
      await command({ op: "access", tabID: first.id, enabled: false })
      await command({ op: "access", tabID: first.id, enabled: true })
    }
    await assert.rejects(plugin({ op: "close_tab", tabID: first.id }))
    askHook = undefined
    assert(!first.contents.isDestroyed())

    await first.view.webContents.executeJavaScript("window.child = window.open('about:blank'); true", true)
    await wait(() => group().tabs.some((entry) => entry.openerID === first.id))
    const popup = group().tabs.find((entry) => entry.openerID === first.id)!
    await wait(() => !popup.contents.isLoadingMainFrame())
    assert.equal(popup.agentAccess, false)
    assert.equal(await popup.view.webContents.executeJavaScript("!!window.opener"), true)
    assert.equal(await plugin({ op: "close_tab", tabID: popup.id }), `close_tab ${popup.id}`)
    assert(popup.contents.isDestroyed())
    assert(!first.contents.isDestroyed())
    console.log("PASS lifecycle revoke/regrant during plugin ask and private popup child-only close")

    const source = await create()
    await source.view.webContents.loadURL(url)
    await wait(() => !source.contents.isLoadingMainFrame())
    layout()
    await command({ op: "access", tabID: source.id, enabled: true })
    const sourceKey = { op: "press_key", tabID: source.id, key: "a", modifiers: [] } as const
    const sourceBinding = await dispatch({ op: "prepare_write", request: { ...sourceKey, modifiers: [] } })
    assert(sourceBinding.ok && sourceBinding.result.context)
    const aborted = new AbortController()
    const heldConsent = Promise.withResolvers<void>()
    const enteredConsent = Promise.withResolvers<void>()
    dialogHook = async () => {
      enteredConsent.resolve()
      await heldConsent.promise
    }
    const abortRequest = await prepare({ op: "close_tab", tabID: first.id })
    const abortReply = dispatch(abortRequest, task, aborted.signal, "held-consent")
    try {
      await enteredConsent.promise
      for (const cancel of [false, true]) {
        if (cancel) {
          aborted.abort()
          denied(await abortReply)
        }
        for (const target of [source, first]) assert(browserOperationBusy.has(target.id))
        for (const request of [
          { op: "read_state", tabID: source.id },
          { op: "prepare_write", request: { op: "screenshot", tabID: source.id } },
          { op: "screenshot", tabID: source.id, context: sourceBinding.result.context },
          { ...sourceKey, modifiers: [], context: sourceBinding.result.context },
        ] satisfies Request[]) {
          const result = await dispatch(request)
          assert(!result.ok && result.code === "unavailable")
        }
      }
    } finally {
      aborted.abort()
      heldConsent.resolve()
      await settlements.get("held-consent")
      dialogHook = undefined
    }
    assert(!first.contents.isDestroyed())
    for (const target of [source, first]) assert(!browserOperationBusy.has(target.id))
    await plugin({ op: "close_tab", tabID: source.id })
    console.log("PASS lifecycle pending consent and early cancel block distinct source page routes until settlement")

    for (const choice of ["stay", "expired-leave", "leave"] as const) {
      const target = await create()
      await arm(target)
      let nativeEvents = 0
      let dialogs = 0
      target.view.webContents.on("will-prevent-unload", () => nativeEvents++)
      dialog.showMessageBoxSync = ((_window, options) => {
        assert.equal(options.defaultId, 0)
        assert.equal(options.cancelId, 0)
        dialogs++
        if (choice === "expired-leave") Date.now = () => clock() + 20_000
        return choice === "stay" ? 0 : 1
      }) as typeof dialog.showMessageBoxSync
      try {
        const request = await prepare({ op: "close_tab", tabID: target.id })
        const result = await dispatch(request)
        assert.equal(nativeEvents, 1, "Must reach actual Chromium unload event, not emit a fake event")
        assert.equal(dialogs, 1)
        if (choice === "leave") {
          assert(result.ok)
          assert(target.contents.isDestroyed())
        } else {
          denied(result)
          assert(!target.contents.isDestroyed())
          assert.equal(await target.view.webContents.executeJavaScript("window.unloads"), 1)
        }
      } finally {
        Date.now = clock
        dialog.showMessageBoxSync = unloadConsent
        if (!target.contents.isDestroyed()) {
          await target.view.webContents.executeJavaScript("window.onbeforeunload = null")
          await plugin({ op: "close_tab", tabID: target.id })
        }
      }
      console.log(
        `PASS real Chromium beforeunload ${choice}; controlled native answer${choice === "expired-leave" ? " and clock advance inside synchronous dialog seam" : ""}`,
      )
    }

    // Pause the real renderer before close; resume only after the early cancellation reply.
    const closing = await create()
    await arm(closing)
    await command({ op: "select", tabID: first.id })
    const contents = closing.view.webContents
    const debug = contents.debugger
    if (!debug.isAttached()) debug.attach("1.3")
    await debug.sendCommand("Debugger.enable")
    await debug.sendCommand("Debugger.pause")
    let closes = 0
    const nativeClose = contents.close.bind(contents)
    contents.close = (options) => {
      closes++
      assert.equal(options?.waitForBeforeUnload, true)
      nativeClose(options)
    }
    let vetoes = 0
    contents.on("will-prevent-unload", () => vetoes++)
    const closeRequest = await prepare({ op: "close_tab", tabID: closing.id })
    const controller = new AbortController()
    const early = dispatch(closeRequest, task, controller.signal, "held-close")
    try {
      await wait(() => closes === 1)
      assert(!contents.isDestroyed())
      assert.equal(vetoes, 0)
      controller.abort()
      denied(await early)
      assert(browserOperationBusy.has(closing.id))
      assert(browserOperationBusy.has(first.id))
      assert.equal(first.contents.backgroundThrottling, false)
      const sourceRead = await dispatch({ op: "read_state", tabID: first.id })
      assert(!sourceRead.ok && sourceRead.code === "unavailable")
      assert.equal(contents.backgroundThrottling, false)
      const routeCount = routes
      for (const sessionID of [task, "lifecycle-foreign"])
        child.emit("message", { type: "browser_request", id: "held-close", sessionID, request: closeRequest })
      await setTimeout(30)
      assert.equal(routes, routeCount)
      assert.equal(posts.get("held-close"), 1)
      denied(await dispatch({ op: "prepare_tab", request: { op: "create_tab" } }))
      await debug.sendCommand("Debugger.resume")
      await settlements.get("held-close")
      assert.equal(vetoes, 1)
      assert(!contents.isDestroyed())
      assert(!browserOperationBusy.has(closing.id))
      assert(!browserOperationBusy.has(first.id))
      assert.equal(first.contents.backgroundThrottling, true)
      assert.equal(contents.backgroundThrottling, true)
      assert.equal(posts.get("held-close"), 1)
      assert.equal(closes, 1)
      console.log(
        "PASS real paused-renderer close: early cancel retains busy/render/correlation until native veto; duplicate IDs silent",
      )
    } finally {
      await debug.sendCommand("Debugger.resume").catch(() => {})
      contents.close = nativeClose
      await contents.executeJavaScript("window.onbeforeunload = null")
      await plugin({ op: "close_tab", tabID: closing.id })
    }

    for (const mode of ["revoke", "cancel-revoke", "destroy", "hash", "history"] as const) {
      const sameDocument = mode === "hash" || mode === "history"
      const target = await create()
      await target.view.webContents.loadURL(url)
      await command({ op: "site-permission", origin: url, camera: "allow", microphone: "allow" })
      await wait(() => !target.contents.isLoadingMainFrame())
      await arm(target)
      const contents = target.view.webContents
      assert(
        await contents.executeJavaScript(`(async () => {
        window.stream = await navigator.mediaDevices.getUserMedia({video: true, audio: true});
        window.oldDocument = true;
        return window.stream.getTracks().length === 2 && window.stream.getTracks().every(t => t.readyState === "live");
      })()`),
      )
      if (mode === "destroy") await contents.executeJavaScript("window.onbeforeunload = () => {}; true")
      await command({ op: "select", tabID: first.id })
      const debug = contents.debugger
      if (!debug.isAttached()) debug.attach("1.3")
      await debug.sendCommand("Debugger.enable")
      if (!sameDocument) await debug.sendCommand("Debugger.pause")
      const nativeClose = contents.close.bind(contents)
      let closes = 0
      let vetoes = 0
      let navigations = 0
      let inPage = 0
      contents.close = (options) => {
        closes++
        // Hold dispatch so real same-document commits can precede the native close veto.
        if (!sameDocument) nativeClose(options)
      }
      const events: EventEmitter = contents
      const listeners = events.listenerCount("-before-unload-fired")
      let acknowledged = false
      const acknowledge = () => {
        acknowledged = true
        assert(browserOperationBusy.has(target.id))
        assert(browserOperationBusy.has(first.id))
      }
      events.on("-before-unload-fired", acknowledge)
      contents.on("will-prevent-unload", () => {
        vetoes++
        if (vetoes === 1) assert(target.agentClose)
        if (vetoes === 2) assert.equal(target.agentClose, undefined)
      })
      contents.on("did-navigate", () => navigations++)
      const nativeReload = contents.reload.bind(contents)
      let reloads = 0
      contents.reload = () => {
        reloads++
        assert(acknowledged, "Safety reload must wait for the native close acknowledgement")
        assert.equal(target.agentClose, undefined)
        nativeReload()
      }
      let dialogs = 0
      dialog.showMessageBoxSync = (() => {
        dialogs++
        return 0
      }) as typeof dialog.showMessageBoxSync
      const controller = new AbortController()
      const id = `media-close-${mode}`
      const pending = dispatch(await prepare({ op: "close_tab", tabID: target.id }), task, controller.signal, id)
      try {
        await wait(() => closes === 1)
        if (mode === "cancel-revoke" || mode === "destroy") {
          controller.abort()
          denied(await pending)
        }
        await command({ op: "site-permission", origin: url, camera: "block", microphone: "block" })
        assert(browserOperationBusy.has(target.id))
        assert(browserOperationBusy.has(first.id))
        assert.equal(vetoes, 0)
        assert.equal(reloads, 0)
        for (const op of ["close", "navigate", "back", "forward", "reload", "stop"])
          await assert.rejects(command({ op, tabID: target.id, url }))
        assert.equal(closes, 1)
        if (mode === "hash" || mode === "history") {
          contents.on("did-start-navigation", (_event, _url, sameDocument, main) => {
            if (!main || !sameDocument) return
            inPage++
            assert.equal(acknowledged, false, "Same-document start must precede native close acknowledgement")
          })
          const before = await contents.executeJavaScript(
            `${mode === "hash" ? 'location.hash = "revoked"' : 'history.pushState({}, "", "?revoked")'};
              window.oldDocument === true && window.stream.getTracks().length === 2 &&
              window.stream.getTracks().every(t => t.readyState === "live")`,
          )
          assert.equal(before, true, "Same-document navigation must retain the live-media document")
          await wait(() => inPage === 1)
          assert.equal(acknowledged, false)
          assert.equal(vetoes, 0)
          assert.equal(navigations, 0)
          assert.equal(reloads, 0)
          assert(target.agentClose)
        }
        if (sameDocument) nativeClose({ waitForBeforeUnload: true })
        else await debug.sendCommand("Debugger.resume")
        denied(await pending)
        let settled = false
        void settlements.get(id)?.then(() => {
          settled = true
        })
        await wait(() => settled)
        assert(acknowledged)
        if (mode === "hash" || mode === "history") assert.equal(inPage, 1)
        assert.equal(reloads, mode === "destroy" ? 0 : 1, `Safety reload after ${mode}`)
        assert.equal(dialogs, 0)
        if (mode === "destroy") {
          assert(contents.isDestroyed())
          assert.equal(navigations, 0, "Destroyed close must not dispatch a safety reload")
        } else {
          assert(!contents.isDestroyed(), "Revocation must not force-close the cancelled page")
          await wait(() => navigations > 0 && !contents.isLoadingMainFrame())
          assert.equal(
            await contents.executeJavaScript("window.oldDocument === undefined && window.stream === undefined"),
            true,
            "Revocation must destroy the old document holding both live fake tracks",
          )
          assert.equal(vetoes, 2, "Close veto must settle before a separate forced reload veto")
          assert.equal(
            await contents.executeJavaScript(
              `navigator.mediaDevices.getUserMedia({video:true,audio:true}).then(() => false, () => true)`,
            ),
            true,
          )
        }
        assert.equal(closes, 1)
        assert.equal(posts.get(id), 1)
        assert(!browserOperationBusy.has(target.id))
        assert(!browserOperationBusy.has(first.id))
        assert.equal(target.agentClose, undefined)
        events.removeListener("-before-unload-fired", acknowledge)
        assert.equal(events.listenerCount("-before-unload-fired"), listeners)
        console.log(`PASS live fake media held close ${mode}: native settlement, old-document disposal, one reply`)
      } finally {
        events.removeListener("-before-unload-fired", acknowledge)
        if (!contents.isDestroyed()) {
          contents.close = nativeClose
          contents.reload = nativeReload
          contents.close({ waitForBeforeUnload: false })
        }
        dialog.showMessageBoxSync = unloadConsent
      }
    }

    for (const heldClose of [false, true]) {
      recoveryResponse = "ok"
      const target = await create()
      await arm(target)
      await command({ op: "site-permission", origin: url, camera: "allow", microphone: "allow" })
      await wait(() => !target.contents.isLoadingMainFrame())
      await arm(target)
      const contents = target.view.webContents
      assert(
        await contents.executeJavaScript(`(async () => {
        history.replaceState({}, "", "/permission-recovery");
        window.oldDocument = true;
        window.stream = await navigator.mediaDevices.getUserMedia({video:true,audio:true});
        return window.stream.getTracks().length === 2 && window.stream.getTracks().every(t => t.readyState === "live");
      })()`),
      )
      const nativeReload = contents.reload.bind(contents)
      let reloads = 0
      const preDispatch: Promise<void>[] = []
      contents.reload = () => {
        reloads++
        if (reloads === 1) {
          for (const op of ["close", "navigate", "reload", "stop"])
            preDispatch.push(assert.rejects(command({ op, tabID: target.id, url })))
        }
        nativeReload()
      }
      const debug = contents.debugger
      const controller = new AbortController()
      const id = `permission-204-${heldClose}`
      let dialogs = 0
      let leave = true
      dialog.showMessageBoxSync = (() => {
        dialogs++
        return leave ? 1 : 0
      }) as typeof dialog.showMessageBoxSync
      try {
        if (heldClose) {
          await command({ op: "select", tabID: first.id })
          if (!debug.isAttached()) debug.attach("1.3")
          await debug.sendCommand("Debugger.enable")
          await debug.sendCommand("Debugger.pause")
          const pending = dispatch(await prepare({ op: "close_tab", tabID: target.id }), task, controller.signal, id)
          await wait(() => !!target.agentClose)
          controller.abort()
          denied(await pending)
        }
        recoveryResponse = "empty"
        const stopped = once(contents, "did-stop-loading")
        await command({ op: "site-permission", origin: url, camera: "block", microphone: "block" })
        if (heldClose) {
          assert.equal(reloads, 0)
          await debug.sendCommand("Debugger.resume")
          await settlements.get(id)
          assert.equal(posts.get(id), 1)
        }
        await stopped
        await Promise.all(preDispatch)
        assert.equal(reloads, 1)
        assert.equal(target.agentClose, undefined)
        assert.equal(target.permissionReload, true)
        assert(
          await contents.executeJavaScript(
            "window.oldDocument === true && window.stream.getTracks().every(t => t.readyState === 'live')",
          ),
        )
        await setTimeout(40)
        assert.equal(reloads, 1, "A 204 must not automatically replay the safety reload")

        const retried = once(contents, "did-stop-loading")
        await command({ op: "reload", tabID: target.id })
        await retried
        assert.equal(reloads, 2, "Manual retry must be admitted after HTTP 204")
        assert.equal(target.permissionReload, true)
        const navigated = once(contents, "did-stop-loading")
        await assert.rejects(
          command({ op: "navigate", tabID: target.id, url: new URL("/permission-recovery", url).href }),
          /ERR_FAILED/,
        )
        await navigated
        assert.equal(target.permissionReload, true)
        const beforeClose = dialogs
        leave = false
        const closeAcknowledged = once(contents, "-before-unload-fired")
        await command({ op: "close", tabID: target.id })
        await closeAcknowledged
        await setTimeout(0)
        assert.equal(dialogs, beforeClose + 1)
        assert(!contents.isDestroyed(), "The outstanding obligation must not force a manual close")
        leave = true

        recoveryResponse = "hold"
        const count = requests.length
        await command({ op: "reload", tabID: target.id })
        await wait(() => requests.length > count && contents.isLoadingMainFrame())
        const cancelled = once(contents, "did-stop-loading")
        await command({ op: "stop", tabID: target.id })
        await cancelled
        assert.equal(target.permissionReload, true)
        assert(await contents.executeJavaScript("window.oldDocument === true"))

        recoveryResponse = "disconnect"
        const failed = once(contents, "did-stop-loading")
        await command({ op: "reload", tabID: target.id })
        await failed
        // Chromium may commit its own error document; only that commit may discharge the obligation.
        if (await contents.executeJavaScript("window.oldDocument === true")) assert.equal(target.permissionReload, true)
        recoveryResponse = "ok"
        const replaced = once(contents, "did-stop-loading")
        await command({ op: "navigate", tabID: target.id, url })
        await replaced
        assert.equal(target.permissionReload, false)
        assert(await contents.executeJavaScript("window.oldDocument === undefined && window.stream === undefined"))
        assert(
          await contents.executeJavaScript(
            "navigator.mediaDevices.getUserMedia({video:true,audio:true}).then(() => false, () => true)",
          ),
        )
        await command({ op: "close", tabID: target.id })
        await wait(() => contents.isDestroyed())
        console.log(
          `PASS permission HTTP204 heldClose=${heldClose}: retained obligation, manual recovery, Stop, disconnect, replacement`,
        )
      } finally {
        recoveryResponse = "ok"
        dialog.showMessageBoxSync = unloadConsent
        if (!contents.isDestroyed()) {
          contents.reload = nativeReload
          contents.close({ waitForBeforeUnload: false })
        }
      }
    }

    for (const outcome of ["ok", "empty", "hold"] as const) {
      recoveryResponse = "ok"
      releaseResource = undefined
      const target = await create()
      const contents = target.view.webContents
      await contents.loadURL(new URL("/permission-recovery", url).href)
      const debug = contents.debugger
      if (!debug.isAttached()) debug.attach("1.3")
      const nativeReload = contents.reload.bind(contents)
      let reloads = 0
      let stops = 0
      contents.on("did-stop-loading", () => stops++)
      contents.reload = () => {
        reloads++
        nativeReload()
      }
      try {
        recoveryResponse = "resource"
        await command({ op: "site-permission", origin: url, camera: "allow", microphone: "allow" })
        await wait(async () => {
          const value = await debug.sendCommand("Runtime.evaluate", {
            expression:
              "window.stream?.getTracks().length === 2 && window.stream.getTracks().every(t => t.readyState === 'live')",
            returnByValue: true,
          })
          return !!releaseResource && value.result.value === true
        })
        assert.equal(reloads, 1)
        assert.equal(target.permissionReload, false, "First reload has committed")
        assert.equal(target.permissionReloadPhase, "loading")
        assert(contents.isLoadingMainFrame())
        recoveryResponse = outcome
        await command({ op: "site-permission", origin: url, camera: "block", microphone: "block" })
        await command({ op: "site-permission", origin: url, camera: "block", microphone: "block" })
        assert.equal(target.permissionReload, true)
        assert.equal(reloads, 1, "New requests must coalesce behind the active attempt")
        const stopped = once(contents, "did-stop-loading")
        releaseResource!()
        await stopped
        await setTimeout(50)
        assert.equal(reloads, 2, "Post-commit revocation must dispatch exactly one fresh safety reload")
        if (outcome === "hold") {
          await wait(() => contents.isLoadingMainFrame())
          await command({ op: "stop", tabID: target.id })
        }
        await wait(() => stops >= 2 && !target.permissionReloadPhase)
        await setTimeout(80)
        assert.equal(reloads, 2, "A 204 or Stop must not replay the already-attempted request")
        if (outcome !== "ok") {
          assert.equal(target.permissionReload, true)
          assert(await contents.executeJavaScript("window.oldDocument === true"))
          recoveryResponse = "ok"
          await command({ op: "reload", tabID: target.id })
          await wait(() => !target.permissionReload && !target.permissionReloadPhase)
          assert.equal(reloads, 3, "Only explicit manual recovery retries the failed attempt")
        }
        assert.equal(target.permissionReload, false)
        assert(await contents.executeJavaScript("window.oldDocument === undefined && window.stream === undefined"))
        assert(
          await contents.executeJavaScript(
            "navigator.mediaDevices.getUserMedia({video:true,audio:true}).then(() => false, () => true)",
          ),
        )
        console.log(`PASS post-commit media revocation ${outcome}: coalesced fresh attempt, no failed-attempt replay`)
      } finally {
        ;(releaseResource as (() => void) | undefined)?.()
        releaseResource = undefined
        recoveryResponse = "ok"
        if (!contents.isDestroyed()) {
          contents.reload = nativeReload
          contents.close({ waitForBeforeUnload: false })
        }
      }
    }

    for (const outcome of ["ok", "empty", "stop"] as const) {
      recoveryResponse = "ok"
      releaseRecovery = undefined
      const target = await create()
      const contents = target.view.webContents
      await contents.loadURL(new URL("/permission-recovery", url).href)
      await contents.executeJavaScript("window.oldDocument = true")
      const nativeReload = contents.reload.bind(contents)
      let reloads = 0
      let commits = 0
      contents.on("did-navigate", () => commits++)
      contents.reload = () => {
        reloads++
        nativeReload()
      }
      try {
        recoveryResponse = "hold"
        await command({ op: "site-permission", origin: url, camera: "allow", microphone: "allow" })
        await wait(() => !!releaseRecovery && contents.isLoadingMainFrame())
        await command({ op: "site-permission", origin: url, camera: "block", microphone: "block" })
        await command({ op: "site-permission", origin: url, camera: "block", microphone: "block" })
        assert.equal(commits, 0, "Requests must arrive before any replacement commit")
        assert.equal(reloads, 1, "Pre-commit requests must coalesce behind the active attempt")
        recoveryResponse = outcome === "ok" ? "ok" : "empty"
        if (outcome === "stop") await command({ op: "stop", tabID: target.id })
        else releaseRecovery!()
        await wait(() => !target.permissionReloadPhase)
        await setTimeout(80)
        assert.equal(
          reloads,
          outcome === "ok" ? 1 : 2,
          "Commit covers queued changes; without commit, fresh queued work needs exactly one attempt",
        )
        assert.equal(commits, outcome === "ok" ? 1 : 0)
        if (outcome !== "ok") {
          assert.equal(target.permissionReload, true)
          assert(await contents.executeJavaScript("window.oldDocument === true"))
          recoveryResponse = "ok"
          await command({ op: "reload", tabID: target.id })
          await wait(() => !target.permissionReload && !target.permissionReloadPhase)
          assert.equal(reloads, 3, "An already-attempted 204 requires explicit manual retry")
        }
        assert.equal(target.permissionReload, false)
        assert(await contents.executeJavaScript("window.oldDocument === undefined"))
        console.log(
          `PASS pre-commit permission requests ${outcome}: commit absorption or one fresh attempt, manual recovery`,
        )
      } finally {
        releaseRecovery = undefined
        recoveryResponse = "ok"
        if (!contents.isDestroyed()) {
          contents.reload = nativeReload
          contents.close({ waitForBeforeUnload: false })
        }
      }
    }

    const quarantined = await create()
    await quarantined.view.webContents.loadURL(url)
    await wait(() => !quarantined.contents.isLoadingMainFrame())
    layout()
    await command({ op: "access", tabID: quarantined.id, enabled: true })
    const key = { op: "press_key", tabID: quarantined.id, key: "a", modifiers: [] } as const
    const binding = await dispatch({ op: "prepare_write", request: { ...key, modifiers: [] } })
    assert(binding.ok && binding.result.context)
    const send = quarantined.view.webContents.debugger.sendCommand.bind(quarantined.view.webContents.debugger)
    const pressed = Promise.withResolvers<void>()
    const release = Promise.withResolvers<void>()
    quarantined.view.webContents.debugger.sendCommand = async (method, params) => {
      const value = await send(method, params)
      if (method === "Input.dispatchKeyEvent" && params?.type === "keyDown") {
        pressed.resolve()
        await release.promise
      }
      return value
    }
    const keyAbort = new AbortController()
    const keyReply = dispatch(
      { ...key, modifiers: [], context: binding.result.context },
      task,
      keyAbort.signal,
      "quarantine",
    )
    try {
      await pressed.promise
      keyAbort.abort()
      denied(await keyReply)
      release.resolve()
      await settlements.get("quarantine")
      assert(browserInputFailure(quarantined.contents))
      denied(await dispatch({ op: "prepare_tab", request: { op: "select_tab", tabID: quarantined.id } }))
      assert.equal(await plugin({ op: "close_tab", tabID: quarantined.id }), `close_tab ${quarantined.id}`)
      assert(quarantined.contents.isDestroyed())
    } finally {
      release.resolve()
      if (!quarantined.contents.isDestroyed()) quarantined.view.webContents.debugger.sendCommand = send
    }
    console.log("PASS lifecycle real interrupted key quarantines select but permits consented close")

    if (process.platform === "win32") {
      dialog.showMessageBox = consent
      const request = await prepare({ op: "create_tab" })
      const controller = new AbortController()
      const before = group().tabs.length
      const pending = dispatch(request, task, controller.signal, "real-consent")
      let settled = false
      void pending.then(() => {
        settled = true
      })
      try {
        await setTimeout(200)
        assert(owner.tabConsent && !owner.tabConsent.signal.aborted)
        assert.equal(settled, false)
        assert.equal(win.isEnabled(), true)
        controller.abort()
        denied(await pending)
        await settlements.get("real-consent")
        assert.equal(owner.tabConsent, undefined)
        assert.equal(owner.suspended, 0)
        assert.equal(group().tabs.length, before)
        console.log("PASS real Windows unparented lifecycle consent: AbortSignal closes dialog, zero mutation")
      } finally {
        controller.abort()
        owner.tabConsent?.abort()
        dialog.showMessageBox = controlledConsent
      }
    }
    browserViewport(owner, { sessionID: task, lease: "lifecycle", bounds: null })
    const emptySession = "empty-recovery"
    browserLinkContext(owner, emptySession, emptySession)
    saveTabs({ sessionID: emptySession, tabs: [], active: -1, closed: [] })
    const requestCount = requests.length
    const emptyPrepared = await dispatch({ op: "prepare_tab", request: { op: "create_tab" } }, emptySession)
    assert(emptyPrepared.ok && emptyPrepared.result.tabToken)
    const emptyResult = await dispatch({ op: "create_tab", token: emptyPrepared.result.tabToken }, emptySession)
    assert(emptyResult.ok && emptyResult.result.tabResult)
    const emptyGroup = owner.groups.get(emptySession)!
    assert.equal(emptyGroup.tabs.length, 1)
    const blank = emptyGroup.tabs[0]
    await wait(() => !blank.contents.isLoadingMainFrame() && blank.contents.getURL() === "about:blank")
    assert.equal(blank.id, emptyResult.result.tabResult.tabID)
    assert.equal(blank.agentAccess, false)
    assert.equal(requests.length, requestCount)
    console.log("PASS lifecycle empty recovery creates one private blank without requests")
    console.log(
      `PASS tab lifecycle Electron ${process.versions.electron} Chromium ${process.versions.chrome}; no physical/macOS/packaged assurance`,
    )
  } finally {
    Date.now = clock
    dialogHook = undefined
    askHook = undefined
    stop()
    owner.tabConsent?.abort()
    foreign.tabConsent?.abort()
    dialog.showMessageBox = consent
    dialog.showMessageBoxSync = unloadConsent
    for (const current of [owner, foreign]) {
      for (const entry of current.groups.values()) {
        for (const target of entry.tabs) {
          if (!target.contents.isDestroyed()) {
            // Fixture-owned teardown only, never the agent close path.
            target.view.webContents.close({ waitForBeforeUnload: false })
          }
        }
      }
    }
    win.destroy()
    other.destroy()
    server.closeAllConnections()
    await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())))
  }
}
