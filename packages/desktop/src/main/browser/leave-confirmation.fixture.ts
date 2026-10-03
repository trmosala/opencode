import assert from "node:assert/strict"
import { once } from "node:events"
import { createServer } from "node:http"
import { dialog, type BrowserWindow, type WebContents } from "electron"
import { browserCommand } from "./tabs"
import { browserRegistration } from "./registry"
import { startBrowserOperation } from "./operation-state"
import { success } from "@cookiemonster/cm-browser/protocol"

export async function leaveConfirmationSmoke(
  win: BrowserWindow,
  url: string,
  command: (value: Parameters<typeof browserCommand>[2]) => ReturnType<typeof browserCommand>,
) {
  const original = dialog.showMessageBox
  let progress = 0
  try {
    for (const response of [0, 1]) {
      const tabID = (await command({ op: "new" })).activeID!
      const tab = browserRegistration("smoke", tabID)!
      const contents = tab.contents as WebContents
      await contents.loadURL(url)
      win.show()
      contents.focus()
      assert.equal(
        await contents.executeJavaScript(
          "window.onbeforeunload = () => 'unsaved'; navigator.userActivation.hasBeenActive",
          true,
        ),
        true,
      )
      const answer = Promise.withResolvers<{ response: number; checkboxChecked: boolean }>()
      let shown = false
      let dialogs = 0
      dialog.showMessageBox = ((_owner, options) => {
        shown = true
        dialogs++
        options?.signal?.addEventListener("abort", () => answer.resolve({ response: 0, checkboxChecked: false }), {
          once: true,
        })
        return answer.promise
      }) as typeof dialog.showMessageBox
      const ticks = setInterval(() => progress++, 5)
      const target = `${url}?leave=${response}`
      const navigation = command({ op: "navigate", tabID, url: target })
      await wait(() => shown)
      await assert.rejects(command({ op: "navigate", tabID, url: `${url}?competing=${response}` }))
      await new Promise((resolve) => setTimeout(resolve, 30))
      assert(progress > 0, "Main process must continue while leave confirmation is open")
      assert.notEqual(contents.getURL(), target)
      assert.equal(dialogs, 1, "A competing navigation must not open a second confirmation")
      answer.resolve({ response, checkboxChecked: false })
      if (response === 1) {
        await navigation
        assert.equal(contents.getURL(), target)
      } else {
        await navigation
        assert.equal(contents.getURL(), url)
      }
      clearInterval(ticks)
      await contents.executeJavaScript("window.onbeforeunload = null")
      await command({ op: "close", tabID })
    }
    const closeTabID = (await command({ op: "new" })).activeID!
    const closeTab = browserRegistration("smoke", closeTabID)!
    const closeContents = closeTab.contents as WebContents
    await closeContents.loadURL(url)
    await closeContents.executeJavaScript(
      "window.onbeforeunload = () => 'unsaved'; navigator.userActivation.hasBeenActive",
      true,
    )
    const closeAnswer = Promise.withResolvers<{ response: number; checkboxChecked: boolean }>()
    let closePrompt = false
    dialog.showMessageBox = ((_owner, options) => {
      closePrompt = true
      options?.signal?.addEventListener("abort", () => closeAnswer.resolve({ response: 0, checkboxChecked: false }), {
        once: true,
      })
      return closeAnswer.promise
    }) as typeof dialog.showMessageBox
    const closing = command({ op: "close", tabID: closeTabID })
    await wait(() => closePrompt)
    assert.equal(closeContents.isDestroyed(), false, "A held close must leave its tab alive")
    closeAnswer.resolve({ response: 1, checkboxChecked: false })
    await closing
    assert.equal(browserRegistration("smoke", closeTabID), undefined, "Leave must complete the requested close")
    const untrackedTabID = (await command({ op: "new" })).activeID!
    const untrackedTab = browserRegistration("smoke", untrackedTabID)!
    const untrackedContents = untrackedTab.contents as WebContents
    await untrackedContents.loadURL(url)
    await untrackedContents.executeJavaScript(
      "window.onbeforeunload = () => 'unsaved'; navigator.userActivation.hasBeenActive",
      true,
    )
    let untrackedDialog = false
    dialog.showMessageBox = (async () => {
      untrackedDialog = true
      return { response: 0, checkboxChecked: false }
    }) as typeof dialog.showMessageBox
    const overlapping = startBrowserOperation(untrackedTab, "click", new AbortController().signal)
    await untrackedContents.executeJavaScript("window.location.href = location.href + '?page-requested'")
    await new Promise((resolve) => setTimeout(resolve, 100))
    assert.equal(untrackedContents.getURL(), url, "Unknown page-originated navigation must remain vetoed")
    assert.equal(untrackedTab.notice?.code, "untracked_leave")
    assert.equal(untrackedDialog, false, "Unknown page requests must not be offered a Leave replay")
    overlapping.report(success({ tabID: untrackedTabID, url, title: "", visibleText: "", elements: [] }))
    overlapping.finish()
    assert.equal(untrackedTab.operation, undefined)
    assert.equal(untrackedTab.notice?.code, "untracked_leave", "Operation settlement must preserve page leave guidance")
    await untrackedContents.executeJavaScript("window.onbeforeunload = null")
    await command({ op: "close", tabID: untrackedTabID })
    const anchorID = (await command({ op: "new" })).activeID!
    const bulkIDs: string[] = []
    for (const _index of [0, 1]) {
      const id = (await command({ op: "new" })).activeID!
      const page = browserRegistration("smoke", id)!.contents as WebContents
      await page.loadURL(url)
      await page.executeJavaScript("window.onbeforeunload = () => 'unsaved'; true", true)
      bulkIDs.push(id)
    }
    let bulkPrompts = 0
    dialog.showMessageBox = (async () => {
      bulkPrompts++
      return { response: 0, checkboxChecked: false }
    }) as typeof dialog.showMessageBox
    await command({ op: "close-tabs", tabID: anchorID, scope: "right" })
    assert.equal(bulkPrompts, 1, "Stay must end the close batch without prompting later targets")
    assert(
      bulkIDs.every((id) => browserRegistration("smoke", id)),
      "Stay preserves the requested tabs",
    )
    bulkPrompts = 0
    dialog.showMessageBox = (async () => {
      bulkPrompts++
      return { response: 1, checkboxChecked: false }
    }) as typeof dialog.showMessageBox
    await command({ op: "close-tabs", tabID: anchorID, scope: "right" })
    assert.equal(bulkPrompts, 2, "Each unsaved target gets one sequential confirmation")
    assert(
      bulkIDs.every((id) => !browserRegistration("smoke", id)),
      "Leave closes the captured targets once",
    )
    await command({ op: "close", tabID: anchorID })
    const historyTabID = (await command({ op: "new" })).activeID!
    const historyTab = browserRegistration("smoke", historyTabID)!
    const historyContents = historyTab.contents as WebContents
    await historyContents.loadURL(url)
    await historyContents.loadURL(`${url}?history`)
    await historyContents.executeJavaScript(
      "window.onbeforeunload = () => 'unsaved'; navigator.userActivation.hasBeenActive",
      true,
    )
    await leaveWithConfirmation(() => command({ op: "back", tabID: historyTabID }))
    assert.equal(historyContents.getURL(), url, "Leave must complete the captured back-history intent")
    await historyContents.executeJavaScript(
      "window.onbeforeunload = () => 'unsaved'; navigator.userActivation.hasBeenActive",
      true,
    )
    await leaveWithConfirmation(() => command({ op: "forward", tabID: historyTabID }))
    assert.equal(historyContents.getURL(), `${url}?history`, "Leave must complete the captured forward-history intent")
    await historyContents.executeJavaScript(
      "window.onbeforeunload = () => 'unsaved'; navigator.userActivation.hasBeenActive",
      true,
    )
    await leaveWithConfirmation(() => command({ op: "reload", tabID: historyTabID }))
    assert.equal(historyContents.getURL(), `${url}?history`, "Leave must complete the captured reload intent")
    await command({ op: "close", tabID: historyTabID })
    const tabID = (await command({ op: "new" })).activeID!
    const tab = browserRegistration("smoke", tabID)!
    const contents = tab.contents as WebContents
    await contents.loadURL(url)
    win.show()
    contents.focus()
    assert.equal(
      await contents.executeJavaScript(
        "window.onbeforeunload = () => 'unsaved'; navigator.userActivation.hasBeenActive",
        true,
      ),
      true,
    )
    const answer = Promise.withResolvers<{ response: number; checkboxChecked: boolean }>()
    let shown = false
    dialog.showMessageBox = ((_owner, options) => {
      shown = true
      options?.signal?.addEventListener("abort", () => answer.resolve({ response: 0, checkboxChecked: false }), {
        once: true,
      })
      return answer.promise
    }) as typeof dialog.showMessageBox
    const cancelled = command({ op: "navigate", tabID, url: `${url}?cancelled` })
    await wait(() => shown)
    win.hide()
    await cancelled
    assert.equal(contents.getURL(), url)
    await contents.executeJavaScript("window.onbeforeunload = null")
    await command({ op: "close", tabID })
    await pageLeaveRequestsSmoke(win, command)
    console.log(
      "PASS native beforeunload Stay/Leave/close/history/reload/cancel, concurrent intent and untracked-page veto; main process responsive",
    )
  } finally {
    dialog.showMessageBox = original
    if (!win.isDestroyed()) win.hide()
  }
}

async function pageLeaveRequestsSmoke(
  win: BrowserWindow,
  command: (value: Parameters<typeof browserCommand>[2]) => ReturnType<typeof browserCommand>,
) {
  const requests: { method: string; url: string; body: string }[] = []
  const server = createServer((request, response) => {
    let body = ""
    request.setEncoding("utf8")
    request.on("data", (value: string) => (body += value))
    request.on("end", () => {
      requests.push({ method: request.method!, url: request.url!, body })
      response.setHeader("Content-Type", "text/html; charset=utf-8")
      response.end(`<!doctype html><title>Unsaved fixture</title>
        <a id="leave" href="/target">Leave link</a>
        <form id="form" action="/target" method="post">
          <input name="note" value="draft"><button>Submit</button>
        </form>`)
    })
  })
  server.listen(0, "127.0.0.1")
  await once(server, "listening")
  const address = server.address()
  assert(address && typeof address !== "string")
  const origin = `http://127.0.0.1:${address.port}`
  try {
    for (const action of ["link", "get", "post"]) {
      console.log("Page leave case", action)
      const tabID = (await command({ op: "new" })).activeID!
      const tab = browserRegistration("smoke", tabID)!
      const contents = tab.contents as WebContents
      const dialogs: { method: string; type?: string; result?: boolean; hasBrowserHandler?: boolean }[] = []
      const observed = (_event: Electron.Event, method: string, params: Record<string, unknown>) => {
        if (method === "Page.javascriptDialogOpening")
          dialogs.push({ method, type: String(params.type), hasBrowserHandler: params.hasBrowserHandler === true })
        if (method === "Page.javascriptDialogClosed") dialogs.push({ method, result: params.result === true })
      }
      let progress = 0
      const ticks = setInterval(() => progress++, 5)
      try {
        await contents.loadURL(`${origin}/source?case=${action}`)
        if (!contents.debugger.isAttached()) contents.debugger.attach("1.3")
        contents.debugger.on("message", observed)
        await contents.debugger.sendCommand("Page.enable")
        win.show()
        contents.focus()
        await contents.executeJavaScript(
          `document.querySelector('input').value = 'unsaved + & ü';
           document.querySelector('form').method = ${JSON.stringify(action === "get" ? "get" : "post")};
           window.onbeforeunload = () => 'unsaved'; true`,
          true,
        )
        const priorProgress = progress
        const start = requests.length
        await contents.executeJavaScript(
          action === "link" ? "document.querySelector('a').click()" : "document.querySelector('form').requestSubmit()",
          true,
        )
        await wait(() => dialogs.some((entry) => entry.method === "Page.javascriptDialogClosed"))
        console.log("Page leave veto observed", action)
        assert.equal(contents.getURL(), `${origin}/source?case=${action}`)
        assert.equal(tab.notice?.code, "untracked_leave")
        assert.equal(await contents.executeJavaScript("document.querySelector('input').value"), "unsaved + & ü")
        assert.equal(
          requests.slice(start).some((entry) => entry.url.startsWith("/target")),
          false,
        )
        assert.deepEqual(dialogs, [
          { method: "Page.javascriptDialogOpening", type: "beforeunload", hasBrowserHandler: true },
          { method: "Page.javascriptDialogClosed", result: false },
        ])
        // Electron 44 resolves its native callback synchronously. CDP observes it but cannot retain it for Leave.
        await assert.rejects(
          contents.debugger.sendCommand("Page.handleJavaScriptDialog", { accept: true }),
          /No dialog is showing/,
        )
        assert.equal((await fetch(`${origin}/progress`)).status, 200)
        assert(progress > priorProgress, "Main process progresses while a page-origin request is vetoed")
        assert.equal(
          contents.getURL(),
          `${origin}/source?case=${action}`,
          "A late CDP answer must not replay a request",
        )
        // A new explicit fixture submission, without beforeunload, proves the witness sees the original native body.
        await contents.executeJavaScript(
          `window.onbeforeunload = null;
           ${action === "link" ? "document.querySelector('a').click()" : "document.querySelector('form').requestSubmit()"}`,
          true,
        )
        await wait(() => requests.slice(start).some((entry) => entry.url.startsWith("/target")))
        await wait(() => contents.getURL().startsWith(`${origin}/target`))
        console.log("Page leave explicit request completed", action)
        const completed = requests.slice(start).filter((entry) => entry.url.startsWith("/target"))
        assert.equal(completed.length, 1, "Only the new explicit page request reaches the server once")
        assert.equal(completed[0].method, action === "post" ? "POST" : "GET")
        if (action !== "link")
          assert.equal(
            new URLSearchParams(action === "post" ? completed[0].body : new URL(completed[0].url, origin).search).get(
              "note",
            ),
            "unsaved + & ü",
          )
      } finally {
        clearInterval(ticks)
        contents.debugger.removeListener("message", observed)
        if (!contents.isDestroyed()) await contents.executeJavaScript("window.onbeforeunload = null")
        await command({ op: "close", tabID })
      }
    }
    console.log(
      "PASS native page link/GET form/POST veto preserves drafts; no late CDP replay; independent main HTTP progress",
    )
  } finally {
    await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())))
  }
}

async function wait(check: () => boolean) {
  for (let attempt = 0; attempt < 100; attempt++) {
    if (check()) return
    await new Promise((resolve) => setTimeout(resolve, 10))
  }
  throw new Error("Leave confirmation fixture timed out")
}

async function leaveWithConfirmation(action: () => Promise<unknown>) {
  const started = Date.now()
  const answer = Promise.withResolvers<{ response: number; checkboxChecked: boolean }>()
  let shown = false
  dialog.showMessageBox = ((_owner, options) => {
    shown = true
    options?.signal?.addEventListener("abort", () => answer.resolve({ response: 0, checkboxChecked: false }), {
      once: true,
    })
    return answer.promise
  }) as typeof dialog.showMessageBox
  const operation = action()
  await wait(() => shown)
  answer.resolve({ response: 1, checkboxChecked: false })
  await operation
  assert(Date.now() - started < 5000, "A vetoed native navigation must settle without the fallback timeout")
}
