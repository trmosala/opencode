import assert from "node:assert/strict"
import { once } from "node:events"
import { createServer } from "node:http"
import { BrowserWindow, dialog, Notification, session } from "electron"
import { browserCommand, browserLinkContext, browserViewport, registerBrowserOwner } from "./tabs"
import { browserOperationBusy } from "./registry"
import { BROWSER_PARTITION } from "./policy"
import { mediaPermission, notificationPermission, practicalPermission, sitePermissions } from "./preferences"
import { getStore } from "../store"

export async function notificationPermissionsSmoke() {
  assert(process.env.CM_BROWSER_SMOKE_PROFILE, "Use the isolated native runner")
  let responseStatus = 200
  const server = createServer((_request, response) => {
    if (responseStatus === 204) {
      response.writeHead(204)
      response.end()
      return
    }
    response.writeHead(200, { "Content-Type": "text/html" })
    response.end("<!doctype html><title>Notification permission fixture</title><p>No notifications are posted.</p>")
  })
  server.listen(0, "127.0.0.1")
  await once(server, "listening")
  const address = server.address()
  assert(address && typeof address === "object")
  const origin = `http://127.0.0.1:${address.port}`
  const url = origin + "/"
  const profile = session.fromPartition(BROWSER_PARTITION)
  const nativeRequest = profile.setPermissionRequestHandler
  const nativeCheck = profile.setPermissionCheckHandler
  const nativeDisplay = profile.setDisplayMediaRequestHandler
  const setRequest = nativeRequest.bind(profile)
  const setCheck = nativeCheck.bind(profile)
  const setDisplay = nativeDisplay.bind(profile)
  let request!: NonNullable<Parameters<typeof setRequest>[0]>
  let check!: NonNullable<Parameters<typeof setCheck>[0]>
  let displayOptions: Electron.DisplayMediaRequestHandlerOpts | undefined
  profile.setPermissionRequestHandler = (handler) => {
    assert(handler)
    request = handler
    setRequest(handler)
  }
  profile.setPermissionCheckHandler = (handler) => {
    assert(handler)
    check = handler
    setCheck(handler)
  }
  profile.setDisplayMediaRequestHandler = (handler, options) => {
    displayOptions = options
    setDisplay(handler, options)
  }
  const win = new BrowserWindow({
    show: false,
    width: 720,
    height: 540,
    webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false },
  })
  const owner = registerBrowserOwner(win)
  const command = (value: Parameters<typeof browserCommand>[2]) => browserCommand(owner, "notifications", value)
  const viewport = () =>
    browserViewport(owner, {
      sessionID: "notifications",
      lease: "notifications",
      bounds: { x: 0, y: 0, width: 600, height: 400 },
    })
  const nativeDialog = dialog.showMessageBox
  let response = 0
  let prompts = 0
  let promptSignal: AbortSignal | undefined
  let pending: ReturnType<typeof Promise.withResolvers<Electron.MessageBoxReturnValue>> | undefined
  dialog.showMessageBox = (async (_win, options) => {
    assert.equal(options?.defaultId, 0)
    assert.equal(options?.cancelId, 0)
    prompts++
    promptSignal = options?.signal
    if (pending) return pending.promise
    return { response, checkboxChecked: false }
  }) as typeof dialog.showMessageBox
  try {
    assert(Notification.isSupported(), "Native notification capability required for this fixture")
    await win.loadURL(url)
    win.showInactive()
    const id = (await command({ op: "new" })).activeID!
    const tab = owner.groups.get("notifications")!.tabs.find((entry) => entry.id === id)!
    const contents = tab.view.webContents
    await contents.loadURL(url)
    viewport()
    const rule = (notifications: "block" | "ask" | "allow") => command({ op: "site-permission", origin, notifications })
    const siteRule = (values: { displayCapture?: "block" | "ask" | "allow"; clipboard?: "block" | "ask" | "allow" }) =>
      command({ op: "site-permission", origin, ...values })
    const details = () => ({ requestingUrl: contents.getURL(), isMainFrame: true })
    const checked = () => check(contents, "notifications", origin, details())
    const realRequest = () => contents.executeJavaScript("Notification.requestPermission()", true)
    const realCheck = () => contents.executeJavaScript("Notification.permission")
    const baseline = () => [
      ...["hide", "minimize", "close", "closed"].map((event) => win.listenerCount(event)),
      ...["did-start-navigation", "render-process-gone", "destroyed"].flatMap((event) => [
        contents.listenerCount(event),
        win.webContents.listenerCount(event),
      ]),
      owner.captureChecks?.size ?? 0,
    ]
    await rule("block")
    assert.equal(await realRequest(), "denied")
    assert.equal(checked(), false)
    const revision = tab.revision
    await contents.executeJavaScript("window.notificationSentinel = 42")
    await rule("allow")
    assert.equal(tab.revision, revision, "Notification-only edits must not reload media")
    assert.equal(await contents.executeJavaScript("window.notificationSentinel"), 42)
    assert.equal(await realRequest(), "granted")
    assert.equal(await realCheck(), "granted")
    assert.equal(checked(), true)
    await rule("block")
    assert.equal(await realCheck(), "denied", "Revocation must affect the property path")
    await rule("ask")
    response = 0
    assert.equal(await realRequest(), "denied")
    assert.equal(notificationPermission(origin), "ask")
    const before = baseline()
    response = 1
    assert.equal(await realRequest(), "granted")
    assert.equal(notificationPermission(origin), "allow")
    assert.equal(await realCheck(), "granted", "Ask Allow must remain usable on recheck")
    assert.deepEqual(baseline(), before, "Successful Ask removes listeners")
    assert.equal(prompts, 2)
    assert.equal(check(null, "notifications", origin, { ...details(), isMainFrame: false }), false)
    assert.equal(check(contents, "notifications", origin, { ...details(), isMainFrame: false }), false)
    assert.equal(check(contents, "notifications", "https://different.invalid", details()), false)
    assert.equal(check(contents, "notifications", origin, { ...details(), requestingUrl: url + "other" }), false)
    assert.deepEqual(displayOptions, { useSystemPicker: true })
    assert.equal(check(contents, "geolocation", origin, details()), false)

    await siteRule({ clipboard: "ask" })
    response = 1
    let clipboardAllowed: boolean | undefined
    request(
      contents,
      "clipboard-read",
      (allowed) => {
        clipboardAllowed = allowed
      },
      details(),
    )
    await new Promise<void>((resolve) => setImmediate(resolve))
    assert.equal(clipboardAllowed, true, "Clipboard Ask must save exact-origin consent")
    assert.equal(practicalPermission(origin, "clipboard"), "allow")
    assert.equal(check(contents, "clipboard-read", origin, details()), true)
    assert.equal(check(contents, "clipboard-sanitized-write", origin, details()), true)
    const clipboardRevision = tab.revision
    await contents.executeJavaScript("window.clipboardSentinel = 42")
    await siteRule({ clipboard: "block" })
    assert.equal(tab.revision, clipboardRevision, "Clipboard revocation must not reload the page")
    assert.equal(await contents.executeJavaScript("window.clipboardSentinel"), 42)
    assert.equal(check(contents, "clipboard-read", origin, details()), false)

    setDisplay((capture, callback) => {
      assert(capture.userGesture)
      assert(capture.frame)
      callback({ video: capture.frame })
    })
    await siteRule({ displayCapture: "ask" })
    await new Promise<void>((resolve) => setImmediate(resolve))
    response = 1
    let displayAllowed: boolean | undefined
    request(
      contents,
      "media",
      (allowed) => {
        displayAllowed = allowed
      },
      { ...details(), mediaTypes: [] },
    )
    await new Promise<void>((resolve) => setImmediate(resolve))
    assert.equal(displayAllowed, true, "Screen-sharing Ask must save exact-origin consent")
    assert.equal(practicalPermission(origin, "displayCapture"), "allow")
    assert.equal(
      check(contents, "display-capture", origin, details()),
      true,
      "Display capture check must allow the saved origin",
    )
    const displayResult = await contents.executeJavaScript(
      "navigator.mediaDevices.getDisplayMedia({ video: true }).then((stream) => { window.displayCapture = stream; window.displayCaptureSentinel = 42; return { ready: stream.getVideoTracks()[0].readyState } }, (error) => ({ name: error.name, message: error.message }))",
      true,
    )
    assert.deepEqual(displayResult, { ready: "live" })
    const captureRevision = tab.revision
    await contents.executeJavaScript("window.onbeforeunload = () => 'stay'; true", true)
    responseStatus = 204
    const revocation = siteRule({ displayCapture: "block" })
    await assert.rejects(command({ op: "stop", tabID: id }), /busy|running/i)
    await revocation
    assert(tab.revision > captureRevision, "Screen-sharing revocation must replace the page")
    assert.equal(await contents.executeJavaScript("window.displayCaptureSentinel"), undefined)
    assert.equal(check(contents, "display-capture", origin, details()), false)
    contents.stop()
    responseStatus = 200
    await contents.loadURL(url)
    if (contents.isLoadingMainFrame()) await once(contents, "did-stop-loading", { signal: AbortSignal.timeout(5_000) })
    await new Promise<void>((resolve) => setImmediate(resolve))
    viewport()
    setDisplay((_capture, callback) => callback({}), { useSystemPicker: true })
    let emptyMedia: boolean | undefined
    request(
      contents,
      "media",
      (allowed) => {
        emptyMedia = allowed
      },
      { ...details(), mediaTypes: [] },
    )
    assert.equal(emptyMedia, false)

    for (const field of ["agentAccess", "loginBusy", "permissionReload", "loadFailed"] as const) {
      tab[field] = true
      assert.equal(checked(), false, field)
      let denied: boolean | undefined
      request(
        contents,
        "notifications",
        (allowed) => {
          denied = allowed
        },
        details(),
      )
      assert.equal(denied, false, field)
      tab[field] = false
    }
    browserOperationBusy.add(tab.id)
    assert.equal(checked(), false)
    browserOperationBusy.delete(tab.id)
    owner.suspended++
    assert.equal(checked(), false)
    owner.suspended--
    const second = (await command({ op: "new" })).activeID!
    await command({ op: "select", tabID: id })
    viewport()

    let mutation = 0
    for (const mutate of [
      async () => {
        await command({ op: "select", tabID: second })
        await command({ op: "select", tabID: id })
      },
      async () => {
        browserViewport(owner, { sessionID: "notifications", lease: "notifications", bounds: null })
        viewport()
      },
      async () => {
        browserLinkContext(owner, "another-task", "other")
        browserLinkContext(owner, "notifications", "notifications")
      },
      async () => {
        await contents.loadURL(origin + "/other")
        await contents.loadURL(url)
        // loadURL resolves at did-finish-load, before Chromium clears its loading flag.
        if (contents.isLoadingMainFrame())
          await once(contents, "did-stop-loading", { signal: AbortSignal.timeout(5_000) })
      },
      async () => {
        await rule("block")
        await rule("ask")
      },
      async () => {
        win.hide()
        await new Promise((resolve) => setTimeout(resolve, 150))
        assert.equal(win.isVisible(), false)
        win.showInactive()
        viewport()
      },
    ]) {
      await rule("ask")
      const before = baseline()
      pending = Promise.withResolvers<Electron.MessageBoxReturnValue>()
      const answers: boolean[] = []
      request(contents, "notifications", (allowed) => answers.push(allowed), details())
      assert.equal(answers.length, 0, `Ask waits for native consent: case ${++mutation}`)
      await mutate()
      assert.deepEqual(answers, [false], `Invalidation settles immediately, exactly once: case ${mutation}`)
      assert.deepEqual(baseline(), before, "Invalidation removes listeners")
      pending.resolve({ response: 1, checkboxChecked: false })
      await pending.promise
      await Promise.resolve()
      pending = undefined
      assert.deepEqual(answers, [false], "Late Allow cannot revive an invalidated Ask")
      assert.notEqual(notificationPermission(origin), "allow")
    }

    const failures: unknown[] = []
    await rule("ask")
    {
      const before = baseline()
      const answers: boolean[] = []
      pending = Promise.withResolvers<Electron.MessageBoxReturnValue>()
      request(contents, "notifications", (allowed) => answers.push(allowed), details())
      assert.equal(answers.length, 0, "Clipped viewport: Ask waits")
      const signal = promptSignal!
      browserViewport(owner, {
        sessionID: "notifications",
        lease: "notifications",
        bounds: { x: win.getContentBounds().width + 1, y: 0, width: 600, height: 400 },
      })
      assert.equal(owner.attached, undefined, "Positive bounds clip to zero and detach")
      const detached = { answers: [...answers], aborted: signal.aborted, listeners: baseline() }
      viewport()
      pending.resolve({ response: 1, checkboxChecked: false })
      await new Promise<void>((resolve) => setImmediate(resolve))
      pending = undefined
      try {
        assert.deepEqual(detached.answers, [false], "Clipped viewport cancels immediately")
        assert.equal(detached.aborted, true, "Clipped viewport aborts dialog")
        assert.deepEqual(detached.listeners, before, "Clipped viewport removes listeners")
        assert.deepEqual(answers, [false], "Clipped viewport ABA cannot revive Ask")
        assert.equal(notificationPermission(origin), "ask")
      } catch (error) {
        console.error("FAIL clipped viewport", error)
        failures.push(error)
      }
    }

    await rule("ask")
    const otherWin = new BrowserWindow({
      show: false,
      width: 720,
      height: 540,
      webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false },
    })
    const otherOwner = registerBrowserOwner(otherWin)
    try {
      await otherWin.loadURL(url)
      otherWin.showInactive()
      const otherID = (await browserCommand(otherOwner, "notifications-other", { op: "new" })).activeID!
      const otherTab = otherOwner.groups.get("notifications-other")!.tabs.find((entry) => entry.id === otherID)!
      await otherTab.view.webContents.loadURL(url)
      if (otherTab.view.webContents.isLoadingMainFrame())
        await once(otherTab.view.webContents, "did-stop-loading", { signal: AbortSignal.timeout(5_000) })
      browserViewport(otherOwner, {
        sessionID: "notifications-other",
        lease: "notifications-other",
        bounds: { x: 0, y: 0, width: 600, height: 400 },
      })
      const before = baseline()
      const answers: boolean[] = []
      pending = Promise.withResolvers<Electron.MessageBoxReturnValue>()
      const original = pending
      request(contents, "notifications", (allowed) => answers.push(allowed), details())
      assert.equal(answers.length, 0, "Cross-owner: original Ask waits")
      const signal = promptSignal!
      pending = Promise.withResolvers<Electron.MessageBoxReturnValue>()
      const otherAnswers: boolean[] = []
      request(otherTab.view.webContents, "notifications", (allowed) => otherAnswers.push(allowed), {
        requestingUrl: url,
        isMainFrame: true,
      })
      assert.equal(otherAnswers.length, 0, "Cross-owner: second Ask waits")
      pending.resolve({ response: 1, checkboxChecked: false })
      await new Promise<void>((resolve) => setImmediate(resolve))
      assert.deepEqual(otherAnswers, [true])
      assert.equal(notificationPermission(origin), "allow")
      try {
        assert.deepEqual(answers, [false], "Cross-owner persistence cancels original immediately")
        assert.equal(signal.aborted, true, "Cross-owner persistence aborts original dialog")
        assert.deepEqual(baseline(), before, "Cross-owner persistence removes original listeners")
      } catch (error) {
        console.error("FAIL cross-owner persistence", error)
        failures.push(error)
      } finally {
        original.resolve({ response: 1, checkboxChecked: false })
        await new Promise<void>((resolve) => setImmediate(resolve))
        pending = undefined
      }
      assert.deepEqual(answers, [false], "Cross-owner late Allow settles original exactly once")
      assert.deepEqual(baseline(), before)

      await rule("ask")
      pending = Promise.withResolvers<Electron.MessageBoxReturnValue>()
      const closedAnswers: boolean[] = []
      request(otherTab.view.webContents, "notifications", (allowed) => closedAnswers.push(allowed), {
        requestingUrl: url,
        isMainFrame: true,
      })
      assert.deepEqual(closedAnswers, [], "Close: Ask waits")
      const closeSignal = promptSignal!
      const destroyed = once(otherTab.view.webContents, "destroyed", { signal: AbortSignal.timeout(5_000) })
      await browserCommand(otherOwner, "notifications-other", { op: "close", tabID: otherID })
      await destroyed
      assert.deepEqual(closedAnswers, [false], "Close cancels pending Ask")
      assert.equal(closeSignal.aborted, true)
      assert.equal(otherOwner.captureChecks?.size ?? 0, 0)
      pending.resolve({ response: 1, checkboxChecked: false })
      await new Promise<void>((resolve) => setImmediate(resolve))
      pending = undefined
      assert.deepEqual(closedAnswers, [false], "Close ignores late Allow")
      assert.equal(notificationPermission(origin), "ask")
    } finally {
      try {
        await Promise.all(
          [...otherOwner.groups.values()]
            .flatMap((group) => group.tabs)
            .map(async (tab) => {
              const contents = tab.view.webContents
              if (contents.isDestroyed()) return
              const destroyed = once(contents, "destroyed", { signal: AbortSignal.timeout(5_000) })
              contents.close()
              await destroyed
            }),
        )
      } finally {
        if (!otherWin.isDestroyed()) otherWin.destroy()
      }
    }
    if (failures.length) throw new AggregateError(failures, "Notification lifecycle regressions")

    const storage = getStore("cm-browser")
    const legacyOrigin = "https://legacy.invalid"
    storage.set("sites", [{ origin: legacyOrigin, camera: "allow", microphone: "ask" }])
    assert.equal(notificationPermission(legacyOrigin), "block")
    await command({ op: "site-permission", origin: legacyOrigin, notifications: "allow" })
    assert.deepEqual(sitePermissions(), [
      {
        origin: legacyOrigin,
        camera: "allow",
        microphone: "ask",
        notifications: "allow",
        displayCapture: "block",
        clipboard: "block",
      },
    ])
    await command({ op: "site-permission", origin: legacyOrigin, camera: "block" })
    assert.deepEqual(sitePermissions(), [
      {
        origin: legacyOrigin,
        camera: "block",
        microphone: "ask",
        notifications: "allow",
        displayCapture: "block",
        clipboard: "block",
      },
    ])
    const saved = storage.get("sites")
    const nativeSet = storage.set
    let writes = 0
    storage.set = ((...args: Parameters<typeof nativeSet>) => {
      writes++
      return nativeSet.apply(storage, args)
    }) as typeof nativeSet
    try {
      for (const field of ["camera", "microphone", "notifications", "displayCapture", "clipboard"])
        for (const value of [null, true, 1, "yes", {}, []])
          await assert.rejects(command({ op: "site-permission", origin: legacyOrigin, [field]: value }))
      await assert.rejects(command({ op: "site-permission", origin: legacyOrigin }))
      assert.equal(writes, 0, "Invalid runtime values never write")
      assert.deepEqual(storage.get("sites"), saved)
    } finally {
      storage.set = nativeSet
    }

    const corrupt = [{ origin, camera: "allow", microphone: "allow", notifications: true }]
    getStore("cm-browser").set("sites", corrupt)
    assert.deepEqual(sitePermissions(), [])
    assert.equal(mediaPermission(origin, "audio"), "block")
    assert.equal(notificationPermission(origin), "block")
    assert.equal(checked(), false)
    assert.equal(await realRequest(), "denied")
    await assert.rejects(rule("allow"))
    assert.deepEqual(getStore("cm-browser").get("sites"), corrupt, "Corruption is preserved, not repaired")
    assert.equal(owner.captureChecks?.size ?? 0, 0)
    console.log("PASS site permissions: notification, clipboard and display capture lifecycle, saved rules, corruption")
  } finally {
    pending?.resolve({ response: 0, checkboxChecked: false })
    dialog.showMessageBox = nativeDialog
    profile.setPermissionRequestHandler = nativeRequest
    profile.setPermissionCheckHandler = nativeCheck
    profile.setDisplayMediaRequestHandler = nativeDisplay
    try {
      await Promise.all(
        [...owner.groups.values()]
          .flatMap((group) => group.tabs)
          .map(async (tab) => {
            const contents = tab.view.webContents
            if (contents.isDestroyed()) return
            const destroyed = once(contents, "destroyed", { signal: AbortSignal.timeout(5_000) })
            contents.close()
            await destroyed
          }),
      )
    } finally {
      if (!win.isDestroyed()) win.destroy()
      server.closeAllConnections()
      await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())))
    }
  }
}
