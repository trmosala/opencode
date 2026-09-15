import assert from "node:assert/strict"
import { createServer } from "node:http"
import { join } from "node:path"
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs"
import { app, BrowserWindow, dialog, session, safeStorage, powerMonitor, shell } from "electron"
import {
  browserCommand,
  browserPageContext,
  browserViewport,
  registerBrowserOwner,
  browserLinkContext,
  openBrowserLink,
  browserLinkMenu,
} from "./tabs"
import { browserRegistration } from "./registry"
import { routeBrowserRequest } from "./router"
import { browserPreferences, browserURL, BROWSER_PARTITION } from "./policy"
import type { Request } from "@cookiemonster/cm-browser/protocol"
import { browserViewportBounds } from "../../../../app/src/components/browser-panel/browser-viewport"
import { browserProfile, clearBrowserData, saveLogins } from "./profile"
import { snapshotScript } from "./snapshot"
import { browserPreferencesState, downloadDirectory, downloadHistory, mediaOrigin } from "./preferences"
import { getStore } from "../store"
import { readLogins } from "./vault"
import { loginEntry, decodeLoginEntry } from "./login-entry"
import { prepareLoginScript, completeLoginScript } from "./login-form"
import { vaultAuthentication } from "./vault-auth"
import { vaultAccess } from "./vault-session"
import { savedTabs } from "./tab-recovery"
import { bookmarks } from "./bookmarks"
import { parseBookmarks } from "./bookmark-format"

const profile = process.env.CM_BROWSER_SMOKE_PROFILE
if (!profile) throw new Error("Run bun scripts/browser-smoke.ts; never use a real profile")
mkdirSync(join(profile, "profile"), { recursive: true })
mkdirSync(join(profile, "session"), { recursive: true })
app.setPath("userData", join(profile, "profile"))
app.setPath("sessionData", join(profile, "session"))
app.on("window-all-closed", () => {})
app.commandLine.appendSwitch("use-fake-device-for-media-stream")
const userAgents = new Map<string, string>()
const server = createServer((request, response) => {
  userAgents.set(request.url ?? "/", request.headers["user-agent"] ?? "")
  if (request.url?.startsWith("/download")) {
    response.writeHead(200, {
      "Content-Type": "application/octet-stream",
      "Content-Disposition": 'attachment; filename="fixture.txt"',
      "Content-Length": request.url === "/download" ? "16" : "100000",
    })
    response.write(request.url === "/download" ? "browser download" : "x".repeat(4096))
    if (request.url === "/download") response.end()
    if (request.url === "/download-fail") setTimeout(() => response.destroy(), 50)
    return
  }
  if (request.url === "/fail") {
    request.socket.destroy()
    return
  }
  if (request.url === "/redirect") {
    response.writeHead(302, { location: "http://blocked.invalid/" })
    response.end()
    return
  }
  response.writeHead(200, { "Content-Type": "text/html" })
  response.end(`<!doctype html><title>Fixture</title>
    <p id="text">Selected text</p><input id="input"><button id="open" onclick="window.child=window.open('/popup','child')">Popup</button>
    <div style="height:2000px"></div>`)
})
const wait = async (check: () => boolean | Promise<boolean>) => {
  for (let i = 0; i < 100; i++) {
    if (await check()) return
    await new Promise((resolve) => setTimeout(resolve, 30))
  }
  throw new Error("Native smoke condition timed out")
}

const stage = (value: string) => writeFileSync(join(profile!, "stage.txt"), value)

async function accountSmoke(
  win: BrowserWindow,
  command: (value: Parameters<typeof browserCommand>[2]) => ReturnType<typeof browserCommand>,
  url: string,
  username: string,
) {
  stage("account management")
  const entryPrompt = loginEntry.prompt
  const accountConsent = dialog.showMessageBox
  const entry = { origin: new URL(url).origin, username: "entry-user", password: "entry-secret" }
  try {
    loginEntry.prompt = async () => undefined
    await command({ op: "edit-login", origin: url })
    assert.equal(readLogins().length, 1)
    loginEntry.prompt = async () => entry
    dialog.showMessageBox = (async (_win, options) => {
      assert.equal(options?.defaultId, 0)
      assert.equal(options?.cancelId, 0)
      assert(!JSON.stringify(options).includes(entry.password))
      return { response: 0, checkboxChecked: false }
    }) as typeof dialog.showMessageBox
    await command({ op: "edit-login", origin: url })
    assert.equal(readLogins().length, 1)
    dialog.showMessageBox = accountConsent
    const created = await command({ op: "edit-login", origin: url })
    assert(!JSON.stringify(created).includes(entry.password))
    const account = created.profile!.credentials.find((row) => row.username === entry.username)!
    assert(account)
    await assert.rejects(command({ op: "edit-login", origin: url }))
    assert.equal(readLogins().length, 2)
    await assert.rejects(command({ op: "edit-login", origin: "http://unsafe.example" }))
    await assert.rejects(command({ op: "edit-login", origin: "https://other.example", id: account.id }))
    loginEntry.prompt = async () => ({ ...entry, username: "edited-user", password: "edited-secret" })
    await command({ op: "edit-login", origin: url, id: account.id })
    assert.equal(readLogins().find((row) => row.id === account.id)?.password, "edited-secret")
    assert.equal(readLogins().find((row) => row.id === account.id)?.username, "edited-user")
    loginEntry.prompt = async () => ({ ...entry, username })
    await assert.rejects(command({ op: "edit-login", origin: url, id: account.id }))
    loginEntry.prompt = async () => ({ ...entry, password: "" })
    await assert.rejects(command({ op: "edit-login", origin: url, id: account.id }))
    loginEntry.prompt = async () => {
      await assert.rejects(command({ op: "edit-login", origin: url }))
      saveLogins([{ ...entry, username: "edited-user", password: "concurrent-secret" }])
      return entry
    }
    await assert.rejects(command({ op: "edit-login", origin: url, id: account.id }))
    assert.equal(readLogins().find((row) => row.username === "edited-user")?.password, "concurrent-secret")
    loginEntry.prompt = async () => {
      vaultAccess.lock()
      await vaultAccess.unlock(win)
      return entry
    }
    await assert.rejects(command({ op: "edit-login", origin: url }))
    loginEntry.prompt = async () => entry
    dialog.showMessageBox = (async () => {
      vaultAccess.lock()
      await vaultAccess.unlock(win)
      return { response: 1, checkboxChecked: false }
    }) as typeof dialog.showMessageBox
    await assert.rejects(command({ op: "edit-login", origin: url }))
    assert.equal(readLogins().length, 2)
    dialog.showMessageBox = accountConsent
    await command({ op: "forget-login", id: readLogins().find((row) => row.username === "edited-user")!.id })
    vaultAccess.lock()
    await assert.rejects(command({ op: "edit-login", origin: url }))
    await vaultAccess.unlock(win)
  } finally {
    loginEntry.prompt = entryPrompt
    dialog.showMessageBox = accountConsent
  }
}

async function run() {
  stage("waiting for Electron ready")
  await app.whenReady()
  stage("Electron ready")
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve))
  const address = server.address()
  assert(address && typeof address !== "string")
  const url = `http://127.0.0.1:${address.port}/`
  const win = new BrowserWindow({
    width: 1000,
    height: 750,
    show: false,
    webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false, backgroundThrottling: false },
  })
  const owner = registerBrowserOwner(win)
  stage("loading owner")
  await win.loadURL(url)
  stage("creating first tab")
  win.showInactive()
  const command = (value: Parameters<typeof browserCommand>[2]) => browserCommand(owner, "smoke", value)
  if (process.argv.includes("--accounts")) {
    const verify = vaultAuthentication.verify
    const consent = dialog.showMessageBox
    try {
      assert.throws(() => readLogins())
      vaultAuthentication.verify = async () => {
        throw new Error("fixture cancellation")
      }
      await assert.rejects(command({ op: "unlock-vault" }))
      assert.equal(vaultAccess.status(), "locked")
      vaultAuthentication.verify = async () => {}
      dialog.showMessageBox = (async () => ({ response: 1, checkboxChecked: false })) as typeof dialog.showMessageBox
      await command({ op: "unlock-vault" })
      saveLogins([{ origin: url, username: "fixture-user", password: "fixture-secret" }])
      await accountSmoke(win, command, url, "fixture-user")
      stage("native account response decoding")
      const unicode = {
        origin: new URL(url).origin,
        username: "fixture-\u00e9\u4e2d",
        password: "secret-\ud83d\udd12\n ",
      }
      const userBytes = Buffer.from(unicode.username, "utf16le")
      const passwordBytes = Buffer.from(unicode.password, "utf16le")
      const header = Buffer.alloc(8)
      header.writeUInt32LE(userBytes.length, 0)
      header.writeUInt32LE(passwordBytes.length, 4)
      const frame = Buffer.concat([header, userBytes, passwordBytes])
      assert.deepEqual(decodeLoginEntry(unicode.origin, frame), unicode)
      for (const invalid of [
        Buffer.alloc(0),
        frame.subarray(0, 7),
        frame.subarray(0, -1),
        Buffer.concat([frame, Buffer.alloc(2)]),
        Buffer.alloc(8),
      ]) {
        assert.throws(
          () => decodeLoginEntry(unicode.origin, invalid),
          (error: unknown) => {
            assert(error instanceof Error)
            assert(!error.message.includes(unicode.password))
            return true
          },
        )
      }
      const oddLength = Buffer.from(frame)
      oddLength.writeUInt32LE(1, 0)
      assert.throws(() => decodeLoginEntry(unicode.origin, oddLength))
      const oversized = Buffer.from(frame)
      oversized.writeUInt32LE(1028, 0)
      assert.throws(() => decodeLoginEntry(unicode.origin, oversized))
      frame.fill(0)
      passwordBytes.fill(0)
      stage("vault failure preservation")
      const storage = getStore("cm-browser")
      const original = storage.store
      const vault = storage.get("vault") as Record<string, unknown>
      for (const corrupt of [
        { ...vault, key: Buffer.from("lost-key").toString("base64") },
        { ...vault, data: Buffer.from("corrupt").toString("base64") },
        { ...vault, version: 99 },
      ]) {
        storage.set("vault", corrupt)
        assert.throws(() => readLogins())
        assert.throws(() => saveLogins([{ origin: url, username: "wrong", password: "wrong" }]))
        assert.deepEqual(storage.get("vault"), corrupt)
      }
      storage.store = original
      Object.defineProperty(storage, "store", {
        configurable: true,
        get: () => original,
        set: () => {
          throw new Error("fixture interrupted write")
        },
      })
      try {
        assert.throws(() => saveLogins([{ origin: url, username: "wrong", password: "wrong" }]))
      } finally {
        Reflect.deleteProperty(storage, "store")
      }
      assert.deepEqual(storage.store, original)
      assert.equal(readLogins()[0].password, "fixture-secret")
      storage.store = {
        credentials: [
          {
            origin: new URL(url).origin,
            username: "legacy",
            encrypted: safeStorage.encryptString("legacy-secret").toString("base64"),
          },
        ],
      }
      const legacy = storage.store
      Object.defineProperty(storage, "store", {
        configurable: true,
        get: () => legacy,
        set: () => {
          throw new Error("fixture interrupted migration")
        },
      })
      try {
        assert.throws(() => readLogins())
      } finally {
        Reflect.deleteProperty(storage, "store")
      }
      assert.deepEqual(storage.store, legacy)
      assert.equal(readLogins()[0].password, "legacy-secret")
      assert.equal(storage.has("credentials"), false)
      assert(!readFileSync(join(profile!, "profile", "cm-browser"), "utf8").includes("legacy-secret"))
      assert(!JSON.stringify(browserProfile()).includes("legacy-secret"))
      stage("PASS focused accounts and vault")
    } finally {
      vaultAccess.lock()
      vaultAuthentication.verify = verify
      dialog.showMessageBox = consent
      win.destroy()
    }
    return
  }
  const route = (request: Request) =>
    routeBrowserRequest(
      {
        type: "browser_request",
        id: "smoke",
        sessionID: "smoke",
        request,
      },
      (candidate) => candidate.startsWith(url),
    )
  const first = (await command({ op: "new" })).activeID!
  await command({ op: "navigate", tabID: first, url })
  const one = owner.groups.get("smoke")!.tabs.find((tab) => tab.id === first)!
  browserViewport(owner, { sessionID: "smoke", lease: "first", bounds: { x: 0, y: 100, width: 800, height: 500 } })
  assert.equal(owner.attached, one)

  stage("session switching")
  const other = await browserCommand(owner, "other-session", { op: "new" })
  browserViewport(owner, {
    sessionID: "other-session",
    lease: "other",
    bounds: { x: 0, y: 100, width: 800, height: 500 },
  })
  assert.equal(owner.attached?.id, other.activeID)
  browserViewport(owner, { sessionID: "smoke", lease: "first", bounds: { x: 0, y: 100, width: 800, height: 500 } })
  assert.equal(owner.attached, one)
  await browserCommand(owner, "other-session", { op: "close", tabID: other.activeID! })
  await one.view.webContents.executeJavaScript(
    "window.marker=42; document.querySelector('#input').value='retained'; scrollTo(0,200)",
  )
  stage("creating second tab")
  const second = (await command({ op: "new" })).activeID!
  await command({ op: "navigate", tabID: second, url })
  const two = owner.groups.get("smoke")!.tabs.find((tab) => tab.id === second)!
  await two.view.webContents.executeJavaScript("window.marker=99")
  assert.equal(owner.attached, two)
  await command({ op: "select", tabID: first })
  assert.equal(await one.view.webContents.executeJavaScript("window.marker"), 42)
  assert.equal(await two.view.webContents.executeJavaScript("window.marker"), 99)
  stage("browser keyboard routing")
  const shortcuts: unknown[] = []
  const send = win.webContents.send.bind(win.webContents)
  win.webContents.send = (channel, ...args) => {
    if (channel === "browser-shortcut") shortcuts.push(args[0])
    send(channel, ...args)
  }
  let prevented = false
  const input = { type: "keyDown", key: "l", control: true, meta: false, alt: false, shift: false }
  one.view.webContents.emit(
    "before-input-event",
    {
      preventDefault: () => {
        prevented = true
      },
    },
    input,
  )
  assert.equal(prevented, true)
  assert.deepEqual(shortcuts, [{ sessionID: "smoke", shortcut: "address" }])
  two.view.webContents.emit(
    "before-input-event",
    { preventDefault: () => assert.fail("Inactive tab intercepted shortcut") },
    input,
  )
  assert.equal(shortcuts.length, 1)
  win.webContents.send = send
  assert.equal(await one.view.webContents.executeJavaScript("document.querySelector('#input').value"), "retained")
  browserViewport(owner, { sessionID: "smoke", lease: "first", bounds: null })
  assert.equal(owner.attached, undefined)
  assert.equal(one.view.webContents.isDestroyed(), false)
  browserViewport(owner, { sessionID: "smoke", lease: "second", bounds: { x: 0, y: 100, width: 800, height: 500 } })
  browserViewport(owner, { sessionID: "smoke", lease: "first", bounds: null })
  assert.equal(owner.attached, one)

  stage("window hide and restore")
  win.hide()
  assert.equal(owner.attached, undefined)
  win.showInactive()
  await wait(() => owner.attached === one)

  stage("partition isolation")
  assert.equal(one.view.webContents.session, two.view.webContents.session)
  assert.equal(one.view.webContents.session, session.fromPartition(BROWSER_PARTITION))
  assert.notEqual(one.view.webContents.session, session.defaultSession)
  assert.notEqual(one.view.webContents.session, session.fromPartition("persist:wpp"))
  await one.view.webContents.session.cookies.set({ url, name: "smoke", value: "isolated" })
  assert.equal((await two.view.webContents.session.cookies.get({ url, name: "smoke" }))[0].value, "isolated")
  assert.equal((await session.defaultSession.cookies.get({ url, name: "smoke" })).length, 0)
  assert.equal((await session.fromPartition("persist:wpp").cookies.get({ url, name: "smoke" })).length, 0)
  assert.deepEqual(await one.view.webContents.executeJavaScript("[typeof require,typeof process,typeof window.api]"), [
    "undefined",
    "undefined",
    "undefined",
  ])
  assert.equal(browserPreferences.sandbox, true)
  assert.equal(browserPreferences.contextIsolation, true)
  assert.equal(browserPreferences.nodeIntegration, false)
  assert.equal(browserPreferences.webviewTag, false)
  for (const value of ["file:///C:/Windows/win.ini", "javascript:alert(1)", "data:text/html,x", "oc://renderer/"]) {
    assert.equal(browserURL(value), false)
    await assert.rejects(command({ op: "navigate", tabID: first, url: value }))
  }

  assert.deepEqual(await route({ op: "list_tabs" }), {
    ok: true,
    result: { tabID: "", url: "", title: "", visibleText: "", elements: [], tabs: [] },
  })
  assert.equal((await route({ op: "read_state", tabID: first })).ok, false)
  stage("agent permissions and navigation")
  // Deterministic native-dialog responses, only inside this isolated test process.
  const showMessage = dialog.showMessageBox
  const showSync = dialog.showMessageBoxSync
  dialog.showMessageBoxSync = () => 1
  dialog.showMessageBox = (async () => ({ response: 1, checkboxChecked: false })) as typeof dialog.showMessageBox
  await command({ op: "access", tabID: first, enabled: true })
  await command({ op: "access", tabID: second, enabled: true })
  assert.equal(browserRegistration("smoke", first)?.agentAccess, true)
  await one.view.webContents.executeJavaScript("scrollTo(0,0)")
  const snap = await route({ op: "read_state", tabID: first })
  assert(snap.ok)
  const ref = snap.result.elements[0].ref
  const filled = await route({ op: "fill", tabID: first, ref, text: "agent input" })
  assert(filled.ok)
  assert.equal(await one.view.webContents.executeJavaScript("document.querySelector('#input').value"), "agent input")
  assert.equal(one.view.webContents.backgroundThrottling, true)
  await command({ op: "select", tabID: second })
  const background = await route({ op: "read_state", tabID: first })
  assert(background.ok)
  assert(
    (await route({ op: "fill", tabID: first, ref: background.result.elements[0].ref, text: "background input" })).ok,
  )
  assert.equal(
    await one.view.webContents.executeJavaScript("document.querySelector('#input').value"),
    "background input",
  )
  assert.equal(owner.attached, two)
  await command({ op: "select", tabID: first })
  await route({ op: "read_state", tabID: second })
  assert.deepEqual(await route({ op: "click", tabID: second, ref }), {
    ok: false,
    code: "stale_ref",
    error: `Element ref ${ref} is stale. Read browser state again.`,
  })
  const navigated = await route({ op: "navigate", tabID: first, url: `${url}?next` })
  assert(navigated.ok)
  await command({ op: "back", tabID: first })
  await wait(() => one.contents.getURL() === url && !one.view.webContents.isLoading())
  await command({ op: "forward", tabID: first })
  await wait(() => one.contents.getURL() === `${url}?next` && !one.view.webContents.isLoading())
  assert.equal((await route({ op: "navigate", tabID: first, url: `${url}redirect` })).ok, false)
  await command({ op: "navigate", tabID: first, url })

  stage("failed page recovery")
  await assert.rejects(command({ op: "navigate", tabID: first, url: `${url}fail` }))
  assert.equal((await command({ op: "state" })).tabs.find((tab) => tab.id === first)?.loadFailed, true)
  await command({ op: "navigate", tabID: first, url })
  assert.equal((await command({ op: "state" })).tabs.find((tab) => tab.id === first)?.loadFailed, false)

  stage("downloads")
  for (const name of ["download", "download-cancel", "download-fail"]) {
    stage(name)
    const destination = join(profile!, `${name}.txt`)
    const finished = new Promise<string>((resolve) => {
      one.view.webContents.session.once("will-download", (_event, item) => {
        assert.equal(item.getSaveDialogOptions().title, "Save download")
        assert(item.getSaveDialogOptions().defaultPath?.endsWith("fixture.txt"))
        // Bypass only the native chooser in this test process, after production configures it.
        item.setSavePath(destination)
        item.once("done", (_event, state) => resolve(state))
        if (name === "download-cancel") setImmediate(() => item.cancel())
      })
    })
    one.view.webContents.downloadURL(`${url}${name}`)
    const expected = name === "download" ? "completed" : name === "download-cancel" ? "cancelled" : "interrupted"
    assert.equal(await finished, name === "download-fail" ? "cancelled" : expected)
    assert.equal((await command({ op: "state" })).downloads?.[0].state, expected)
    if (name === "download") assert.equal(readFileSync(destination, "utf8"), "browser download")
    if (name === "download-cancel") assert.equal(existsSync(destination), false)
  }

  stage("popup")
  await one.view.webContents.executeJavaScript("document.querySelector('#open').click()", true)
  stage(
    `popup created: ${owner.groups.get("smoke")!.tabs.length} tabs; ${await one.view.webContents.executeJavaScript("String(window.child)")}`,
  )
  await wait(() => owner.groups.get("smoke")!.tabs.length === 3)
  stage("popup loading")
  const popup = owner.groups.get("smoke")!.tabs.find((tab) => tab.openerID === first)!
  await wait(() => {
    stage(`popup loading: ${popup.view.webContents.getURL()} loading=${popup.view.webContents.isLoading()}`)
    return !popup.view.webContents.isLoading() && popup.view.webContents.getURL().endsWith("/popup")
  })
  assert.equal(popup.agentAccess, false)
  assert.equal(popup.view.webContents.session, one.view.webContents.session)
  const chromium = await one.view.webContents.executeJavaScript("navigator.userAgent")
  assert.match(chromium, /Chrome\/[\d.]+/)
  assert.doesNotMatch(chromium, /Electron\/|OpenCodeDev\/|CookieMonster\//)
  assert.equal(await popup.view.webContents.executeJavaScript("navigator.userAgent"), chromium)
  assert.equal(userAgents.get("/popup"), chromium)
  assert.equal(await popup.view.webContents.executeJavaScript("window.opener !== null"), true)
  await popup.view.webContents.executeJavaScript("window.opener.postMessage('popup-ready',location.origin)")
  assert.equal(await one.view.webContents.executeJavaScript("window.child !== null"), true)

  stage("noopener popup")
  await command({ op: "select", tabID: first })
  await one.view.webContents.executeJavaScript(
    "const link=document.createElement('a'); link.href='/noopener'; link.target='_blank'; link.rel='noopener'; document.body.append(link); link.click()",
    true,
  )
  await wait(() => owner.groups.get("smoke")!.tabs.length === 4)
  const separate = owner.groups
    .get("smoke")!
    .tabs.find((tab) => tab.id !== first && tab.id !== second && tab.id !== popup.id)!
  await wait(
    () =>
      !separate.contents.isDestroyed() &&
      separate.contents.getURL().endsWith("/noopener") &&
      !separate.view.webContents.isLoading(),
  )
  assert.equal(await separate.view.webContents.executeJavaScript("window.opener"), null)
  assert.equal(await separate.view.webContents.executeJavaScript("navigator.userAgent"), chromium)
  assert.equal(userAgents.get("/noopener"), chromium)
  assert.equal(separate.agentAccess, false)
  await command({ op: "close", tabID: separate.id })
  await wait(() => separate.contents.isDestroyed())

  await command({ op: "select", tabID: first })
  await one.view.webContents.executeJavaScript("getSelection().selectAllChildren(document.querySelector('#text'))")
  assert.equal(await browserPageContext(owner, "smoke", first, "selection"), "Selected text")
  stage("screenshot")
  assert.equal(owner.attached, one)
  const screenshot = await browserPageContext(owner, "smoke", first, "screenshot")
  assert(typeof screenshot === "string" && screenshot.startsWith("data:image/png;base64,"))
  stage("picker cancellation")
  const picking = browserPageContext(owner, "smoke", first, "pick")
  await new Promise((resolve) => setTimeout(resolve, 50))
  await command({ op: "select", tabID: second })
  assert.equal(await picking, undefined)
  await assert.rejects(browserPageContext(owner, "smoke", first, "executeJavaScript"))

  await win.webContents.executeJavaScript(
    'document.body.innerHTML=\'<div id="viewport" style="position:fixed;inset:20px"></div>\'',
  )
  const viewportCheck = `(${browserViewportBounds.toString()})(document.querySelector('#viewport'))`
  assert(await win.webContents.executeJavaScript(viewportCheck))
  await win.webContents.executeJavaScript(
    "document.body.insertAdjacentHTML('beforeend','<div role=\"dialog\">Dialog</div>')",
  )
  assert.equal(await win.webContents.executeJavaScript(viewportCheck), null)
  await win.webContents.executeJavaScript(
    "document.querySelector('[role=dialog]').remove(); document.querySelector('#viewport').style.display='none'",
  )
  assert.equal(await win.webContents.executeJavaScript(viewportCheck), null)

  await command({ op: "access", tabID: second, enabled: false })
  assert.equal((await route({ op: "read_state", tabID: second })).ok, false)
  await command({ op: "select", tabID: first })
  stage("browser menu and vault")
  stage("agent transfer permissions")
  const uploadPicker = dialog.showOpenDialog
  const uploadFile = join(profile!, "selected-upload.txt")
  writeFileSync(uploadFile, "only the selected file")
  await one.view.webContents.executeJavaScript(`document.body.innerHTML = '<input type="file" id="upload">'`)
  let chosen = 0
  dialog.showOpenDialog = (async (_window, options) => {
    assert(options?.title?.includes(new URL(url).origin))
    chosen++
    return { canceled: false, filePaths: [uploadFile] }
  }) as typeof dialog.showOpenDialog
  const uploadSnapshot = await route({ op: "read_state", tabID: first })
  assert(uploadSnapshot.ok)
  const uploadClick = await route({ op: "click", tabID: first, ref: uploadSnapshot.result.elements[0].ref })
  assert(uploadClick.ok)
  await wait(() => one.view.webContents.executeJavaScript('document.querySelector("#upload").files.length === 1'))
  assert.equal(chosen, 1)
  assert.equal(
    await one.view.webContents.executeJavaScript('document.querySelector("#upload").files[0].text()'),
    "only the selected file",
  )
  await command({ op: "transfer-rule", rule: { origin: url, uploads: "block", downloads: "block" } })
  await one.view.webContents.executeJavaScript(
    'document.querySelector("#upload").value=""; document.querySelector("#upload").click()',
    true,
  )
  await new Promise((resolve) => setTimeout(resolve, 100))
  assert.equal(chosen, 1)
  assert.equal(await one.view.webContents.executeJavaScript('document.querySelector("#upload").files.length'), 0)
  const deniedDownload = new Promise<boolean>((resolve) =>
    one.view.webContents.session.once("will-download", (event) => resolve(event.defaultPrevented)),
  )
  one.view.webContents.downloadURL(`${url}download`)
  assert(await deniedDownload)
  await command({ op: "transfer-rule", rule: { origin: url, uploads: "ask", downloads: "ask" } })
  dialog.showMessageBoxSync = () => 0
  const declinedDownload = new Promise<boolean>((resolve) =>
    one.view.webContents.session.once("will-download", (event) => resolve(event.defaultPrevented)),
  )
  one.view.webContents.downloadURL(`${url}download`)
  assert(await declinedDownload)
  dialog.showMessageBoxSync = () => 1
  let finishPicker: ((value: { canceled: boolean; filePaths: string[] }) => void) | undefined
  dialog.showOpenDialog = (() =>
    new Promise((resolve) => {
      finishPicker = resolve
    })) as typeof dialog.showOpenDialog
  await one.view.webContents.executeJavaScript('document.querySelector("#upload").click()', true)
  await wait(() => !!finishPicker)
  await command({ op: "access", tabID: first, enabled: false })
  finishPicker!({ canceled: false, filePaths: [uploadFile] })
  await new Promise((resolve) => setTimeout(resolve, 100))
  assert.equal(await one.view.webContents.executeJavaScript('document.querySelector("#upload").files.length'), 0)
  finishPicker = undefined
  await one.view.webContents.executeJavaScript('document.querySelector("#upload").click()', true)
  await wait(() => !!finishPicker)
  await command({ op: "transfer-rule", rule: { origin: url, uploads: "block", downloads: "ask" } })
  finishPicker!({ canceled: false, filePaths: [uploadFile] })
  await new Promise((resolve) => setTimeout(resolve, 100))
  assert.equal(await one.view.webContents.executeJavaScript('document.querySelector("#upload").files.length'), 0)
  await command({ op: "transfer-rule", rule: { origin: url, uploads: "ask", downloads: "ask" } })
  finishPicker = undefined
  await one.view.webContents.executeJavaScript('document.querySelector("#upload").click()', true)
  await wait(() => !!finishPicker)
  await command({ op: "navigate", tabID: first, url: `${url}?new-document` })
  await one.view.webContents.executeJavaScript(`document.body.innerHTML = '<input type="file" id="upload">'`)
  finishPicker!({ canceled: false, filePaths: [uploadFile] })
  await new Promise((resolve) => setTimeout(resolve, 100))
  assert.equal(await one.view.webContents.executeJavaScript('document.querySelector("#upload").files.length'), 0)
  stage("cross-process iframe upload blocking")
  let childSession: string | undefined
  one.view.webContents.debugger.on("message", (_event, method, params) => {
    if (method === "Target.attachedToTarget" && params.targetInfo.type === "iframe") childSession = params.sessionId
  })
  let forbiddenPicker = false
  dialog.showOpenDialog = (async () => {
    forbiddenPicker = true
    return { canceled: true, filePaths: [] }
  }) as typeof dialog.showOpenDialog
  await one.view.webContents.executeJavaScript(
    `const frame = document.createElement('iframe'); frame.src = ${JSON.stringify(url.replace("127.0.0.1", "localhost"))}; document.body.append(frame)`,
  )
  await wait(() => !!childSession)
  await one.view.webContents.debugger.sendCommand(
    "Runtime.evaluate",
    {
      expression: `document.body.innerHTML = '<input type="file" id="upload">'; document.querySelector('#upload').oncancel = () => { window.uploadCancelled = true }; document.querySelector('#upload').click(); true`,
      userGesture: true,
    },
    childSession,
  )
  await new Promise((resolve) => setTimeout(resolve, 100))
  assert.equal(forbiddenPicker, false)
  const iframeFiles = await one.view.webContents.debugger.sendCommand(
    "Runtime.evaluate",
    {
      expression: "document.querySelector('#upload').files.length",
      returnByValue: true,
    },
    childSession,
  )
  assert.equal(iframeFiles.result.value, 0)
  const iframeCancelled = await one.view.webContents.debugger.sendCommand(
    "Runtime.evaluate",
    {
      expression: "window.uploadCancelled",
      returnByValue: true,
    },
    childSession,
  )
  assert.equal(iframeCancelled.result.value, true, "Chromium cancels iframe selection without a native picker")
  assert(one.transferGuarded, "Revocation retains delayed-transfer protection")
  assert(popup.transferGuarded, "Pop-ups inherit transfer protection without agent access")
  await command({ op: "transfer-rule", rule: { origin: url, uploads: "ask", downloads: "ask" }, remove: true })
  dialog.showOpenDialog = uploadPicker
  await command({ op: "navigate", tabID: first, url })
  stage("agent access settings")
  await command({ op: "preferences", values: { agentEnabled: false } })
  assert.equal((await route({ op: "read_state", tabID: first })).ok, false)
  assert.equal(one.agentAccess, false)
  await assert.rejects(command({ op: "access", tabID: first, enabled: true }))
  await command({ op: "preferences", values: { agentEnabled: true, showFullURL: false, selectionScreenshots: true } })
  assert.equal(one.agentAccess, false)
  assert.equal(browserPreferencesState().showFullURL, false)
  assert.equal(browserPreferencesState().selectionScreenshots, true)
  await assert.rejects(command({ op: "preferences", values: { showFullURL: "no" } }))
  stage("automatic downloads")
  const directoryPicker = dialog.showOpenDialog
  const downloadFolder = join(profile!, "saved-downloads")
  mkdirSync(downloadFolder)
  writeFileSync(join(downloadFolder, "fixture.txt"), "existing-file")
  dialog.showOpenDialog = (async () => ({
    canceled: false,
    filePaths: [downloadFolder],
  })) as typeof dialog.showOpenDialog
  await command({ op: "download-directory" })
  dialog.showOpenDialog = directoryPicker
  assert.equal(downloadDirectory(), downloadFolder)
  await command({ op: "preferences", values: { askDownloadLocation: false } })
  const automatic = new Promise<void>((resolve) =>
    one.view.webContents.session.once("will-download", (_event, item) => {
      assert.equal(item.getSavePath(), join(downloadFolder, "fixture (1).txt"))
      item.once("done", (_event, state) => {
        assert.equal(state, "completed")
        resolve()
      })
    }),
  )
  one.view.webContents.downloadURL(`${url}download`)
  await automatic
  assert.equal(readFileSync(join(downloadFolder, "fixture.txt"), "utf8"), "existing-file")
  assert.equal(readFileSync(join(downloadFolder, "fixture (1).txt"), "utf8"), "browser download")
  const autoCancelled = new Promise<void>((resolve) =>
    one.view.webContents.session.once("will-download", (_event, item) => {
      item.once("done", () => resolve())
      setImmediate(() => item.cancel())
    }),
  )
  one.view.webContents.downloadURL(`${url}download-cancel`)
  await autoCancelled
  assert(!existsSync(join(downloadFolder, "fixture (2).txt")))
  assert(downloadHistory().some((entry) => entry.canReveal))
  stage("download controls")
  const activeTransfer = new Promise<import("electron").DownloadItem>((resolve) => {
    one.view.webContents.session.once("will-download", (_event, item) => resolve(item))
  })
  one.view.webContents.downloadURL(`${url}download-slow`)
  const transfer = await activeTransfer
  await wait(async () => (await command({ op: "state" })).downloads!.some((row) => row.canControl))
  const transferID = (await command({ op: "state" })).downloads!.find((row) => row.canControl)!.id
  await assert.rejects(
    browserCommand(owner, "other-download-session", { op: "download-control", id: transferID, action: "cancel" }),
  )
  await command({ op: "download-control", id: transferID, action: "pause" })
  assert(transfer.isPaused())
  assert((await command({ op: "state" })).downloads!.find((row) => row.id === transferID)?.paused)
  await command({ op: "download-control", id: transferID, action: "resume" })
  assert(!transfer.isPaused())
  const controlledDone = new Promise<void>((resolve) => transfer.once("done", () => resolve()))
  await command({ op: "download-control", id: transferID, action: "cancel" })
  await controlledDone
  assert.equal(downloadHistory().find((row) => row.id === transferID)?.state, "cancelled")
  await command({ op: "forget-download", id: transferID })
  assert(!downloadHistory().some((row) => row.id === transferID))
  assert(existsSync(join(downloadFolder, "fixture (1).txt")))
  await command({ op: "clear", kind: "downloads" })
  assert.equal(downloadHistory().length, 0)
  assert(existsSync(join(downloadFolder, "fixture (1).txt")))
  await command({ op: "preferences", values: { askDownloadLocation: true } })
  await command({ op: "download-directory", reset: true })
  assert.equal(downloadDirectory(), app.getPath("downloads"))
  stage("media site permissions")
  await command({ op: "navigate", tabID: first, url })
  assert.equal(mediaOrigin(url, "https://other.example", true), undefined)
  assert.equal(mediaOrigin(url, url, false), undefined)
  const camera = `navigator.mediaDevices.getUserMedia({video:true}).then(stream=>{stream.getTracks().forEach(track=>track.stop());return true},()=>false)`
  assert.equal(await one.view.webContents.executeJavaScript(camera), false)
  await command({ op: "site-permission", origin: url, camera: "allow", microphone: "block" })
  await wait(() => !one.view.webContents.isLoading())
  assert.equal(await one.view.webContents.executeJavaScript(camera), true)
  await command({ op: "site-permission", origin: url, camera: "ask", microphone: "block" })
  await wait(() => !one.view.webContents.isLoading())
  let mediaPrompts = 0
  dialog.showMessageBox = (async (optionsOrWindow, options) => {
    if (options?.message?.startsWith("Allow device access")) mediaPrompts++
    return { response: 1, checkboxChecked: false }
  }) as typeof dialog.showMessageBox
  assert.equal(await one.view.webContents.executeJavaScript(camera), true)
  assert.equal(mediaPrompts, 1)
  dialog.showMessageBox = (async () => ({ response: 1, checkboxChecked: false })) as typeof dialog.showMessageBox
  await one.view.webContents.executeJavaScript("window.onbeforeunload=()=>false; window.permissionMarker=1", true)
  await command({ op: "site-permission", origin: url, camera: "block", microphone: "block" })
  await wait(() => !one.view.webContents.isLoading())
  assert.equal(await one.view.webContents.executeJavaScript("window.permissionMarker"), undefined)
  assert.equal(await one.view.webContents.executeJavaScript(camera), false)
  stage("browser menu and vault")
  await command({ op: "navigate", tabID: first, url })
  assert(browserProfile().history.some((entry) => entry.url === url))
  await command({ op: "settings", rememberHistory: false })
  await command({ op: "navigate", tabID: first, url: `${url}?private` })
  assert(!browserProfile().history.some((entry) => entry.url === `${url}?private`))
  await command({ op: "zoom", tabID: first, factor: 1.2 })
  assert.equal(one.view.webContents.getZoomFactor(), 1.2)
  await command({ op: "zoom", tabID: first, factor: 1 })
  await assert.rejects(command({ op: "zoom", tabID: first, factor: 99 }))
  await command({ op: "find", tabID: first, text: "Selected" })
  await wait(() => one.find?.matches === 1)
  await command({ op: "find", tabID: first, text: "" })
  assert.equal(one.find, undefined)
  await command({ op: "device", tabID: first, enabled: true })
  assert.deepEqual(await one.view.webContents.executeJavaScript("[screen.width,screen.height]"), [390, 844])
  await command({ op: "device", tabID: first, enabled: false })
  const print = one.view.webContents.print
  let printed = false
  one.view.webContents.print = (_options, callback) => {
    printed = true
    callback?.(true, "")
  }
  await command({ op: "print", tabID: first })
  assert(printed)
  one.view.webContents.print = print
  assert.equal(browserProfile().vaultStatus, "locked")
  assert.deepEqual(browserProfile().credentials, [])
  assert.throws(() => readLogins())
  // Stub only the OS ceremony in this separate fixture process; production has no bypass flag.
  const realAuthentication = vaultAuthentication.verify
  vaultAuthentication.verify = async () => {
    throw new Error("fixture cancellation")
  }
  await assert.rejects(command({ op: "unlock-vault" }))
  assert.equal(browserProfile().vaultStatus, "locked")
  vaultAuthentication.verify = async () => {}
  await command({ op: "unlock-vault" })
  await command({ op: "access", tabID: first, enabled: false })
  await one.view.webContents.executeJavaScript(
    `document.body.innerHTML='<form method="post"><input autocomplete="username" value="fixture-user"><input type="password" value="fixture-secret"></form>'`,
  )
  await command({ op: "save-login", tabID: first })
  const credential = browserProfile().credentials[0]
  await accountSmoke(win, command, url, credential.username)
  await command({ op: "lock-vault" })
  assert.deepEqual(browserProfile().credentials, [])
  assert.throws(() => readLogins())
  await assert.rejects(command({ op: "fill-login", tabID: first, id: credential.id }))
  await command({ op: "unlock-vault" })
  assert.equal(credential.username, "fixture-user")
  const storage = getStore("cm-browser")
  const get = storage.get
  let lockedDuringRead = false
  storage.get = ((key: string, fallback?: unknown) => {
    const result: unknown = Reflect.apply(get, storage, [key, fallback])
    if (key === "vault") {
      lockedDuringRead = true
      vaultAccess.lock()
    }
    return result
  }) as typeof storage.get
  try {
    const expiredProfile = browserProfile()
    assert.equal(expiredProfile.vaultStatus, "locked")
    assert.deepEqual(expiredProfile.credentials, [])
    assert(lockedDuringRead)
  } finally {
    storage.get = get
  }
  await command({ op: "unlock-vault" })
  powerMonitor.emit("lock-screen")
  assert.equal(browserProfile().vaultStatus, "locked")
  await command({ op: "unlock-vault" })
  powerMonitor.emit("suspend")
  assert.equal(browserProfile().vaultStatus, "locked")
  await command({ op: "unlock-vault" })
  win.hide()
  assert.equal(browserProfile().vaultStatus, "locked")
  win.showInactive()
  await command({ op: "unlock-vault" })
  assert(!JSON.stringify(browserProfile()).includes("fixture-secret"))
  assert(!readFileSync(join(profile!, "profile", "cm-browser"), "utf8").includes("fixture-secret"))
  assert(!readFileSync(join(profile!, "profile", "cm-browser"), "utf8").includes("fixture-user"))
  app.commandLine.appendSwitch("remote-debugging-port", "0")
  assert.equal(browserProfile().vaultAvailable, false)
  assert.throws(() => readLogins())
  app.commandLine.removeSwitch("remote-debugging-port")
  const encryptedVault = getStore("cm-browser").get("vault") as { data: string }
  getStore("cm-browser").set("vault", { ...encryptedVault, data: Buffer.from("tampered").toString("base64") })
  assert.throws(() => readLogins())
  assert.equal(browserProfile().vaultAvailable, false)
  assert.throws(() => saveLogins([{ origin: url, username: "replacement", password: "replacement" }]))
  assert.equal(
    (getStore("cm-browser").get("vault") as { data: string }).data,
    Buffer.from("tampered").toString("base64"),
  )
  getStore("cm-browser").set("vault", encryptedVault)
  assert.equal(readLogins()[0].password, "fixture-secret")
  await one.view.webContents.executeJavaScript("document.querySelectorAll('input').forEach(el=>el.value='')")
  await command({ op: "fill-login", tabID: first, id: credential.id })
  assert.equal(
    await one.view.webContents.executeJavaScript("document.querySelector('input[type=password]').value"),
    "fixture-secret",
  )
  assert(!JSON.stringify(await one.view.webContents.executeJavaScript(snapshotScript())).includes("fixture-secret"))
  stage("multi-step autofill")
  await one.view.webContents.executeJavaScript(
    `document.body.innerHTML='<form method="post"><input autocomplete="username"></form>'`,
  )
  await command({ op: "fill-login", tabID: first, id: credential.id, field: "username" })
  assert.equal(await one.view.webContents.executeJavaScript("document.querySelector('input').value"), "fixture-user")
  await assert.rejects(command({ op: "fill-login", tabID: first, id: credential.id, field: "password" }))
  assert(
    !completeLoginScript(
      new URL(url).origin,
      "test",
      { origin: url, username: "fixture-user", password: "fixture-secret" },
      Date.now() + 5000,
      "username",
    ).includes("fixture-secret"),
  )
  await one.view.webContents.executeJavaScript(
    `document.body.innerHTML='<form method="post"><input type="password" autocomplete="current-password"></form>'`,
  )
  await command({ op: "fill-login", tabID: first, id: credential.id, field: "password" })
  assert.equal(await one.view.webContents.executeJavaScript("document.querySelector('input').value"), "fixture-secret")
  await assert.rejects(command({ op: "fill-login", tabID: first, id: credential.id, field: "username" }))
  await one.view.webContents.executeJavaScript(
    `document.querySelector('form').action='https://other.example';document.querySelector('input').value=''`,
  )
  await assert.rejects(command({ op: "fill-login", tabID: first, id: credential.id, field: "password" }))
  assert.equal(await one.view.webContents.executeJavaScript("document.querySelector('input').value"), "")
  await one.view.webContents.executeJavaScript(
    `document.body.innerHTML='<form method="post"><input autocomplete="username"><input type="password"></form>'`,
  )
  stage("hostile login forms and consent races")
  const confirmLogin = dialog.showMessageBox
  dialog.showMessageBox = (async () => {
    vaultAccess.lock()
    await vaultAccess.unlock(win)
    return { response: 1, checkboxChecked: false }
  }) as typeof dialog.showMessageBox
  await assert.rejects(command({ op: "fill-login", tabID: first, id: credential.id }))
  dialog.showMessageBox = confirmLogin
  dialog.showMessageBox = (async () => ({ response: 0, checkboxChecked: false })) as typeof dialog.showMessageBox
  await one.view.webContents.executeJavaScript("document.querySelectorAll('input').forEach(el=>el.value='')")
  await command({ op: "fill-login", tabID: first, id: credential.id })
  assert.equal(await one.view.webContents.executeJavaScript("document.querySelector('input[type=password]').value"), "")
  dialog.showMessageBox = confirmLogin
  for (const mutation of [
    "document.querySelector('form').action='https://other.example/'",
    "document.querySelector('form').method='get'",
    "document.querySelector('form').style.opacity='0'",
    "document.querySelector('form').insertAdjacentHTML('beforeend','<button formaction=\"https://other.example\">Go</button>')",
    "document.querySelector('form').insertAdjacentHTML('afterbegin','<input autocomplete=\"username\">')",
    "document.querySelector('input[type=password]').autocomplete='section-login new-password'",
    "document.body.insertAdjacentHTML('beforeend','<div style=\"position:fixed;inset:0;background:white;z-index:100\"></div>')",
  ]) {
    await one.view.webContents.executeJavaScript(
      `document.body.innerHTML='<form method="post"><input autocomplete="username"><input type="password"></form>';${mutation}`,
    )
    await assert.rejects(command({ op: "fill-login", tabID: first, id: credential.id }))
    assert.equal(
      await one.view.webContents.executeJavaScript("document.querySelector('input[type=password]').value"),
      "",
    )
  }
  await one.view.webContents.executeJavaScript(
    `document.body.innerHTML='<form method="post"><input autocomplete="username"><input type="password"></form>'`,
  )
  await one.view.webContents.executeJavaScriptInIsolatedWorld(999, [
    { code: prepareLoginScript(new URL(url).origin, "test-ticket") },
  ])
  await command({ op: "navigate", tabID: first, url })
  await one.view.webContents.executeJavaScript(
    `document.body.innerHTML='<form method="post"><input autocomplete="username"><input type="password"></form>'`,
  )
  await assert.rejects(
    one.view.webContents.executeJavaScriptInIsolatedWorld(999, [
      {
        code: completeLoginScript(new URL(url).origin, "test-ticket", {
          origin: new URL(url).origin,
          username: "fixture-user",
          password: "fixture-secret",
        }),
      },
    ]),
  )
  assert.equal(await one.view.webContents.executeJavaScript("document.querySelector('input[type=password]').value"), "")
  dialog.showMessageBox = (async () => {
    // Changing the DOM within the same document must also invalidate a prepared fill.
    await one.view.webContents.executeJavaScriptInIsolatedWorld(999, [
      { code: prepareLoginScript(new URL(url).origin, "replacement-ticket") },
    ])
    await one.view.webContents.executeJavaScript(
      "document.querySelector('input[type=password]').outerHTML='<input type=password>'",
    )
    await assert.rejects(
      one.view.webContents.executeJavaScriptInIsolatedWorld(999, [
        {
          code: completeLoginScript(new URL(url).origin, "replacement-ticket", {
            origin: new URL(url).origin,
            username: "fixture-user",
            password: "fixture-secret",
          }),
        },
      ]),
    )
    await assert.rejects(command({ op: "access", tabID: first, enabled: true }))
    await command({ op: "navigate", tabID: first, url })
    return { response: 1, checkboxChecked: false }
  }) as typeof dialog.showMessageBox
  await assert.rejects(command({ op: "fill-login", tabID: first, id: credential.id }))
  dialog.showMessageBox = confirmLogin
  await command({ op: "access", tabID: first, enabled: true })
  await assert.rejects(command({ op: "fill-login", tabID: first, id: credential.id }))
  await command({ op: "access", tabID: first, enabled: false })
  saveLogins([{ origin: "https://other.example", username: "other", password: "other-secret" }])
  await assert.rejects(
    command({
      op: "fill-login",
      tabID: first,
      id: browserProfile().credentials.find((entry) => entry.origin === "https://other.example")!.id,
    }),
  )
  await command({ op: "forget-login", id: credential.id })
  assert.equal(browserProfile().credentials.length, 1)
  await command({ op: "clear", kind: "passwords" })
  assert.equal(browserProfile().credentials.length, 0)
  await command({ op: "unlock-vault" })
  getStore("cm-browser").set("credentials", [
    {
      id: "legacy",
      origin: new URL(url).origin,
      username: "legacy-user",
      encrypted: safeStorage.encryptString("legacy-secret").toString("base64"),
    },
  ])
  assert.equal(readLogins()[0].password, "legacy-secret")
  assert.equal(getStore("cm-browser").has("credentials"), false)
  assert(!readFileSync(join(profile!, "profile", "cm-browser"), "utf8").includes("legacy-user"))
  await command({ op: "clear", kind: "passwords" })
  stage("browser import dialogs")
  await command({ op: "unlock-vault" })
  const chooser = dialog.showOpenDialog
  const csv = join(profile!, "passwords.csv")
  writeFileSync(csv, `name,url,username,password\nFixture,${url},import-user,import-secret\n`)
  dialog.showOpenDialog = (async () => ({ canceled: false, filePaths: [csv] })) as typeof dialog.showOpenDialog
  await command({ op: "import", kind: "passwords" })
  assert.equal(browserProfile().credentials[0].username, "import-user")
  writeFileSync(csv, "url,username,password\ninvalid,bad,bad\n")
  await assert.rejects(command({ op: "import", kind: "passwords" }))
  assert.equal(browserProfile().credentials[0].username, "import-user")
  dialog.showOpenDialog = (async () => ({ canceled: true, filePaths: [] })) as typeof dialog.showOpenDialog
  await command({ op: "import", kind: "passwords" })
  assert.equal(browserProfile().credentials.length, 1)
  dialog.showOpenDialog = (async () => {
    vaultAccess.lock()
    return { canceled: false, filePaths: [csv] }
  }) as typeof dialog.showOpenDialog
  await assert.rejects(command({ op: "import", kind: "passwords" }))
  assert.deepEqual(browserProfile().credentials, [])
  await command({ op: "unlock-vault" })
  assert.equal(browserProfile().credentials[0].username, "import-user")
  const json = join(profile!, "cookies.json")
  writeFileSync(
    json,
    JSON.stringify([
      { domain: "127.0.0.1", hostOnly: true, secure: false, name: "import-cookie", value: "cookie-fixture", path: "/" },
    ]),
  )
  dialog.showOpenDialog = (async () => ({ canceled: false, filePaths: [json] })) as typeof dialog.showOpenDialog
  await command({ op: "import", kind: "cookies" })
  assert.equal(
    (await one.view.webContents.session.cookies.get({ url, name: "import-cookie" }))[0].value,
    "cookie-fixture",
  )
  dialog.showOpenDialog = chooser
  vaultAccess.lock()
  stage("automatic password save and update offers")
  await command({ op: "unlock-vault" })
  await command({ op: "select", tabID: first })
  await command({ op: "access", tabID: first, enabled: false })
  await command({ op: "preferences", values: { offerSaveLogins: true } })
  let offerContext: number | undefined
  const observeOffer = (_event: unknown, method: string, params: { name?: string; executionContextId?: number }) => {
    if (method === "Runtime.bindingCalled" && params.name?.startsWith("cmLoginOffer"))
      offerContext = params.executionContextId
  }
  one.view.webContents.debugger.on("message", observeOffer)
  let offers = 0
  let offerAnswer = 1
  const automaticDialog = dialog.showMessageBox
  dialog.showMessageBox = (async (_window, options) => {
    assert(options?.message?.includes("login"))
    assert(!options?.detail?.includes("auto-secret"))
    offers++
    return { response: offerAnswer, checkboxChecked: false }
  }) as typeof dialog.showMessageBox
  const submitLogin = async (secret: string, outcome = "spa", user = "automatic-user") => {
    stage(`automatic offers: ${outcome}, ${user || "password step"}, prior offers ${offers}`)
    await one.view.webContents.executeJavaScript(
      `document.body.innerHTML = '<form method="post" action="/login-success"><input autocomplete="username"><input type="password"><button type="submit">Sign in</button></form>'; document.querySelector('input').value = ${JSON.stringify(user)}; document.querySelector('input[type=password]').value = ${JSON.stringify(secret)}; ${outcome === "spa" ? "document.querySelector('form').onsubmit = event => { event.preventDefault(); event.target.remove(); document.body.append('Welcome') }" : outcome === "failed" ? "document.querySelector('form').onsubmit = event => { event.preventDefault(); document.body.insertAdjacentHTML('beforeend', '<p role=alert>Rejected</p>') }" : ""}; true`,
    )
    if (!secret)
      await one.view.webContents.executeJavaScript("document.querySelector('input[type=password]').remove(); true")
    await new Promise((resolve) => setTimeout(resolve, 800))
    const point = await one.view.webContents.executeJavaScript(
      "(() => { const r=document.querySelector('button').getBoundingClientRect(); return {x:r.x+r.width/2,y:r.y+r.height/2} })()",
    )
    one.view.webContents.sendInputEvent({ type: "mouseDown", button: "left", clickCount: 1, ...point })
    one.view.webContents.sendInputEvent({ type: "mouseUp", button: "left", clickCount: 1, ...point })
  }
  await submitLogin("auto-secret")
  await wait(() => readLogins().some((row) => row.username === "automatic-user"))
  assert.equal(offers, 1)
  assert(offerContext)
  assert.equal(
    (
      await one.view.webContents.debugger.sendCommand("Runtime.evaluate", {
        contextId: offerContext,
        expression: "globalThis.__cmOffers.input === null",
        returnByValue: true,
      })
    ).result.value,
    true,
    "Consumed offers release detached password fields",
  )
  one.view.webContents.debugger.removeListener("message", observeOffer)
  const autoID = readLogins().find((row) => row.username === "automatic-user")!.id
  assert.equal(await one.view.webContents.executeJavaScript("typeof globalThis.__cmOffers"), "undefined")
  await submitLogin("auto-secret-updated")
  await wait(() => readLogins().some((row) => row.id === autoID && row.password === "auto-secret-updated"))
  assert.equal(offers, 2)
  await submitLogin("auto-secret-updated")
  await new Promise((resolve) => setTimeout(resolve, 1900))
  assert.equal(offers, 2, "Unchanged credentials do not prompt")
  await submitLogin("wrong-password", "failed")
  await new Promise((resolve) => setTimeout(resolve, 1900))
  assert.equal(offers, 2, "Visible login failure does not prompt")
  await submitLogin("navigation-secret", "navigation", "navigation-user")
  await wait(() => readLogins().some((row) => row.username === "navigation-user"))
  assert.equal(offers, 3)
  offerAnswer = 0
  await submitLogin("declined-secret", "spa", "declined-user")
  await wait(() => offers === 4)
  assert(!readLogins().some((row) => row.username === "declined-user"))
  offerAnswer = 2
  await submitLogin("never-secret", "spa", "never-user")
  await wait(() => browserProfile().loginOfferExclusions?.includes(new URL(url).origin) === true)
  assert(!readLogins().some((row) => row.username === "never-user"))
  await submitLogin("excluded-secret", "spa", "excluded-user")
  await new Promise((resolve) => setTimeout(resolve, 1900))
  assert.equal(offers, 5)
  await command({ op: "allow-login-offers", origin: url })
  assert.deepEqual(browserProfile().loginOfferExclusions, [])
  offerAnswer = 1
  await submitLogin("", "spa", "two-step-user")
  await submitLogin("two-step-secret", "spa", "")
  await wait(() => readLogins().some((row) => row.username === "two-step-user" && row.password === "two-step-secret"))
  let resolveOffer: ((value: { response: number; checkboxChecked: boolean }) => void) | undefined
  dialog.showMessageBox = (() =>
    new Promise((resolve) => {
      resolveOffer = resolve
    })) as typeof dialog.showMessageBox
  await submitLogin("discard-on-lock", "spa", "lock-race-user")
  await wait(() => !!resolveOffer)
  vaultAccess.lock()
  await vaultAccess.unlock(win)
  resolveOffer!({ response: 1, checkboxChecked: false })
  await new Promise((resolve) => setTimeout(resolve, 200))
  assert(!readLogins().some((row) => row.username === "lock-race-user"))
  resolveOffer = undefined
  await submitLogin("discard-on-navigation", "spa", "navigation-race-user")
  await wait(() => !!resolveOffer)
  await one.view.webContents.loadURL(url)
  resolveOffer!({ response: 1, checkboxChecked: false })
  await new Promise((resolve) => setTimeout(resolve, 200))
  assert(!readLogins().some((row) => row.username === "navigation-race-user"))
  vaultAccess.lock()
  await submitLogin("locked-secret", "spa", "locked-user")
  await new Promise((resolve) => setTimeout(resolve, 1900))
  await vaultAccess.unlock(win)
  assert(!readLogins().some((row) => row.username === "locked-user"))
  await command({ op: "preferences", values: { offerSaveLogins: false } })
  dialog.showMessageBox = automaticDialog
  vaultAccess.lock()
  vaultAuthentication.verify = realAuthentication
  stage("history and selected clearing")
  const now = Date.now()
  getStore("cm-browser").set("history", [
    { url, title: "Recent legacy visit", time: now },
    { id: "old", url: `${url}?old`, title: "Older visit", time: now - 2 * 86400_000 },
  ])
  const migrated = browserProfile().history[0].id
  assert(migrated)
  assert.equal(browserProfile().history[0].id, migrated)
  await assert.rejects(command({ op: "clear-selected", kinds: ["history", "cookies"], range: "day" }))
  assert.equal(browserProfile().history.length, 2)
  await command({ op: "clear-selected", kinds: ["history", "downloads"], range: "day" })
  assert.deepEqual(
    browserProfile().history.map((entry) => entry.id),
    ["old"],
  )
  const historyTab = (await command({ op: "open-history", id: "old" })).activeID!
  await wait(
    () =>
      !owner.groups
        .get("smoke")!
        .tabs.find((tab) => tab.id === historyTab)!
        .view.webContents.isLoading(),
  )
  assert.equal((await command({ op: "state" })).tabs.find((tab) => tab.id === historyTab)?.url, `${url}?old`)
  await command({ op: "close", tabID: historyTab })
  await command({ op: "select", tabID: first })
  await command({ op: "forget-history", id: "old" })
  assert.equal(browserProfile().history.length, 0)
  await clearBrowserData(one.view.webContents.session, "history")
  assert.equal(browserProfile().history.length, 0)
  await session.fromPartition("persist:wpp").cookies.set({ url, name: "retained", value: "yes" })
  await command({ op: "clear", kind: "cookies" })
  assert.equal((await one.view.webContents.session.cookies.get({ url })).length, 0)
  assert.equal((await session.fromPartition("persist:wpp").cookies.get({ url, name: "retained" }))[0].value, "yes")
  await command({ op: "navigate", tabID: first, url })
  stage("beforeunload")
  stage("site controls and bookmarks")
  await wait(() => !one.view.webContents.isLoadingMainFrame())
  assert.equal((await command({ op: "state" })).tabs.find((tab) => tab.id === first)?.connection, "http")
  await one.view.webContents.executeJavaScript("localStorage.setItem('site-fixture','yes')")
  await one.view.webContents.session.cookies.set({ url: "https://other.example/", name: "unrelated", value: "keep" })
  await command({ op: "clear-site", tabID: first })
  await wait(() => !one.view.webContents.isLoading())
  assert.equal(await one.view.webContents.executeJavaScript("localStorage.getItem('site-fixture')"), null)
  assert.equal(
    (await one.view.webContents.session.cookies.get({ url: "https://other.example/", name: "unrelated" }))[0].value,
    "keep",
  )
  assert.equal((await session.fromPartition("persist:wpp").cookies.get({ url, name: "retained" }))[0].value, "yes")
  await command({ op: "bookmark-save", url, title: "Pinned fixture", pinned: true })
  const bookmark = bookmarks()[0]
  assert(bookmark.id)
  await command({ op: "bookmark-save", ...bookmark, title: "Edited fixture", pinned: false })
  assert.equal(bookmarks()[0].title, "Edited fixture")
  assert.equal(bookmarks().length, 1)
  await assert.rejects(command({ op: "bookmark-save", url: "javascript:alert(1)", title: "Bad", pinned: false }))
  const bookmarkFile = join(profile!, "bookmarks.html")
  const saveChooser = dialog.showSaveDialog
  dialog.showSaveDialog = (async () => ({ canceled: false, filePath: bookmarkFile })) as typeof dialog.showSaveDialog
  await command({ op: "bookmark-export" })
  dialog.showSaveDialog = saveChooser
  assert.equal(parseBookmarks(readFileSync(bookmarkFile, "utf8"))[0].title, "Edited fixture")
  await command({ op: "bookmark-delete", id: bookmark.id })
  assert.equal(bookmarks().length, 0)
  dialog.showOpenDialog = (async () => ({ canceled: false, filePaths: [bookmarkFile] })) as typeof dialog.showOpenDialog
  await command({ op: "bookmark-import" })
  await command({ op: "bookmark-import" })
  dialog.showOpenDialog = chooser
  assert.equal(bookmarks().length, 1)
  await command({ op: "clear", kind: "history" })
  assert.equal(bookmarks().length, 1)
  stage("beforeunload")
  await one.view.webContents.executeJavaScript("void (window.onbeforeunload=()=>false)", true)
  let prompts = 0
  dialog.showMessageBoxSync = () => {
    prompts++
    return 0
  }
  await command({ op: "close", tabID: first })
  await wait(() => prompts === 1)
  assert.equal(one.view.webContents.isDestroyed(), false)
  dialog.showMessageBoxSync = () => {
    prompts++
    return 1
  }
  await command({ op: "close", tabID: first })
  await wait(() => one.contents.isDestroyed())
  assert.equal(browserRegistration("smoke", first), undefined)
  assert.equal(popup.view.webContents.isDestroyed(), false)
  await command({ op: "close", tabID: second })
  await command({ op: "close", tabID: popup.id })
  await wait(() => owner.groups.get("smoke")!.tabs.length === 0)
  stage("tab recovery")
  assert((await command({ op: "state" })).recentlyClosed!.length > 0)
  const recovered = await command({ op: "reopen" })
  assert.equal(recovered.tabs.length, 1)
  assert.equal(recovered.tabs[0].agentAccess, false)
  await wait(() => !owner.groups.get("smoke")!.tabs[0].view.webContents.isLoading())
  const restoredURL = (await command({ op: "state" })).tabs[0].url
  assert.equal(savedTabs("smoke")!.tabs.length, 1)
  win.destroy()
  assert.equal(savedTabs("smoke")!.tabs.length, 1)
  const recoveredWindow = new BrowserWindow({ show: false, webPreferences: { sandbox: true } })
  const recoveredOwner = registerBrowserOwner(recoveredWindow)
  await recoveredWindow.loadURL(url)
  const afterRestart = await browserCommand(recoveredOwner, "smoke", { op: "state" })
  assert.equal(afterRestart.tabs.length, 1)
  assert.equal(afterRestart.tabs[0].agentAccess, false)
  assert.equal(afterRestart.profile?.vaultStatus, "locked")
  await wait(() => !recoveredOwner.groups.get("smoke")!.tabs[0].view.webContents.isLoading())
  assert.equal((await browserCommand(recoveredOwner, "smoke", { op: "state" })).tabs[0].url, restoredURL)
  await browserCommand(recoveredOwner, "smoke", { op: "preferences", values: { restoreTabs: false } })
  assert.equal(savedTabs("smoke"), undefined)
  stage("agent history permissions")
  const historyCommand = (value: Parameters<typeof browserCommand>[2]) => browserCommand(recoveredOwner, "smoke", value)
  const searchRequest = { op: "search_history", query: "guide", limit: 10 } as const
  const visits = [
    { id: "guide-old", url: `${url}guide-old`, title: "Guide", time: 100 },
    { id: "guide-new", url: `${url}guide-new`, title: "Guide newer", time: 200 },
  ]
  getStore("cm-browser").set("history", visits)
  await historyCommand({ op: "preferences", values: { agentHistory: "never" } })
  assert.equal((await route(searchRequest)).ok, false)
  await historyCommand({ op: "preferences", values: { agentHistory: "ask" } })
  dialog.showMessageBox = (async () => ({ response: 0, checkboxChecked: false })) as typeof dialog.showMessageBox
  assert.equal((await route(searchRequest)).ok, false)
  let approveHistory: ((value: { response: number; checkboxChecked: boolean }) => void) | undefined
  dialog.showMessageBox = (() =>
    new Promise((resolve) => {
      approveHistory = resolve
    })) as typeof dialog.showMessageBox
  const revokedSearch = route(searchRequest)
  await wait(() => !!approveHistory)
  assert.equal((await route(searchRequest)).ok, false, "Concurrent history prompts are suppressed")
  await historyCommand({ op: "preferences", values: { agentHistory: "never" } })
  await historyCommand({ op: "preferences", values: { agentHistory: "ask" } })
  approveHistory!({ response: 1, checkboxChecked: false })
  assert.equal((await revokedSearch).ok, false, "Re-enabling must not revive pending consent")
  approveHistory = undefined
  const deletedSearch = route(searchRequest)
  await wait(() => !!approveHistory)
  await historyCommand({ op: "forget-history", id: "guide-old" })
  await historyCommand({ op: "forget-history", id: "guide-new" })
  approveHistory!({ response: 1, checkboxChecked: false })
  const deletedReply = await deletedSearch
  assert(deletedReply.ok)
  assert.deepEqual(deletedReply.result.history, [])
  await historyCommand({ op: "preferences", values: { agentHistory: "allow" } })
  getStore("cm-browser").set("history", visits)
  const foundHistory = await route({ ...searchRequest, from: 100, to: 200, limit: 1 })
  assert(foundHistory.ok)
  assert.equal(foundHistory.result.history!.length, 1)
  assert.equal(foundHistory.result.history![0].url, `${url}guide-new`)
  const historyRef = foundHistory.result.history![0].ref
  await browserCommand(recoveredOwner, "other-history-task", { op: "state" })
  const foreignHistory = await routeBrowserRequest({
    type: "browser_request",
    id: "foreign",
    sessionID: "other-history-task",
    request: { op: "open_history", ref: historyRef },
  })
  assert.equal(foreignHistory.ok, false)
  dialog.showMessageBox = (async () => ({ response: 1, checkboxChecked: false })) as typeof dialog.showMessageBox
  const openedHistory = await route({ op: "open_history", ref: historyRef })
  assert(openedHistory.ok)
  assert.equal(openedHistory.result.opened, true)
  assert.equal(
    (await historyCommand({ op: "state" })).tabs.find((tab) => tab.id === openedHistory.result.tabID)?.agentAccess,
    false,
  )
  assert.equal((await route({ op: "read_state", tabID: openedHistory.result.tabID })).ok, false)
  assert.equal((await route({ op: "open_history", ref: historyRef })).ok, false, "Open refs are one-use")
  await historyCommand({ op: "close", tabID: openedHistory.result.tabID })
  const beforeDelete = await route(searchRequest)
  assert(beforeDelete.ok)
  const deletedRef = beforeDelete.result.history![0].ref
  await historyCommand({ op: "forget-history", id: "guide-old" })
  await historyCommand({ op: "forget-history", id: "guide-new" })
  assert.equal((await route({ op: "open_history", ref: deletedRef })).ok, false)
  const emptyHistory = await route(searchRequest)
  assert(emptyHistory.ok)
  assert.deepEqual(emptyHistory.result.history, [])
  await historyCommand({ op: "preferences", values: { agentHistory: "ask" } })
  stage("link destinations")
  const external = shell.openExternal
  const externalURLs: string[] = []
  shell.openExternal = async (value) => {
    externalURLs.push(value)
  }
  try {
    await openBrowserLink(recoveredWindow, url)
    assert.equal(externalURLs.length, 1, "Without an active task the default browser is used")
    browserLinkContext(recoveredOwner, "links", "current")
    browserLinkContext(recoveredOwner, null, "stale")
    await openBrowserLink(recoveredWindow, url)
    assert.equal(recoveredOwner.groups.get("links")?.tabs.length, 1)
    assert.equal(recoveredOwner.groups.get("links")?.tabs[0].agentAccess, false)
    await openBrowserLink(recoveredWindow, "https://example.com")
    assert.equal(externalURLs.length, 2)
    await browserCommand(recoveredOwner, "links", {
      op: "preferences",
      values: { webLinks: "browser", localLinks: "external" },
    })
    await openBrowserLink(recoveredWindow, url)
    assert.equal(externalURLs.length, 3)
    await openBrowserLink(recoveredWindow, url, "browser")
    assert.equal(recoveredOwner.groups.get("links")?.tabs.length, 2)
    assert.equal(browserLinkMenu(recoveredWindow.webContents, url).length, 2)
    assert.equal(browserLinkMenu(recoveredWindow.webContents, "file:///secret").length, 0)
    await assert.rejects(openBrowserLink(recoveredWindow, "javascript:alert(1)"))
  } finally {
    shell.openExternal = external
  }
  if (process.env.CM_BROWSER_LIVE_SMOKE === "1") {
    stage("public HTTPS pages")
    const liveID = (await browserCommand(recoveredOwner, "live", { op: "new" })).activeID!
    const live = recoveredOwner.groups.get("live")!.tabs.find((tab) => tab.id === liveID)!
    for (const destination of [
      "https://example.com",
      "https://httpbin.org/forms/post",
      "https://teams.microsoft.com/v2/",
    ]) {
      await browserCommand(recoveredOwner, "live", { op: "navigate", tabID: liveID, url: destination })
      await wait(() => !live.view.webContents.isLoading())
      for (let attempt = 0; attempt < 40; attempt++) {
        const visible: unknown = await live.view.webContents
          .executeJavaScript("document.body.innerText")
          .catch(() => "")
        if (typeof visible === "string" && visible.trim().length > 20) break
        await new Promise((resolve) => setTimeout(resolve, 500))
      }
      const text: unknown = await live.view.webContents.executeJavaScript("document.body.innerText")
      assert(typeof text === "string")
      assert(text.trim().length > 20, `Empty public page: ${destination}`)
      assert(!text.includes("Classic Teams is no longer available"), "Teams reached retired-client error")
      assert(!live.loadFailed)
      console.log(
        "PUBLIC PAGE",
        destination,
        "=>",
        new URL(live.contents.getURL()).origin,
        JSON.stringify(text.slice(0, 180)),
      )
    }
    stage("public popup")
    await live.view.webContents.executeJavaScript("void window.open('https://example.com', '_blank')", true)
    await wait(() => recoveredOwner.groups.get("live")!.tabs.length === 2)
    const livePopup = recoveredOwner.groups.get("live")!.tabs.find((tab) => tab.id !== liveID)!
    await wait(
      () => livePopup.contents.getURL().startsWith("https://example.com") && !livePopup.view.webContents.isLoading(),
    )
    assert.equal(livePopup.agentAccess, false)
    console.log("PUBLIC POPUP PASS")
    stage("public download")
    await browserCommand(recoveredOwner, "live", { op: "access", tabID: liveID, enabled: true })
    dialog.showMessageBoxSync = () => 1
    const downloaded = new Promise<void>((resolve, reject) => {
      live.view.webContents.session.once("will-download", (_event, item) => {
        item.setSavePath(join(profile!, "public-download.json"))
        item.once("done", (_event, state) =>
          state === "completed" ? resolve() : reject(new Error(`Public download ${state}`)),
        )
      })
    })
    live.view.webContents.downloadURL(
      "https://httpbin.org/response-headers?Content-Disposition=attachment%3Bfilename%3Dsmoke.json",
    )
    await downloaded
    assert(readFileSync(join(profile!, "public-download.json"), "utf8").includes("Content-Disposition"))
    console.log("PUBLIC DOWNLOAD PASS")
  }
  recoveredWindow.destroy()
  dialog.showMessageBox = showMessage
  dialog.showMessageBoxSync = showSync
  console.log(
    "PASS native browser: tabs, Chromium identity, downloads, permissions, context, find, zoom, device, encrypted vault, imports, data isolation, beforeunload",
  )
}

run().then(
  () => {
    writeFileSync(join(profile, "result.txt"), "PASS")
    server.close()
    app.exit(0)
  },
  (error) => {
    writeFileSync(join(profile, "result.txt"), String(error?.stack || error))
    console.error(error)
    server.close()
    app.exit(1)
  },
)
