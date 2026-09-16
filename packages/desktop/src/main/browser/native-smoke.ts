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
import { readLogins, writeLogins } from "./vault"
import { loginEntry, decodeLoginEntry } from "./login-entry"
import { prepareLoginScript, completeLoginScript } from "./login-form"
import { loginOfferSucceeded } from "./login-offer-script"
import { vaultAuthentication } from "./vault-auth"
import { vaultAccess } from "./vault-session"
import { savedTabs } from "./tab-recovery"
import { bookmarks } from "./bookmarks"
import { parseBookmarks } from "./bookmark-format"
import { randomUUID } from "node:crypto"
import { readContacts, requireContact } from "./contacts"
import { prepareContactScript, completeContactScript } from "./contact-form"

const profile = process.env.CM_BROWSER_SMOKE_PROFILE
if (!profile) throw new Error("Run bun scripts/browser-smoke.ts; never use a real profile")
mkdirSync(join(profile, "profile"), { recursive: true })
mkdirSync(join(profile, "session"), { recursive: true })
app.setPath("userData", join(profile, "profile"))
app.setPath("sessionData", join(profile, "session"))
app.on("window-all-closed", () => {})
app.commandLine.appendSwitch("use-fake-device-for-media-stream")
// Keep trusted fixture input working when another window covers this inactive test window.
app.commandLine.appendSwitch("disable-features", "CalculateNativeWinOcclusion")
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
  if (request.url === "/registration-failed") {
    response.writeHead(401, { "Content-Type": "text/html" })
    response.end("<!doctype html><title>Rejected</title><p>Rejected</p>")
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

  if (process.argv.includes("--generation")) {
    const verify = vaultAuthentication.verify
    const consent = dialog.showMessageBox
    const contents = one.view.webContents
    const execute = contents.executeJavaScriptInIsolatedWorld.bind(contents)
    const origin = new URL(url).origin
    const user = '<input autocomplete="username" value="generated-account">'
    const next = '<input type="password" autocomplete="new-password">'
    const current = '<input type="password" autocomplete="current-password" value="fixture-current-secret">'
    const secrets: string[] = []
    const dialogErrors: unknown[] = []
    let dialogs = 0
    let deliveries = 0
    let bindings = 0
    let captureMessages = 0
    let currentLeaks = 0
    let offerContext = 0
    let answer: (options: Electron.MessageBoxOptions) => Promise<number> = async () => 1
    let intercept: (() => Promise<void>) | undefined
    const observe = (
      _event: unknown,
      method: string,
      params: {
        context?: { id: number; name: string }
        name?: string
        payload?: string
      },
    ) => {
      if (method === "Runtime.executionContextCreated" && params.context?.name.startsWith("CookieMonster login offers"))
        offerContext = params.context.id
      if (method !== "Runtime.bindingCalled" || !params.name?.startsWith("cmLoginOffer")) return
      captureMessages++
      if (params.payload !== "null") bindings++
      if (params.payload?.includes("fixture-current-secret")) currentLeaks++
    }
    contents.debugger.on("message", observe)
    contents.executeJavaScriptInIsolatedWorld = (async (world, scripts, ...rest) => {
      if (scripts[0]?.code.includes("const password = ")) {
        deliveries++
        await intercept?.()
      }
      const result = await execute(world, scripts, ...rest)
      if (scripts[0]?.code.includes("return { min, max, hasUsername:"))
        assert.deepEqual(Object.keys(result).sort(), ["hasUsername", "max", "min"])
      return result
    }) as typeof contents.executeJavaScriptInIsolatedWorld
    const isolated = (code: string) => execute(999, [{ code }])
    const form = async (fields = user + next + next, attributes = 'method="post"') => {
      await contents.executeJavaScript(`document.body.innerHTML = ${JSON.stringify(`<form ${attributes}>${fields}<button>Submit</button></form>`)};
        window.submissions = 0; window.fillEvents = 0; window.atomic = true;
        document.querySelector('form').onsubmit = event => { event.preventDefault(); window.submissions++; event.target.remove() };
        document.addEventListener('input', () => {
          window.fillEvents++;
          const values = [...document.querySelectorAll('input[autocomplete="new-password"]')].map(el => el.value);
          window.atomic &&= values.every(value => value === values[0]);
        }, { once: true }); true`)
    }
    const generate = (settings: Record<string, unknown> = {}) =>
      command({ op: "generate-password", tabID: first, ...settings })
    const clean = async () => {
      assert.equal(one.loginBusy, false)
      assert.equal(owner.suspended, 0)
      assert.equal(owner.generationCheck, undefined)
      assert.equal(await isolated("!!document.__cmLoginTicket"), false)
    }
    const unchanged = async () => {
      assert(
        await contents.executeJavaScript(
          "[...document.querySelectorAll('input[autocomplete=\"new-password\"]')].every(el => el.value === '')",
        ),
        "Rejected generation does not change either field",
      )
      assert.equal(await contents.executeJavaScript("window.fillEvents"), 0)
      assert.equal(await contents.executeJavaScript("window.submissions"), 0)
      await clean()
    }
    const submit = async (waitForOffer = false) => {
      // Only raw, non-generated offer fixtures need installation; generation must hand off ready.
      if (waitForOffer)
        await wait(async () => {
          if (!offerContext) return false
          const result = await contents.debugger.sendCommand("Runtime.evaluate", {
            contextId: offerContext,
            expression: "globalThis.__cmOffers?.until > Date.now()",
            returnByValue: true,
          })
          return result.result.value === true
        })
      const point = await contents.executeJavaScript(
        "(() => { const r=document.querySelector('button').getBoundingClientRect(); return {x:Math.round(r.x+r.width/2),y:Math.round(r.y+r.height/2)} })()",
      )
      contents.sendInputEvent({ type: "mouseDown", button: "left", clickCount: 1, ...point })
      contents.sendInputEvent({ type: "mouseUp", button: "left", clickCount: 1, ...point })
      await wait(() => contents.executeJavaScript("window.submissions === 1"))
    }
    try {
      vaultAuthentication.verify = async () => {}
      await command({ op: "unlock-vault" })
      await command({ op: "preferences", values: { offerSaveLogins: true } })
      dialog.showMessageBox = (async (_win, options) => {
        try {
          assert(options)
          assert.equal(options.defaultId, 0)
          assert.equal(options.cancelId, 0)
          assert(options.signal)
          assert(options.detail?.includes(origin))
          assert(!JSON.stringify(options).includes("fixture-current-secret"))
          assert(secrets.every((secret) => !JSON.stringify(options).includes(secret)))
          dialogs++
          return { response: await answer(options), checkboxChecked: false }
        } catch (error) {
          dialogErrors.push(error)
          return { response: 0, checkboxChecked: false }
        }
      }) as typeof dialog.showMessageBox

      const handoffFailures: string[] = []
      stage("generation handoff: capture survives pending cleanup beyond the original grant")
      await form()
      const cleanupExecute = contents.executeJavaScriptInIsolatedWorld
      const cleanupAccounts = readLogins()
      let releaseCleanup!: () => void
      const cleanupGate = new Promise<void>((resolve) => {
        releaseCleanup = resolve
      })
      let cleaning = false
      let settled = false
      let cleanupConsent: ((value: number) => void) | undefined
      contents.executeJavaScriptInIsolatedWorld = (async (world, scripts, ...rest) => {
        if (scripts[0]?.code.startsWith("if (document.__cmLoginTicket?.token === ")) {
          cleaning = true
          await cleanupGate
        }
        return cleanupExecute(world, scripts, ...rest)
      }) as typeof contents.executeJavaScriptInIsolatedWorld
      const generation = generate().finally(() => {
        settled = true
      })
      try {
        await wait(() => cleaning)
        const generated: string = await contents.executeJavaScript(
          "document.querySelector('input[autocomplete=new-password]').value",
        )
        secrets.push(generated)
        assert.equal(generated.length, 20)
        answer = async () =>
          new Promise<number>((resolve) => {
            cleanupConsent = resolve
          })
        // Delay the real cleanup, not submission until a fixture-observed capture grant.
        await new Promise((resolve) => setTimeout(resolve, 1200))
        assert(
          !settled && one.loginBusy,
          "Generation remains pending and serialized past the original one-second grant",
        )
        const before = bindings
        const messages = captureMessages
        await submit()
        await wait(() => captureMessages > messages)
        if (bindings === before) handoffFailures.push("capture expired during pending generation cleanup")
        await new Promise((resolve) => setTimeout(resolve, 1700))
        assert(!settled && one.loginBusy && !cleanupConsent, "Capture renewal must not prompt while generation is busy")
        assert(JSON.stringify(readLogins()) === JSON.stringify(cleanupAccounts), "No save before separate consent")
        releaseCleanup()
        await generation
        if (bindings > before) {
          await wait(() => !!cleanupConsent)
          assert(JSON.stringify(readLogins()) === JSON.stringify(cleanupAccounts), "Showing an offer never saves")
          cleanupConsent!(1)
          await wait(() => !one.loginBusy)
          assert(
            readLogins().some(
              (row) => row.origin === origin && row.username === "generated-account" && row.password === generated,
            ),
            "Pending-cleanup submission saves exactly the generated password after consent",
          )
        }
      } finally {
        releaseCleanup()
        cleanupConsent?.(0)
        await generation
        contents.executeJavaScriptInIsolatedWorld = cleanupExecute
        writeLogins(cleanupAccounts)
        answer = async () => 1
      }

      stage("generation handoff: background acknowledgement cannot erase a navigated submission")
      await form()
      await contents.executeJavaScript(
        `document.querySelector('form').action = ${JSON.stringify(url + "generation-success")}; document.querySelector('form').onsubmit = null; true`,
      )
      await generate()
      const navigatedSecret: string = await contents.executeJavaScript(
        "document.querySelector('input[autocomplete=new-password]').value",
      )
      secrets.push(navigatedSecret)
      const navigationAccounts = readLogins()
      const backgroundSend = contents.debugger.sendCommand.bind(contents.debugger)
      let releaseBackground!: () => void
      const backgroundGate = new Promise<void>((resolve) => {
        releaseBackground = resolve
      })
      let backgroundHeld = false
      let navigationConsent: ((value: number) => void) | undefined
      answer = async () =>
        new Promise<number>((resolve) => {
          navigationConsent = resolve
        })
      contents.debugger.sendCommand = (async (method, params, ...rest) => {
        const result = await backgroundSend(method, params, ...rest)
        if (
          !backgroundHeld &&
          !one.loginBusy &&
          method === "Runtime.evaluate" &&
          params?.expression?.startsWith("globalThis.__cmOffers.until = ")
        ) {
          backgroundHeld = true
          await backgroundGate
        }
        return result
      }) as typeof contents.debugger.sendCommand
      try {
        // Hold a real BACKGROUND response after Chromium arms it; never call generation readiness here.
        await wait(() => backgroundHeld)
        assert(!one.loginBusy, "The intercepted acknowledgement belongs to background renewal")
        const before = bindings
        const point = await contents.executeJavaScript(
          "(() => { const r=document.querySelector('button').getBoundingClientRect(); return {x:Math.round(r.x+r.width/2),y:Math.round(r.y+r.height/2)} })()",
        )
        contents.sendInputEvent({ type: "mouseDown", button: "left", clickCount: 1, ...point })
        contents.sendInputEvent({ type: "mouseUp", button: "left", clickCount: 1, ...point })
        await wait(() => contents.getURL() === url + "generation-success" && !contents.isLoading())
        assert(bindings > before, "Trusted submission reaches the real binding before same-origin navigation")
        assert.equal(Boolean(navigationConsent), false)
        assert(JSON.stringify(readLogins()) === JSON.stringify(navigationAccounts))
        releaseBackground()
        await wait(() => !!navigationConsent).catch(() => {
          handoffFailures.push("stale background acknowledgement erased same-origin submission")
        })
        if (navigationConsent) {
          assert(
            JSON.stringify(readLogins()) === JSON.stringify(navigationAccounts),
            "Navigation never replaces save consent",
          )
          navigationConsent(1)
          await wait(() => !one.loginBusy)
          assert(
            readLogins().some(
              (row) =>
                row.origin === origin && row.username === "generated-account" && row.password === navigatedSecret,
            ),
            "Navigated submission saves exactly the generated password after consent",
          )
        }
      } finally {
        releaseBackground()
        navigationConsent?.(0)
        contents.debugger.sendCommand = backgroundSend
        writeLogins(navigationAccounts)
        answer = async () => 1
        await contents.loadURL(url)
      }
      assert.deepEqual(handoffFailures, [], "Watcher handoff races preserve submitted credentials and separate consent")

      stage("generation handoff: superseded installation is reinstalled before rearming")
      let installRevoked = false
      let installedAfterRevocation = false
      let prematureArm = false
      contents.debugger.sendCommand = (async (method, params, ...rest) => {
        if (!installRevoked && method === "Runtime.addBinding" && params?.name?.startsWith("cmLoginOffer")) {
          installRevoked = true
          vaultAccess.lock()
          await vaultAccess.unlock(win)
        }
        if (installRevoked && method === "Runtime.evaluate") {
          if (params?.expression?.includes("const state = globalThis.__cmOffers = ")) installedAfterRevocation = true
          if (params?.expression?.startsWith("globalThis.__cmOffers.until = ") && !installedAfterRevocation)
            prematureArm = true
        }
        return backgroundSend(method, params, ...rest)
      }) as typeof contents.debugger.sendCommand
      try {
        await contents.loadURL(url)
        await wait(() => installRevoked)
        await wait(() => installedAfterRevocation)
        assert(!prematureArm, "A superseded partial installation is discarded before capture is rearmed")
        await form()
        await generate()
        await clean()
      } finally {
        contents.debugger.sendCommand = backgroundSend
      }

      stage("generation: review regressions")
      const reviewFailures: string[] = []
      for (const [label, setup, mutation] of [
        [
          "internal image action",
          "document.querySelector('form').insertAdjacentHTML('beforeend', '<input type=image formaction=https://other.example>')",
          "",
        ],
        [
          "external image method",
          "document.querySelector('form').id = 'generation'; document.body.insertAdjacentHTML('beforeend', '<input type=image form=generation formmethod=get>')",
          "",
        ],
        [
          "image action mutation",
          "document.querySelector('form').insertAdjacentHTML('beforeend', '<input type=image>')",
          "document.querySelector('input[type=image]').formAction = 'https://other.example'",
        ],
        [
          "external image identity",
          "document.querySelector('form').id = 'generation'; document.body.insertAdjacentHTML('beforeend', '<input type=image form=generation>')",
          "document.querySelector('input[type=image]').replaceWith(document.querySelector('input[type=image]').cloneNode())",
        ],
        [
          "image effective destination",
          "document.querySelector('form').insertAdjacentHTML('beforeend', '<input type=image formaction=relative>')",
          "document.head.insertAdjacentHTML('beforeend', '<base href=/changed/>')",
        ],
        [
          "disabled fieldset",
          "document.querySelector('form').insertAdjacentHTML('afterbegin', '<fieldset disabled></fieldset>'); document.querySelector('fieldset').append(...document.querySelectorAll('input[autocomplete=new-password]'))",
          "",
        ],
        [
          "fieldset mutation",
          "document.querySelector('form').insertAdjacentHTML('afterbegin', '<fieldset></fieldset>'); document.querySelector('fieldset').append(...document.querySelectorAll('input[autocomplete=new-password]'))",
          "document.querySelector('fieldset').disabled = true",
        ],
        ["detached view", "", ""],
      ]) {
        stage(`generation review: ${label}`)
        await form()
        if (setup) await contents.executeJavaScript(`${setup}; true`)
        answer = async () => {
          if (mutation) await contents.executeJavaScript(`${mutation}; true`)
          return 1
        }
        if (label === "detached view") win.contentView.removeChildView(one.view)
        let rejected = false
        try {
          await generate()
        } catch {
          rejected = true
        } finally {
          if (!win.contentView.children.includes(one.view)) win.contentView.addChildView(one.view)
          await contents.executeJavaScript("document.querySelector('base')?.remove(); true")
        }
        if (!rejected) reviewFailures.push(label)
        else await unchanged()
      }
      answer = async () => 1
      stage("generation review: immediate submission without watcher wait")
      for (const response of [0, 1]) {
        await form()
        await contents.executeJavaScript(`document.querySelector('form').addEventListener('submit', event => {
          window.submittedPassword = event.target.querySelector('input[autocomplete=new-password]').value
        }, true); true`)
        const instantPoint = await contents.executeJavaScript(
          "(() => { const r=document.querySelector('button').getBoundingClientRect(); return {x:Math.round(r.x+r.width/2),y:Math.round(r.y+r.height/2)} })()",
        )
        const instantBindings = bindings
        const instantAccounts = readLogins()
        const instantDialogs = dialogs
        answer = async () => 1
        await generate()
        answer = async () => {
          assert(
            JSON.stringify(readLogins()) === JSON.stringify(instantAccounts),
            "Immediate submission still requires save consent",
          )
          return response
        }
        contents.sendInputEvent({ type: "mouseDown", button: "left", clickCount: 1, ...instantPoint })
        contents.sendInputEvent({ type: "mouseUp", button: "left", clickCount: 1, ...instantPoint })
        await wait(() => contents.executeJavaScript("window.submissions === 1"))
        if (bindings === instantBindings) reviewFailures.push("immediate submission capture")
        else {
          await wait(() => dialogs > instantDialogs + 1 && !one.loginBusy)
          if (response === 1) {
            const submitted: string = await contents.executeJavaScript("window.submittedPassword")
            assert(
              submitted.length === 20 &&
                readLogins().some(
                  (row) => row.origin === origin && row.username === "generated-account" && row.password === submitted,
                ),
              "Immediate successful submission saves exactly the generated password after consent",
            )
          } else assert(JSON.stringify(readLogins()) === JSON.stringify(instantAccounts), "Cancellation never saves")
        }
        writeLogins(instantAccounts)
      }
      stage("generation review: offer capture rejects image overrides and disabled fields")
      for (const [label, setup] of [
        [
          "offer internal image",
          "document.querySelector('form').insertAdjacentHTML('beforeend', '<input type=image formaction=https://other.example>')",
        ],
        [
          "offer external image",
          "document.querySelector('form').id = 'generation'; document.body.insertAdjacentHTML('beforeend', '<input type=image form=generation formmethod=get>')",
        ],
        [
          "offer disabled fieldset",
          "document.querySelector('form').insertAdjacentHTML('afterbegin', '<fieldset disabled></fieldset>'); document.querySelector('fieldset').append(...document.querySelectorAll('input[autocomplete=new-password]'))",
        ],
      ]) {
        await form()
        await contents.executeJavaScript(
          `document.querySelectorAll('input[autocomplete=new-password]').forEach(el => el.value = 'fixture-review-secret'); ${setup}; true`,
        )
        const before = bindings
        const messages = captureMessages
        await submit(true)
        await wait(() => captureMessages > messages)
        if (bindings !== before) reviewFailures.push(label)
      }
      assert.deepEqual(
        reviewFailures,
        [],
        "Review regressions must reject unsafe delivery and capture immediate submission",
      )
      answer = async () => 1

      stage("generation review: first legend remains enabled, later legends do not")
      await form(user + "<fieldset disabled><legend>" + next + next + "</legend></fieldset>")
      await generate()
      assert(
        await contents.executeJavaScript(
          "[...document.querySelectorAll('input[autocomplete=new-password]')].every(el => !el.matches(':disabled') && el.value.length === 20)",
        ),
      )
      await clean()
      await form(user + "<fieldset disabled><legend>First</legend><legend>" + next + next + "</legend></fieldset>")
      await assert.rejects(generate())
      await unchanged()

      stage("generation review: revocation while acknowledging capture readiness")
      const sendCommand = contents.debugger.sendCommand.bind(contents.debugger)
      for (const reason of ["lock", "tab", "detached", "offers", "failure"]) {
        await form()
        const before = deliveries
        let intercepted = false
        contents.debugger.sendCommand = (async (method, params, ...rest) => {
          if (
            !intercepted &&
            one.loginBusy &&
            owner.suspended === 0 &&
            method === "Runtime.evaluate" &&
            params?.expression?.startsWith("globalThis.__cmOffers.until = ")
          ) {
            intercepted = true
            if (reason === "lock") {
              vaultAccess.lock()
              await vaultAccess.unlock(win)
            }
            if (reason === "tab") {
              await command({ op: "new" })
              await command({ op: "select", tabID: first })
            }
            if (reason === "detached") win.contentView.removeChildView(one.view)
            if (reason === "offers") await command({ op: "preferences", values: { offerSaveLogins: false } })
            if (reason === "failure") throw new Error("Fixture capture acknowledgement failure")
          }
          return sendCommand(method, params, ...rest)
        }) as typeof contents.debugger.sendCommand
        try {
          await assert.rejects(generate())
          assert(intercepted, "Readiness revocation reaches the production CDP handoff")
          assert.equal(deliveries, before, "No credential dispatch after readiness revocation")
          await unchanged()
        } finally {
          contents.debugger.sendCommand = sendCommand
          if (!win.contentView.children.includes(one.view)) win.contentView.addChildView(one.view)
          await command({ op: "preferences", values: { offerSaveLogins: true } })
        }
      }

      stage("generation: matching registration and change, separate submission and final consent")
      for (const change of [false, true]) {
        const before = readLogins()
        const captures = bindings
        await form(user + (change ? current : "") + next + next)
        const result = await generate(change ? { length: 24, symbols: false } : {})
        const generated: string = await contents.executeJavaScript(
          'document.querySelector("input[autocomplete=new-password]").value',
        )
        secrets.push(generated)
        assert(generated.length === (change ? 24 : 20))
        assert(change ? /^[a-zA-Z0-9]+$/.test(generated) : /[^a-zA-Z0-9]/.test(generated))
        assert(
          await contents.executeJavaScript(
            "[...document.querySelectorAll('input[autocomplete=new-password]')].every(el => el.value === document.querySelector('input[autocomplete=new-password]').value) && window.atomic",
          ),
        )
        if (change)
          assert(
            await contents.executeJavaScript(
              "document.querySelector('input[autocomplete=current-password]').value === 'fixture-current-secret'",
            ),
          )
        assert.equal(await contents.executeJavaScript("window.submissions"), 0)
        assert.equal(bindings, captures, "Filling does not capture or save")
        assert(JSON.stringify(readLogins()) === JSON.stringify(before), "No persistence at fill")
        assert(!JSON.stringify(result).includes(generated), "Renderer response is secret-free")
        assert(!JSON.stringify(browserProfile()).includes(generated))
        assert(!JSON.stringify(await route({ op: "read_state", tabID: first })).includes(generated))
        await clean()
        let finish: ((value: number) => void) | undefined
        answer = async () =>
          new Promise<number>((resolve) => {
            finish = resolve
          })
        await submit()
        await wait(() => !!finish)
        assert(JSON.stringify(readLogins()) === JSON.stringify(before), "User submission still requires final consent")
        finish!(1)
        await wait(() =>
          readLogins().some(
            (row) => row.origin === origin && row.username === "generated-account" && row.password === generated,
          ),
        )
        await wait(() => !one.loginBusy)
        assert(!readFileSync(join(profile!, "profile", "cm-browser"), "utf8").includes(generated))
        answer = async () => 1
      }

      stage("generation: username-free change requires account selection and separate final consent")
      await form(current + next + next)
      const priorAccounts = JSON.stringify(readLogins())
      await generate()
      const selectedSecret: string = await contents.executeJavaScript(
        "document.querySelector('input[autocomplete=new-password]').value",
      )
      secrets.push(selectedSecret)
      assert(JSON.stringify(readLogins()) === priorAccounts)
      let selectionCalls = 0
      let confirm: ((value: number) => void) | undefined
      answer = async () => {
        selectionCalls++
        if (selectionCalls === 1) return 1
        return new Promise<number>((resolve) => {
          confirm = resolve
        })
      }
      await submit()
      await wait(() => !!confirm)
      assert.equal(selectionCalls, 2)
      assert(JSON.stringify(readLogins()) === priorAccounts, "Selection is not save consent")
      confirm!(1)
      await wait(() =>
        readLogins().some(
          (row) => row.origin === origin && row.username === "generated-account" && row.password === selectedSecret,
        ),
      )
      await wait(() => !one.loginBusy)
      answer = async () => 1

      stage("generation: one field, intersected length limits and final save cancellation")
      await form(
        user +
          next.replace(">", ' minlength="24" maxlength="28">') +
          next.replace(">", ' minlength="20" maxlength="24">'),
      )
      await assert.rejects(generate())
      await unchanged()
      await generate({ length: 24 })
      await clean()
      await form(user + next)
      const saved = JSON.stringify(readLogins())
      await generate({ length: 16, symbols: false })
      answer = async () => 0
      const offered = dialogs
      await submit()
      await wait(() => dialogs > offered && !one.loginBusy)
      assert(JSON.stringify(readLogins()) === saved, "Cancelling final save preserves saved password")
      answer = async () => 1

      stage("generation: invalid settings and unsupported forms never dispatch a password")
      for (const settings of [{ length: 15 }, { length: 65 }, { length: 20.5 }, { length: "20" }, { symbols: "yes" }]) {
        await form()
        const before = deliveries
        await assert.rejects(generate(settings))
        assert.equal(deliveries, before)
        await unchanged()
      }
      for (const fields of [
        user + next.replace(">", ' maxlength="15">'),
        user + next.replace(">", ' minlength="65">'),
        user + next.replace(">", ' minlength="invalid">'),
        user + next.replace(">", ' pattern=".*">'),
        user + next.replace('type="password"', 'type="text"'),
        user + current.replace('type="password"', 'type="text"') + next,
        user + next.replace(">", " hidden>"),
        user + next.replace(">", " readonly>"),
        user + next.replace(">", " disabled>"),
        user + next + next + next,
        user + current + current + next,
        user + next + '<input type="password">',
        user + user + next,
        user + next + next.replace(">", ' value="mismatch">'),
        user + next + '<button formaction="https://other.example">Other</button>',
        user + next + '<button formmethod="get">Other</button>',
      ]) {
        await form(fields)
        const before = deliveries
        await assert.rejects(generate())
        assert.equal(deliveries, before)
        assert.equal(await contents.executeJavaScript("window.fillEvents"), 0)
        await clean()
      }
      for (const attributes of ['method="get"', 'method="post" action="https://other.example"']) {
        await form(user + next, attributes)
        await assert.rejects(generate())
        await unchanged()
      }
      await form()
      await contents.executeJavaScript(
        "document.querySelector('input[autocomplete=new-password]').setCustomValidity('unsupported'); true",
      )
      await assert.rejects(generate())
      await unchanged()

      stage("generation: preferences, excluded origins and missing accounts")
      await form()
      await command({ op: "preferences", values: { offerSaveLogins: false } })
      await assert.rejects(generate())
      assert.equal(browserPreferencesState().offerSaveLogins, false)
      await unchanged()
      await command({ op: "preferences", values: { offerSaveLogins: true } })
      getStore("cm-browser").set("loginOfferExclusions", [origin])
      await assert.rejects(generate())
      assert.deepEqual(getStore("cm-browser").get("loginOfferExclusions"), [origin])
      await unchanged()
      await command({ op: "allow-login-offers", origin })
      const accounts = readLogins()
      writeLogins([])
      await form(current + next + next)
      await assert.rejects(generate())
      await unchanged()
      writeLogins(accounts)

      stage("generation: cancel, lock/reunlock, tab, navigation, viewport and access revocation")
      for (const reason of [
        "cancel",
        "lock",
        "tab",
        "navigation",
        "viewport",
        "session",
        "access",
        "offers",
        "expiry",
      ]) {
        stage(`generation: ${reason}`)
        await form()
        answer = async (options) => {
          if (reason === "lock") {
            vaultAccess.lock()
            await vaultAccess.unlock(win)
          }
          if (reason === "tab") {
            await command({ op: "new" })
            await command({ op: "select", tabID: first })
          }
          if (reason === "navigation") await contents.loadURL(url)
          if (reason === "viewport") {
            browserViewport(owner, { sessionID: "smoke", lease: "first", bounds: null })
            browserViewport(owner, {
              sessionID: "smoke",
              lease: "first",
              bounds: { x: 0, y: 100, width: 800, height: 500 },
            })
          }
          if (reason === "session") {
            await browserCommand(owner, "generation-other", { op: "state" })
            browserViewport(owner, {
              sessionID: "generation-other",
              lease: "other",
              bounds: { x: 0, y: 100, width: 800, height: 500 },
            })
            browserViewport(owner, {
              sessionID: "smoke",
              lease: "first",
              bounds: { x: 0, y: 100, width: 800, height: 500 },
            })
          }
          if (reason === "access") await command({ op: "access", tabID: first, enabled: false })
          if (reason === "offers") await command({ op: "preferences", values: { offerSaveLogins: false } })
          if (reason === "expiry") await isolated("document.__cmLoginTicket.expires = 0; true")
          if (["lock", "tab", "navigation", "viewport", "session"].includes(reason)) assert(options.signal?.aborted)
          return reason === "cancel" ? 0 : 1
        }
        const before = deliveries
        if (reason === "cancel") await generate()
        else await assert.rejects(generate())
        if (reason !== "expiry") assert.equal(deliveries, before)
        if (reason === "navigation") await form()
        await unchanged()
        await command({ op: "preferences", values: { offerSaveLogins: true } })
      }

      stage("generation: pre-consent identity/value/constraint changes reject atomically")
      for (const mutation of [
        "document.querySelector('input[autocomplete=new-password]').replaceWith(document.querySelector('input[autocomplete=new-password]').cloneNode())",
        "document.querySelector('form').replaceWith(document.querySelector('form').cloneNode(true))",
        "document.querySelector('input').value = 'different-account'",
        "document.querySelector('input[autocomplete=new-password]').type = 'text'",
        "document.querySelector('input[autocomplete=new-password]').hidden = true",
        "document.querySelector('input[autocomplete=new-password]').maxLength = 21",
        "document.querySelector('input[autocomplete=new-password]').setCustomValidity('changed')",
        "document.querySelector('form').action = '/other'",
        "document.querySelector('form').action = 'https://other.example'",
        "document.querySelector('form').method = 'get'",
        "document.querySelector('button').formAction = 'https://other.example'",
      ]) {
        await form()
        answer = async () => {
          await contents.executeJavaScript(`${mutation}; true`)
          return 1
        }
        await assert.rejects(generate())
        await unchanged()
      }

      stage("generation: queued delivery mutation/expiry, concurrent agent access and generation")
      answer = async () => 1
      for (const mutation of [
        "document.querySelectorAll('input[autocomplete=new-password]')[1].value = 'user-edit'",
        "document.__cmLoginTicket.expires = 0",
      ]) {
        await form()
        intercept = async () => {
          await isolated(`${mutation}; true`)
        }
        await assert.rejects(generate())
        assert(
          await contents.executeJavaScript("document.querySelector('input[autocomplete=new-password]').value === ''"),
        )
        assert.equal(await contents.executeJavaScript("window.fillEvents"), 0)
        await clean()
      }
      stage("generation: dispatched execution expires within five seconds")
      await form()
      intercept = async () => {
        await new Promise((resolve) => setTimeout(resolve, 5100))
      }
      await assert.rejects(generate())
      await unchanged()
      intercept = async () => {
        await assert.rejects(command({ op: "access", tabID: first, enabled: true }))
        await assert.rejects(generate())
      }
      await form()
      await generate()
      await clean()
      intercept = async () => {
        vaultAccess.lock()
        await vaultAccess.unlock(win)
      }
      await form()
      await assert.rejects(generate())
      // Dispatch cannot be recalled. A result error is not a guarantee the already-authorized page stayed unchanged.
      assert.equal(await contents.executeJavaScript("window.submissions"), 0)
      assert(JSON.stringify(readLogins()) === saved)
      await clean()
      intercept = undefined
      await form()
      vaultAccess.lock()
      await assert.rejects(generate())
      await unchanged()
      await vaultAccess.unlock(win)
      dialog.showMessageBox = (async () => ({ response: 1, checkboxChecked: false })) as typeof dialog.showMessageBox
      await command({ op: "access", tabID: first, enabled: true })
      assert(one.agentAccess)
      const before = deliveries
      await assert.rejects(generate())
      assert.equal(deliveries, before)
      await unchanged()
      assert.equal(currentLeaks, 0)
      assert.deepEqual(dialogErrors, [])
      stage("PASS focused generation")
    } finally {
      intercept = undefined
      contents.executeJavaScriptInIsolatedWorld = execute
      contents.debugger.removeListener("message", observe)
      vaultAccess.lock()
      vaultAuthentication.verify = verify
      dialog.showMessageBox = consent
      win.destroy()
    }
    return
  }

  if (process.argv.includes("--registration")) {
    const verify = vaultAuthentication.verify
    const consent = dialog.showMessageBox
    const contents = one.view.webContents
    const origin = new URL(url).origin
    let context = 0
    let captures = 0
    let credentialCaptures = 0
    let currentPasswordCaptures = 0
    let dialogs = 0
    const dialogErrors: unknown[] = []
    let answer: (options: Electron.MessageBoxOptions) => Promise<number> = async () => 1
    const observe = (
      _event: unknown,
      method: string,
      params: { name?: string; executionContextId?: number; payload?: string },
    ) => {
      if (method !== "Runtime.bindingCalled" || !params.name?.startsWith("cmLoginOffer")) return
      context = params.executionContextId!
      captures++
      if (params.payload !== "null") credentialCaptures++
      if (params.payload?.includes("fixture-secret-current")) currentPasswordCaptures++
    }
    contents.debugger.on("message", observe)
    const isolated = async (expression: string) =>
      (await contents.debugger.sendCommand("Runtime.evaluate", { contextId: context, expression, returnByValue: true }))
        .result.value
    const newFields =
      '<input type="password" autocomplete="new-password" value="fixture-secret-new"><input type="password" autocomplete="new-password" value="fixture-secret-new">'
    const currentField = '<input type="password" autocomplete="current-password" value="fixture-secret-current">'
    const userField = '<input autocomplete="username" value="registered">'
    const form = async (fields: string, outcome = "success", attributes = 'method="post"') => {
      await contents.executeJavaScript(`document.body.innerHTML = ${JSON.stringify(`<form ${attributes}>${fields}<button>Submit</button></form>`)};
        window.submissions = 0;
        document.querySelector('form').onsubmit = event => {
          window.submissions++;
          ${
            outcome === "navigate"
              ? ""
              : `event.preventDefault();
          ${outcome === "success" ? "event.target.remove()" : outcome === "failed" ? "event.target.remove(); document.body.insertAdjacentHTML('beforeend', '<p role=alert>Rejected</p>')" : ""}`
          }
        }; true`)
      await new Promise((resolve) => setTimeout(resolve, 450))
      assert.equal(await contents.executeJavaScript("window.submissions"), 0, "Offers never submit the page")
    }
    const submit = async (captured = true) => {
      const before = captures
      const point = await contents.executeJavaScript(
        "(() => { const r=document.querySelector('button').getBoundingClientRect(); return {x:Math.round(r.x+r.width/2),y:Math.round(r.y+r.height/2)} })()",
      )
      contents.sendInputEvent({ type: "mouseDown", button: "left", clickCount: 1, ...point })
      contents.sendInputEvent({ type: "mouseUp", button: "left", clickCount: 1, ...point })
      if (captured) await wait(() => captures > before)
    }
    const quiet = async (expected = dialogs) => {
      await new Promise((resolve) => setTimeout(resolve, 2000))
      assert.equal(dialogs, expected, "Rejected attempts must not prompt")
    }
    const released = async () => {
      await wait(async () => (await isolated("globalThis.__cmOffers.input === null")) === true)
    }
    try {
      vaultAuthentication.verify = async () => {}
      await command({ op: "unlock-vault" })
      await command({ op: "preferences", values: { offerSaveLogins: true } })
      dialog.showMessageBox = (async (_win, options) => {
        try {
          assert(options)
          assert.equal(options.defaultId, 0)
          assert.equal(options.cancelId, 0)
          assert(options.signal)
          assert(!JSON.stringify(options).includes("fixture-secret-"))
          dialogs++
          return { response: await answer(options), checkboxChecked: false }
        } catch (error) {
          // The production watcher catches dialog failures; keep fixture assertions observable.
          dialogErrors.push(error)
          return { response: 0, checkboxChecked: false }
        }
      }) as typeof dialog.showMessageBox
      await new Promise((resolve) => setTimeout(resolve, 800))

      stage("registration: consent, matching confirmation and reference release")
      let finish: ((response: number) => void) | undefined
      answer = async () =>
        new Promise<number>((resolve) => {
          finish = resolve
        })
      await form(userField + newFields)
      await submit()
      assert.equal(await isolated("globalThis.__cmOffers.input.length"), 2)
      await wait(() => !!finish)
      assert.equal(readLogins().length, 0, "No save before consent")
      await released()
      finish!(1)
      await wait(() => readLogins().length === 1)
      assert(readLogins()[0].password === "fixture-secret-new")
      assert.equal(await contents.executeJavaScript("window.submissions"), 1)
      assert.equal(await contents.executeJavaScript("typeof globalThis.__cmOffers"), "undefined")

      stage("registration: visible-account change stores only the new password")
      answer = async () => 1
      await form(userField + currentField + newFields.replaceAll("fixture-secret-new", "fixture-secret-updated"))
      await submit()
      assert.equal(await isolated("globalThis.__cmOffers.input.length"), 3)
      await wait(() => readLogins()[0].password === "fixture-secret-updated")
      await released()

      stage("registration: explicit account selection, exact origin, no previous-step inference")
      saveLogins([
        { origin, username: "other-account", password: "fixture-secret-current" },
        { origin: "https://other.example", username: "foreign-account", password: "fixture-secret-foreign" },
      ])
      const before = readLogins()
      const selected = before.find((row) => row.username === "registered")!
      const index = before.filter((row) => row.origin === origin).findIndex((row) => row.id === selected.id) + 1
      await form('<input autocomplete="username" value="other-account">')
      await submit()
      let step = 0
      answer = async (options) => {
        step++
        assert(!options.detail?.includes("foreign-account"))
        if (step === 1) {
          assert.deepEqual(options.buttons, ["Not now", "1", "2"])
          assert(options.detail?.includes("registered") && options.detail.includes("other-account"))
          assert(readLogins().every((row) => before.some((old) => old.id === row.id && old.password === row.password)))
          return index
        }
        assert(options.detail?.includes("Account: registered"))
        return 1
      }
      await form(currentField + newFields)
      await submit()
      await wait(() => readLogins().find((row) => row.id === selected.id)?.password === "fixture-secret-new")
      assert.equal(step, 2)
      assert(readLogins().find((row) => row.username === "other-account")?.password === "fixture-secret-current")
      await released()

      stage("registration: mismatch, mixed/unmarked, duplicate current and ambiguous username rejection")
      answer = async () => 1
      for (const fields of [
        userField + newFields.replace('value="fixture-secret-new"', 'value="fixture-secret-mismatch"'),
        userField + newFields + '<input type="password" value="fixture-secret-unmarked">',
        userField + currentField + currentField + newFields,
        userField + userField + newFields,
        userField +
          '<input type="password" value="fixture-secret-one"><input type="password" value="fixture-secret-two">',
      ]) {
        const prior = dialogs
        await form(fields.replaceAll("fixture-secret-new", "fixture-secret-ambiguous"))
        await submit()
        await quiet(prior)
        await released()
      }

      stage("registration: revealed credential fields never reach the binding")
      for (const fields of [
        currentField.replace('type="password"', 'type="text"') + newFields,
        userField +
          newFields
            .replace('type="password"', 'type="text"')
            .replace('value="fixture-secret-new"', 'value="fixture-secret-mismatch"'),
      ]) {
        const delivered = credentialCaptures
        const offered = dialogs
        await form(fields)
        await submit()
        await quiet(offered)
        assert.equal(credentialCaptures, delivered, "Revealed credential forms send only revocation, never values")
        await released()
      }

      stage("registration: failed submission and invalid resubmission discard stale candidate")
      const prior = dialogs
      await form(userField + newFields.replaceAll("fixture-secret-new", "fixture-secret-failed"), "failed")
      await submit()
      await quiet(prior)
      await form(userField + newFields.replaceAll("fixture-secret-new", "fixture-secret-stale"), "keep")
      await submit()
      await contents.executeJavaScript(
        "document.querySelector('input[type=password]').value = 'fixture-secret-mismatch'; true",
      )
      await submit()
      await released()
      await contents.executeJavaScript("document.body.replaceChildren(); true")
      await quiet(prior)

      stage("registration: browser validation revokes a prior failed attempt without submit")
      for (const invalidate of [
        "field.required = true; field.value = ''",
        "field.pattern = 'different-username'",
        "field.setCustomValidity('Fixture validation failure')",
      ]) {
        const offered = dialogs
        await form(userField + newFields.replaceAll("fixture-secret-new", "fixture-secret-validation"), "keep")
        await submit()
        assert.equal(await isolated("globalThis.__cmOffers.input.length"), 2)
        const delivered = credentialCaptures
        await contents.executeJavaScript(`(() => {
          window.invalidations = 0;
          document.querySelector('form').addEventListener('invalid', () => window.invalidations++, true);
          const field = document.querySelector('input'); ${invalidate};
        })()`)
        await submit(false)
        await wait(() => contents.executeJavaScript("window.invalidations > 0"))
        assert.equal(await contents.executeJavaScript("window.submissions"), 1, "Invalid resubmission emits no submit")
        await contents.executeJavaScript("document.body.replaceChildren(); true")
        await quiet(offered)
        assert.equal(credentialCaptures, delivered, "Validation failures send no credential payload")
        await released()
        assert(!readLogins().some((row) => row.password === "fixture-secret-validation"))
      }

      stage("registration: secure POST and submitter destination checks")
      for (const attributes of ['method="get"', 'method="post" action="https://other.example"']) {
        await form(
          userField + newFields.replaceAll("fixture-secret-new", "fixture-secret-unsafe"),
          "success",
          attributes,
        )
        await submit()
        assert.equal(await isolated("globalThis.__cmOffers.input"), null)
      }
      await form(
        userField +
          newFields.replaceAll("fixture-secret-new", "fixture-secret-unsafe") +
          '<button formaction="https://other.example">Other</button>',
      )
      await submit()
      await quiet(prior)

      stage("registration: selection and final-consent cancellation and revocation")
      for (const phase of [1, 2]) {
        for (const reason of ["cancel", "lock", "navigation", "selection", "edit"]) {
          stage(`registration: ${reason} during dialog ${phase}`)
          const snapshot = readLogins()
          const previous = snapshot.find((row) => row.origin === origin && row.username === "registered")!
          let calls = 0
          let expectedID = previous.id
          answer = async (options) => {
            calls++
            if (calls !== phase) return calls === 1 ? index : 1
            if (reason === "lock") {
              vaultAccess.lock()
              await vaultAccess.unlock(win)
              assert(options.signal?.aborted)
            }
            if (reason === "navigation") {
              await contents.loadURL(url)
              assert(options.signal?.aborted)
            }
            if (reason === "selection") {
              await command({ op: "new" })
              await command({ op: "select", tabID: first })
              assert(options.signal?.aborted)
            }
            if (reason === "edit") {
              saveLogins([{ origin, username: "registered", password: "fixture-secret-concurrent" }])
              expectedID = readLogins().find((row) => row.origin === origin && row.username === "registered")!.id
              assert.notEqual(expectedID, selected.id, "Concurrent edit replaces the credential ID")
            }
            return reason === "cancel" ? 0 : phase === 1 ? index : 1
          }
          await form(currentField + newFields.replaceAll("fixture-secret-new", "fixture-secret-rejected"))
          await submit()
          await wait(() => calls >= phase && !one.loginBusy)
          const retained = readLogins().filter((row) => row.origin === origin && row.username === "registered")
          assert.equal(retained.length, 1, "The exact-origin account still exists without duplicates")
          assert.equal(retained[0].id, expectedID, `Credential ID retained after ${reason} during dialog ${phase}`)
          assert(
            retained[0].password === (reason === "edit" ? "fixture-secret-concurrent" : previous.password),
            `Credential password retained after ${reason} during dialog ${phase}`,
          )
          assert.equal(calls, reason === "edit" ? 2 : phase)
          writeLogins(snapshot)
        }
      }

      stage("registration: one new-password field with same-origin navigation")
      answer = async () => 1
      await form(
        userField + '<input type="password" autocomplete="new-password" value="fixture-secret-single">',
        "navigate",
        'method="post" action="/registration-success"',
      )
      await submit()
      await wait(() => readLogins().find((row) => row.id === selected.id)?.password === "fixture-secret-single")

      stage("registration: HTTP rejection discards a captured password")
      const rejected = dialogs
      await form(
        userField + newFields.replaceAll("fixture-secret-new", "fixture-secret-http-failed"),
        "navigate",
        'method="post" action="/registration-failed"',
      )
      await submit()
      await wait(() => contents.getURL().endsWith("/registration-failed") && !contents.isLoading())
      await quiet(rejected)
      assert(readLogins().find((row) => row.id === selected.id)?.password === "fixture-secret-single")
      await contents.loadURL(url)

      stage("registration: bounded chooser refuses overflow instead of choosing an arbitrary row")
      saveLogins(
        Array.from({ length: 5 }, (_row, i) => ({ origin, username: `extra-${i}`, password: "fixture-secret-extra" })),
      )
      const bounded = dialogs
      await form(newFields)
      await submit()
      await quiet(bounded)
      await released()

      stage("registration: locked and agent-accessible tabs never capture")
      const delivered = credentialCaptures
      vaultAccess.lock()
      await form(userField + newFields)
      await submit(false)
      await quiet(bounded)
      assert.equal(await contents.executeJavaScript("window.submissions"), 1)
      assert.equal(credentialCaptures, delivered, "Locked vault sends no credential-bearing binding payload")
      await vaultAccess.unlock(win)
      const offerDialog = dialog.showMessageBox
      dialog.showMessageBox = (async () => ({ response: 1, checkboxChecked: false })) as typeof dialog.showMessageBox
      await command({ op: "access", tabID: first, enabled: true })
      dialog.showMessageBox = offerDialog
      assert(one.agentAccess)
      await form(userField + newFields)
      await submit(false)
      await quiet(bounded)
      assert.equal(await contents.executeJavaScript("window.submissions"), 1)
      assert.equal(credentialCaptures, delivered, "Agent-enabled tab sends no credential-bearing binding payload")
      assert(!JSON.stringify(browserProfile()).includes("fixture-secret-"))
      assert.equal(currentPasswordCaptures, 0, "Current passwords never leave the capture world")
      assert.deepEqual(dialogErrors, [], "Native dialog assertions must not be swallowed by the watcher")
      stage("PASS focused registration and password changes")
      console.log(
        "PASS registration: consent, selected account, mismatch, ambiguity, failure, stale resubmission, cancellation, lock, navigation, tab selection, concurrent edit, bounds, private-tab guard",
      )
    } finally {
      vaultAccess.lock()
      contents.debugger.removeListener("message", observe)
      vaultAuthentication.verify = verify
      dialog.showMessageBox = consent
      win.destroy()
    }
    return
  }

  if (process.argv.includes("--offer-patterns")) {
    const verify = vaultAuthentication.verify
    const consent = dialog.showMessageBox
    const contents = one.view.webContents
    let offers = 0
    let captures = 0
    let delivered = 0
    const errors: unknown[] = []
    let answer: (options: Electron.MessageBoxOptions) => Promise<number> = async () => 1
    const fields =
      '<input autocomplete="username" value="pattern-user"><input type="password" autocomplete="current-password" value="fixture-pattern-secret">'
    let offerContext: number | undefined
    const observe = (
      _event: unknown,
      method: string,
      params: { name?: string; payload?: string; executionContextId?: number },
    ) => {
      if (method !== "Runtime.bindingCalled" || !params.name?.startsWith("cmLoginOffer")) return
      offerContext = params.executionContextId
      captures++
      if (params.payload !== "null") delivered++
    }
    contents.debugger.on("message", observe)
    const reset = async (
      html = `<form method="post">${fields}<button>Sign in</button></form>`,
      outcome = "document.querySelector('input[type=password]').value = ''",
    ) => {
      await command({ op: "navigate", tabID: first, url })
      await contents.executeJavaScript(`document.body.innerHTML = ${JSON.stringify(html)};
        window.submissions = 0;
        document.addEventListener('submit', event => {
          event.preventDefault(); window.submissions++; ${outcome}
        }); true`)
      await one.readyLoginOffers!(() => {})
    }
    const click = async (selector = "button") => {
      const point = await contents.executeJavaScript(
        `(() => { const r=document.querySelector(${JSON.stringify(selector)}).getBoundingClientRect(); return {x:Math.round(r.x+r.width/2),y:Math.round(r.y+r.height/2)} })()`,
      )
      contents.sendInputEvent({ type: "mouseDown", button: "left", clickCount: 1, ...point })
      contents.sendInputEvent({ type: "mouseUp", button: "left", clickCount: 1, ...point })
    }
    const quiet = async (before = offers) => {
      await new Promise((resolve) => setTimeout(resolve, 2000))
      assert.equal(offers, before, "Rejected pattern must not prompt")
    }
    try {
      vaultAuthentication.verify = async () => {}
      await command({ op: "unlock-vault" })
      await command({ op: "preferences", values: { offerSaveLogins: true } })
      dialog.showMessageBox = (async (_win, options) => {
        try {
          assert(options)
          assert.equal(options.defaultId, 0)
          assert.equal(options.cancelId, 0)
          assert(options.signal)
          assert(options.detail?.includes("Only save if this sign-in succeeded."))
          assert(!JSON.stringify(options).includes("fixture-pattern-secret"))
          offers++
          return { response: await answer(options), checkboxChecked: false }
        } catch (error) {
          errors.push(error)
          return { response: 0, checkboxChecked: false }
        }
      }) as typeof dialog.showMessageBox

      stage("patterns: persistent visible form requires consent")
      let finish: ((response: number) => void) | undefined
      answer = async () =>
        new Promise<number>((resolve) => {
          finish = resolve
        })
      await reset()
      const before = captures
      await click()
      await new Promise((resolve) => setTimeout(resolve, 100))
      assert.equal(await contents.executeJavaScript("window.submissions"), 1, "Trusted click submits the fixture")
      assert(captures > before, "The isolated binding observes the submission")
      await new Promise((resolve) => setTimeout(resolve, 2200))
      assert.equal(Boolean(finish), true, "A submitted persistent form with script-cleared password should offer")
      assert.equal(readLogins().length, 0, "Nothing saved before consent")
      finish!(1)
      await wait(() =>
        readLogins().some((row) => row.username === "pattern-user" && row.password === "fixture-pattern-secret"),
      )
      assert.equal(await contents.executeJavaScript("!!document.querySelector('form')"), true)
      assert.equal(await contents.executeJavaScript("typeof globalThis.__cmOffers"), "undefined")

      stage("patterns: delayed old cleanup cannot erase an immediate trusted-input resubmission")
      await reset(
        `<form method="post">${fields.replace("pattern-user", "edit-race-user")}<button>Sign in</button></form>`,
        "if (window.submissions > 1) document.querySelector('input[type=password]').value = ''",
      )
      const firstCapture = captures
      await click()
      await wait(() => captures > firstCapture)
      await contents.executeJavaScript(`const password = document.querySelector('input[type=password]');
        password.focus(); password.setSelectionRange(password.value.length, password.value.length);
        password.oninput = event => {
          if (!event.isTrusted) return;
          window.trustedEdit = true; password.form.requestSubmit();
        }; true`)
      const send = contents.debugger.sendCommand.bind(contents.debugger)
      let release!: () => void
      const gate = new Promise<void>((resolve) => {
        release = resolve
      })
      let held = false
      let cleaned = false
      contents.debugger.sendCommand = (async (method, params, ...rest) => {
        if (
          method === "Runtime.evaluate" &&
          params?.expression?.includes("globalThis.__cmOffers.input = null") &&
          !held
        ) {
          held = true
          await gate
          const result = await send(method, params, ...rest)
          cleaned = true
          return result
        }
        return send(method, params, ...rest)
      }) as typeof contents.debugger.sendCommand
      finish = undefined
      try {
        const edited = captures
        contents.sendInputEvent({ type: "keyDown", keyCode: "X" })
        contents.sendInputEvent({ type: "char", keyCode: "x" })
        contents.sendInputEvent({ type: "keyUp", keyCode: "X" })
        await wait(() => held && captures >= edited + 2)
        assert.equal(await contents.executeJavaScript("window.trustedEdit && window.submissions === 2"), true)
        release()
        await wait(() => cleaned)
        await new Promise((resolve) => setTimeout(resolve, 2200))
        assert.equal(Boolean(finish), true, "Delayed old cleanup must preserve the immediate resubmission snapshot")
        assert(!readLogins().some((row) => row.username === "edit-race-user"))
        finish!(1)
        await wait(() =>
          readLogins().some((row) => row.username === "edit-race-user" && row.password === "fixture-pattern-secretx"),
        )
      } finally {
        release()
        ;(finish as ((response: number) => void) | undefined)?.(0)
        contents.debugger.sendCommand = send
      }

      stage("patterns: delayed success-check acknowledgements respect attempt and document ownership")
      answer = async () => 0
      const acknowledgementFailures: string[] = []
      for (const scenario of ["hash", "history", "positive", "newer", "document"]) {
        await reset(
          `<form method="post" action="${url}login">${fields.replace("pattern-user", `ack-${scenario}`)}<button>Sign in</button></form>`,
          scenario === "positive"
            ? "document.querySelector('input[type=password]').value = ''"
            : "if (window.submissions === 1) document.body.insertAdjacentHTML('beforeend', '<p role=alert>Rejected</p>'); else document.querySelector('input[type=password]').value = ''",
        )
        const send = contents.debugger.sendCommand.bind(contents.debugger)
        let release!: () => void
        const gate = new Promise<void>((resolve) => {
          release = resolve
        })
        let held = false
        let acknowledged = false
        let observed: unknown
        contents.debugger.sendCommand = (async (method, params, ...rest) => {
          const result = await send(method, params, ...rest)
          if (method === "Runtime.evaluate" && params?.expression === loginOfferSucceeded && !held) {
            observed = result.exceptionDetails ? "exception" : result.result?.value
            held = true
            await gate
            acknowledged = true
          }
          return result
        }) as typeof contents.debugger.sendCommand
        const offered = offers
        try {
          await click()
          await wait(() => held)
          assert.equal(observed, scenario === "positive" ? true : null)
          if (scenario === "document") {
            await contents.loadURL(`${url}ack-document`)
            assert.equal(await contents.executeJavaScript("typeof window.submissions"), "undefined")
          } else {
            await contents.executeJavaScript(`document.querySelector('[role=alert]')?.remove();
              ${scenario === "hash" ? "location.hash = 'ack-route'" : "history.pushState({}, '', '?ack-route')"};
              document.querySelector('input[type=password]').value = ${JSON.stringify(scenario === "positive" ? "still-pending" : scenario === "newer" ? "fixture-pattern-secret-newer" : "")};
              true`)
            if (scenario === "newer") {
              const prior = delivered
              await click()
              await wait(() => delivered > prior)
            }
            assert.equal(await contents.executeJavaScript("window.submissions"), scenario === "newer" ? 2 : 1)
          }
          release()
          await wait(() => acknowledged)
          await new Promise((resolve) => setTimeout(resolve, 2200))
          const expected = offered + (["newer", "document"].includes(scenario) ? 1 : 0)
          if (offers !== expected)
            acknowledgementFailures.push(`${scenario}: expected ${expected - offered} offers, got ${offers - offered}`)
          if (scenario === "positive") {
            await contents.executeJavaScript("document.querySelector('input[type=password]').value = ''; true")
            await wait(() => offers === offered + 1)
          }
        } finally {
          release()
          contents.debugger.sendCommand = send
        }
      }
      assert.deepEqual(acknowledgementFailures, [])

      stage("patterns: submitted persistent forms survive hash and history navigation")
      answer = async () => 1
      const navigationFailures: string[] = []
      for (const [name, navigate] of [
        ["hash", "location.hash = 'signed-in'"],
        ["history", "history.pushState({}, '', '?signed-in')"],
      ]) {
        await reset(
          `<form method="post" action="${url}login">${fields.replace("pattern-user", `route-${name}`)}<button>Sign in</button></form>`,
          `document.querySelector('input[type=password]').value = ''; ${navigate}`,
        )
        const prior = captures
        await click()
        await wait(() => captures > prior)
        await wait(() => contents.getURL() !== url)
        assert.equal(
          await contents.executeJavaScript(
            "window.submissions === 1 && document.querySelector('input[type=password]').value === ''",
          ),
          true,
        )
        const snapshot = await contents.debugger.sendCommand("Runtime.evaluate", {
          contextId: offerContext,
          expression: `(() => {
            const state = globalThis.__cmOffers;
            const login = state?.login;
            return { retained: !!login, actionUnchanged: login?.form.action === login?.action,
              destinationsUnchanged: !!login?.elements.every((el, i) =>
                (el.hasAttribute('formaction') ? el.formAction : login.form.action) === login.destinations[i][0] &&
                (el.hasAttribute('formmethod') ? el.formMethod : login.form.method) === login.destinations[i][1]) };
          })()`,
          returnByValue: true,
        })
        assert.deepEqual(snapshot.result?.value, { retained: true, actionUnchanged: true, destinationsUnchanged: true })
        await new Promise((resolve) => setTimeout(resolve, 2200))
        if (!readLogins().some((row) => row.username === `route-${name}` && row.password === "fixture-pattern-secret"))
          navigationFailures.push(`${name} navigation lost the submitted persistent-form snapshot`)
      }
      assert.deepEqual(navigationFailures, [])

      stage("patterns: formless Enter associates the same fields with a native POST")
      answer = async () => 1
      await reset(
        fields.replace("pattern-user", "formless-user"),
        "event.target.remove(); document.querySelectorAll('input').forEach(el => el.remove())",
      )
      await contents.executeJavaScript(`document.querySelector('input[type=password]').onkeydown = event => {
        if (event.key !== 'Enter') return;
        event.preventDefault();
        const form = document.createElement('form');
        form.id = 'login'; form.method = 'post'; document.body.append(form);
        document.querySelectorAll('input').forEach(el => el.setAttribute('form', form.id));
        form.requestSubmit();
      }; document.querySelector('input[type=password]').focus(); true`)
      const prior = captures
      contents.sendInputEvent({ type: "keyDown", keyCode: "Return" })
      contents.sendInputEvent({ type: "keyUp", keyCode: "Return" })
      await wait(() => captures > prior)
      assert.equal(await contents.executeJavaScript("window.submissions"), 1)
      await new Promise((resolve) => setTimeout(resolve, 2200))
      assert(
        readLogins().some((row) => row.username === "formless-user" && row.password === "fixture-pattern-secret"),
        "Formless native-backed submission should save only after consent",
      )
      stage("patterns: routes revalidate effective destinations")
      answer = async () => 0
      for (const mutation of [
        "document.querySelector('button').formAction = '/changed'",
        "document.querySelector('button').formMethod = 'get'",
        "document.querySelector('form').removeAttribute('action')",
      ]) {
        await reset(
          `<form method="post" action="${url}login">${fields}<button>Sign in</button></form>`,
          `document.querySelector('input[type=password]').value = ''; ${mutation}; history.pushState({}, '', '?changed')`,
        )
        const prior = captures
        const offered = offers
        await click()
        await wait(() => captures > prior)
        await quiet(offered)
      }

      stage("patterns: real document navigation retains only eligible candidates")
      for (const destination of ["welcome", "registration-failed"]) {
        answer = async () => 1
        await reset(
          `<form method="post" action="${url}login">${fields.replace("pattern-user", `document-${destination}`)}<button>Sign in</button></form>`,
          `document.querySelector('input[type=password]').value = ''; location.href = '/${destination}'`,
        )
        const prior = captures
        const offered = offers
        await click()
        await wait(() => captures > prior)
        await wait(() => contents.getURL() === `${url}${destination}` && !contents.isLoading())
        assert.equal(await contents.executeJavaScript("typeof window.submissions"), "undefined")
        if (destination === "welcome") {
          await wait(() =>
            readLogins().some(
              (row) => row.username === `document-${destination}` && row.password === "fixture-pattern-secret",
            ),
          )
        } else {
          await quiet(offered)
          assert(!readLogins().some((row) => row.username === `document-${destination}`))
        }
      }

      stage("patterns: same-document navigation aborts open consent")
      let routeConsent: AbortSignal | undefined
      finish = undefined
      answer = async (options) => {
        routeConsent = options.signal
        return new Promise<number>((resolve) => {
          finish = resolve
        })
      }
      await reset(
        `<form method="post" action="${url}login">${fields.replace("pattern-user", "route-consent")}<button>Sign in</button></form>`,
      )
      await click()
      await wait(() => !!finish)
      try {
        await contents.executeJavaScript("history.pushState({}, '', '?during-consent'); true")
        await wait(() => !!routeConsent?.aborted)
        finish!(1)
        await wait(() => !one.loginBusy)
        assert(!readLogins().some((row) => row.username === "route-consent"))
      } finally {
        ;(finish as ((response: number) => void) | undefined)?.(0)
      }

      stage("patterns: rejection signals clear attempts even after the signal disappears")
      answer = async () => 0
      for (const outcome of [
        "document.body.insertAdjacentHTML('beforeend', '<p role=alert>Rejected</p>')",
        "document.querySelector('input[type=password]').setAttribute('aria-invalid', 'true')",
        "document.querySelector('form').style.display = 'none'",
      ]) {
        await reset(undefined, outcome)
        const prior = captures
        const offered = offers
        await click()
        await wait(() => captures > prior)
        await quiet(offered)
        await contents.executeJavaScript(
          "document.querySelector('[role=alert]')?.remove(); document.querySelector('input[type=password]').removeAttribute('aria-invalid'); document.querySelector('form').remove(); history.pushState({}, '', '?rejected'); true",
        )
        await quiet(offered)
      }

      stage("patterns: route, text and HTTP 200 without submission do not offer")
      await reset()
      const unsubmitted = delivered
      const offered = offers
      await contents.executeJavaScript(
        "fetch('/').then(() => { document.querySelector('form').remove(); history.pushState({}, '', '?welcome'); location.hash = 'unsubmitted'; document.body.append('Signed in') }); true",
      )
      await quiet(offered)
      assert.equal(delivered, unsubmitted)

      stage("patterns: invalid resubmission and trusted edits revoke a pending attempt")
      for (const invalid of [true, false]) {
        await reset(undefined, "")
        const prior = captures
        const offered = offers
        await click()
        await wait(() => captures > prior)
        if (invalid) {
          await contents.executeJavaScript(
            "document.querySelector('input[type=password]').setCustomValidity('Rejected'); true",
          )
          const captured = captures
          await click()
          await wait(() => captures > captured)
        } else {
          await contents.executeJavaScript(
            "document.querySelector('input[type=password]').focus(); document.querySelector('input[type=password]').select(); true",
          )
          const captured = captures
          contents.sendInputEvent({ type: "keyDown", keyCode: "Backspace" })
          contents.sendInputEvent({ type: "keyUp", keyCode: "Backspace" })
          await wait(() => captures > captured)
        }
        await contents.executeJavaScript("document.querySelector('form').remove(); location.hash = 'revoked'; true")
        await quiet(offered)
      }

      stage("patterns: repeated submissions retain only the latest password, cancellation does not save")
      await reset(undefined, "if (window.submissions > 1) document.querySelector('input[type=password]').value = ''")
      const repeated = captures
      await click()
      await wait(() => captures > repeated)
      await contents.executeJavaScript(
        "document.querySelector('input[type=password]').value = 'fixture-pattern-secret-latest'; true",
      )
      const secondAttempt = captures
      const cancelled = offers
      await click()
      await wait(() => captures > secondAttempt)
      await wait(() => offers > cancelled)
      await wait(() => !one.loginBusy)
      assert(readLogins().find((row) => row.username === "pattern-user")?.password === "fixture-pattern-secret")
      answer = async () => 1
      await contents.executeJavaScript(
        "document.querySelector('input[type=password]').value = 'fixture-pattern-secret-latest'; true",
      )
      const thirdAttempt = captures
      await click()
      await wait(() => captures > thirdAttempt)
      await wait(
        () => readLogins().find((row) => row.username === "pattern-user")?.password === "fixture-pattern-secret-latest",
      )

      stage("patterns: formless scope and unsafe native destinations")
      const associate = `const form = document.createElement('form');
        form.id = 'login'; form.method = 'post'; document.body.append(form);
        document.querySelectorAll('input').forEach(el => el.setAttribute('form', form.id));`
      const enter = async (selector = "input[type=password]") => {
        await contents.executeJavaScript(`document.querySelector(${JSON.stringify(selector)}).focus(); true`)
        contents.sendInputEvent({ type: "keyDown", keyCode: "Return" })
        contents.sendInputEvent({ type: "keyUp", keyCode: "Return" })
      }
      for (const [html, script, selector] of [
        [fields, `${associate} form.action = 'https://other.example'; form.requestSubmit()`, "input[type=password]"],
        [fields, `${associate} form.method = 'get'; form.requestSubmit()`, "input[type=password]"],
        [
          fields,
          `${associate} document.querySelector('input[autocomplete=username]').style.display = 'none'; form.requestSubmit()`,
          "input[type=password]",
        ],
        [
          fields,
          `${associate} const image = document.createElement('input'); image.type = 'image'; image.setAttribute('form', form.id); image.formAction = 'https://other.example'; document.body.append(image); form.requestSubmit()`,
          "input[type=password]",
        ],
        [
          fields.replace('type="password"', 'type="text"'),
          `${associate} form.requestSubmit()`,
          "input[autocomplete=current-password]",
        ],
        [
          fields.replace('autocomplete="current-password"', 'autocomplete="new-password"'),
          `${associate} form.requestSubmit()`,
          "input[type=password]",
        ],
        [
          fields + '<input autocomplete="username" value="ambiguous">',
          `${associate} form.requestSubmit()`,
          "input[type=password]",
        ],
        [
          fields.replace('autocomplete="username"', 'style="display:none" autocomplete="username"'),
          `${associate} form.requestSubmit()`,
          "input[type=password]",
        ],
        [fields + '<button type="button">Unrelated</button>', `${associate} form.requestSubmit()`, "button"],
        [
          fields,
          "fetch('/').then(() => document.querySelectorAll('input').forEach(el => el.remove()))",
          "input[type=password]",
        ],
        [fields, `setTimeout(() => { ${associate} form.requestSubmit() }, 50)`, "input[type=password]"],
        [
          fields,
          `${associate} document.querySelector('input[type=password]').outerHTML = '<input form=login type=password autocomplete=current-password value=fixture-pattern-secret>'; form.requestSubmit()`,
          "input[type=password]",
        ],
      ]) {
        await reset(html, "document.querySelectorAll('form,input').forEach(el => el.remove())")
        const prior = delivered
        const offered = offers
        await contents.executeJavaScript(`document.querySelector(${JSON.stringify(selector)}).onkeydown = event => {
          if (event.key !== 'Enter') return; event.preventDefault(); ${script}
        }; true`)
        await enter(selector)
        await new Promise((resolve) => setTimeout(resolve, 150))
        assert.equal(delivered, prior, "Unsupported formless patterns must not deliver credentials")
        assert.equal(offers, offered)
      }

      stage("patterns: formless same-origin username/password steps")
      await reset(
        '<input autocomplete="username" value="step-user">',
        "document.querySelectorAll('form,input').forEach(el => el.remove())",
      )
      await contents.executeJavaScript(`document.querySelector('input').onkeydown = event => {
        if (event.key !== 'Enter') return; event.preventDefault(); ${associate} form.requestSubmit();
      }; true`)
      const step = delivered
      await enter("input")
      await wait(() => delivered > step)
      await contents.executeJavaScript(`document.body.innerHTML = '<input type=password autocomplete=current-password value=fixture-pattern-secret-step>';
        document.querySelector('input').onkeydown = event => {
          if (event.key !== 'Enter') return; event.preventDefault(); ${associate} form.requestSubmit();
        }; true`)
      await enter()
      await wait(() =>
        readLogins().some((row) => row.username === "step-user" && row.password === "fixture-pattern-secret-step"),
      )

      stage("patterns: lock/reunlock and agent access revoke before offer")
      for (const reason of ["lock", "agent"]) {
        await reset(undefined, "")
        const prior = captures
        const offered = offers
        await click()
        await wait(() => captures > prior)
        if (reason === "lock") {
          vaultAccess.lock()
          await command({ op: "unlock-vault" })
        } else {
          const offerConsent = dialog.showMessageBox
          dialog.showMessageBox = (async () => ({
            response: 1,
            checkboxChecked: false,
          })) as typeof dialog.showMessageBox
          try {
            await command({ op: "access", tabID: first, enabled: true })
            assert(one.agentAccess)
            await command({ op: "access", tabID: first, enabled: false })
          } finally {
            dialog.showMessageBox = offerConsent
          }
        }
        await contents.executeJavaScript("document.querySelector('form').remove(); location.hash = 'revoked'; true")
        await quiet(offered)
      }
      assert.deepEqual(errors, [])
      stage("PASS focused offer patterns")
    } finally {
      vaultAccess.lock()
      contents.debugger.removeListener("message", observe)
      vaultAuthentication.verify = verify
      dialog.showMessageBox = consent
      win.destroy()
    }
    return
  }

  if (process.argv.includes("--offers")) {
    const verify = vaultAuthentication.verify
    const consent = dialog.showMessageBox
    try {
      stage("focused automatic login offer")
      vaultAuthentication.verify = async () => {}
      await command({ op: "unlock-vault" })
      await command({ op: "preferences", values: { offerSaveLogins: true } })
      let offers = 0
      dialog.showMessageBox = (async (_win, options) => {
        assert.equal(options?.defaultId, 0)
        assert.equal(options?.cancelId, 0)
        assert(!JSON.stringify(options).includes("synthetic-offer-secret"))
        offers++
        return { response: 1, checkboxChecked: false }
      }) as typeof dialog.showMessageBox
      await one.view.webContents.executeJavaScript(
        `document.body.innerHTML = '<form method="post"><input autocomplete="username" value="synthetic-offer-user"><input type="password" value="synthetic-offer-secret"><button>Sign in</button></form>'; document.querySelector('form').onsubmit = event => { event.preventDefault(); event.target.remove(); document.body.append('Welcome') }; true`,
      )
      await new Promise((resolve) => setTimeout(resolve, 1200))
      const point = await one.view.webContents.executeJavaScript(
        "(() => { const r=document.querySelector('button').getBoundingClientRect(); return {x:Math.round(r.x+r.width/2),y:Math.round(r.y+r.height/2)} })()",
      )
      one.view.webContents.sendInputEvent({ type: "mouseDown", button: "left", clickCount: 1, ...point })
      one.view.webContents.sendInputEvent({ type: "mouseUp", button: "left", clickCount: 1, ...point })
      stage("focused offer: waiting for form submission")
      await wait(() => one.view.webContents.executeJavaScript("!document.querySelector('form')"))
      stage("focused offer: waiting for vault save")
      await wait(() =>
        readLogins().some(
          (row) => row.username === "synthetic-offer-user" && row.password === "synthetic-offer-secret",
        ),
      )
      assert.equal(offers, 1)
      stage("PASS focused offers")
    } finally {
      vaultAccess.lock()
      vaultAuthentication.verify = verify
      dialog.showMessageBox = consent
      win.destroy()
    }
    return
  }

  if (process.argv.includes("--contacts")) {
    const verify = vaultAuthentication.verify
    const consent = dialog.showMessageBox
    const storage = getStore("cm-browser")
    const contact = {
      id: randomUUID(),
      revision: randomUUID(),
      label: "Synthetic contact",
      values: {
        name: "Test Person",
        email: "person@example.test",
        tel: "+27 11 123 4567",
        "street-address": "1 Test Street\nUnit 2",
        "address-level1": "Gauteng",
        "address-level2": "Johannesburg",
        "postal-code": "2000",
        country: "ZA",
      },
    }
    const form = `<form method="post"><input autocomplete="name"><input autocomplete="email">
      <input autocomplete="tel"><textarea autocomplete="street-address"></textarea>
      <input autocomplete="address-level1"><input autocomplete="address-level2"><input autocomplete="postal-code">
      <select autocomplete="country"><option value="">Choose</option><option value="ZA">South Africa</option>
      <option value="JP">Japan</option></select>
      <input style="display:none" autocomplete="name" value="hidden">
      <fieldset disabled><input autocomplete="email" value="disabled"></fieldset></form>`
    const reset = async (html = form) => {
      await one.view.webContents.loadURL(url)
      await one.view.webContents.executeJavaScript(`document.body.innerHTML = ${JSON.stringify(html)}`)
    }
    const values = () =>
      one.view.webContents.executeJavaScript(
        "[...document.querySelectorAll('input,textarea,select')].map(el=>el.value)",
      )
    const fill = () =>
      command({ op: "contact-fill", tabID: first, id: contact.id, revision: readContacts()[0].revision })
    try {
      stage("contact storage and validation")
      await assert.rejects(command({ op: "contact-save", contact, create: true }))
      vaultAuthentication.verify = async () => {}
      dialog.showMessageBox = (async () => ({ response: 1, checkboxChecked: false })) as typeof dialog.showMessageBox
      await command({ op: "unlock-vault" })
      await command({ op: "contact-save", contact, create: true })
      assert.equal(readContacts()[0].values.name, contact.values.name)
      assert(!JSON.stringify(storage.store).includes(contact.values.email))
      for (const invalid of [
        { ...contact, values: {} },
        { ...contact, label: "bad\nlabel" },
        { ...contact, values: { country: "Japan" } },
        { ...contact, values: { email: "x\nBcc:y" } },
        { ...contact, values: { password: "not-a-contact" } },
      ])
        assert.throws(() => requireContact(invalid))
      await assert.rejects(command({ op: "contact-save", contact, create: true }))
      await assert.rejects(command({ op: "contact-save", contact, create: false }))
      stage("contact explicit preview and fill")
      await reset()
      dialog.showMessageBox = (async (_win, options) => {
        assert.equal(options?.defaultId, 0)
        assert.equal(options?.cancelId, 0)
        assert(options?.detail?.includes(new URL(url).origin))
        assert(options?.detail?.includes(contact.values.email))
        return { response: 0, checkboxChecked: false }
      }) as typeof dialog.showMessageBox
      await fill()
      assert.equal((await values())[0], "")
      dialog.showMessageBox = (async () => ({ response: 1, checkboxChecked: false })) as typeof dialog.showMessageBox
      await fill()
      assert.deepEqual(await values(), [...Object.values(contact.values), "hidden", "disabled"])
      stage("contact detached views and queued delivery")
      await reset()
      browserViewport(owner, { sessionID: "smoke", lease: "first", bounds: { x: 0, y: 100, width: 0, height: 0 } })
      await assert.rejects(fill())
      browserViewport(owner, { sessionID: "smoke", lease: "first", bounds: { x: 0, y: 100, width: 800, height: 500 } })
      dialog.showMessageBox = (async () => {
        browserViewport(owner, { sessionID: "smoke", lease: "first", bounds: { x: 0, y: 100, width: 0, height: 0 } })
        return { response: 1, checkboxChecked: false }
      }) as typeof dialog.showMessageBox
      await assert.rejects(fill())
      assert.equal((await values())[0], "")
      browserViewport(owner, { sessionID: "smoke", lease: "first", bounds: { x: 0, y: 100, width: 800, height: 500 } })
      dialog.showMessageBox = (async () => ({ response: 1, checkboxChecked: false })) as typeof dialog.showMessageBox
      const executeContact = one.view.webContents.executeJavaScriptInIsolatedWorld.bind(one.view.webContents)
      let deliveryChecked = false
      one.view.webContents.executeJavaScriptInIsolatedWorld = async (world, scripts, gesture) => {
        if (scripts.some((script) => script.code.includes("Contact delivery expired"))) {
          deliveryChecked = true
          const current = readContacts()[0]
          await assert.rejects(
            command({ op: "contact-save", contact: { ...current, label: "Queued edit" }, create: false }),
          )
          await assert.rejects(command({ op: "contact-delete", id: current.id, revision: current.revision }))
          assert.equal(readContacts()[0].label, current.label)
        }
        return executeContact(world, scripts, gesture)
      }
      try {
        await fill()
        assert(deliveryChecked)
      } finally {
        one.view.webContents.executeJavaScriptInIsolatedWorld = executeContact
      }
      stage("contact hostile fields and navigation races")
      for (const html of [
        form.replace("</form>", '<input autocomplete="name"></form>'),
        form.replace('method="post"', 'method="get"'),
        form.replace('method="post"', 'method="post" action="https://other.example"'),
        form.replace('autocomplete="name"', 'autocomplete="name" maxlength="2"'),
        form.replace('value="ZA"', 'value="XX"'),
        form.replace('autocomplete="email"', 'autocomplete="shipping email"'),
        form.replace('<textarea autocomplete="street-address"></textarea>', '<input autocomplete="street-address">'),
      ]) {
        await reset(html)
        await assert.rejects(fill())
        assert.equal((await values())[0], "")
      }
      for (const mutation of [
        "document.querySelector('input').outerHTML='<input autocomplete=name>'",
        "document.querySelector('input').value='changed'",
        "document.querySelector('form').action='https://other.example'",
        "document.querySelector('select').innerHTML='<option value=ZA>Changed</option>'",
      ]) {
        await reset()
        dialog.showMessageBox = (async () => {
          await one.view.webContents.executeJavaScript(mutation)
          return { response: 1, checkboxChecked: false }
        }) as typeof dialog.showMessageBox
        await assert.rejects(fill())
      }
      await reset()
      dialog.showMessageBox = (async () => {
        await one.view.webContents.loadURL(url)
        return { response: 1, checkboxChecked: false }
      }) as typeof dialog.showMessageBox
      await assert.rejects(fill())
      await reset()
      dialog.showMessageBox = (async () => {
        vaultAccess.lock()
        await vaultAccess.unlock(win)
        return { response: 1, checkboxChecked: false }
      }) as typeof dialog.showMessageBox
      await assert.rejects(fill())
      assert.equal((await values())[0], "")
      dialog.showMessageBox = (async () => {
        const row = readContacts()[0]
        await command({ op: "contact-save", contact: { ...row, label: "Changed contact" }, create: false })
        return { response: 1, checkboxChecked: false }
      }) as typeof dialog.showMessageBox
      await assert.rejects(fill())
      assert.equal((await values())[0], "")
      dialog.showMessageBox = (async () => ({ response: 1, checkboxChecked: false })) as typeof dialog.showMessageBox
      await command({ op: "access", tabID: first, enabled: true })
      await assert.rejects(fill())
      await command({ op: "access", tabID: first, enabled: false })
      stage("international contacts, expiry, deletion and corruption")
      const row = readContacts()[0]
      await command({
        op: "contact-save",
        create: false,
        contact: {
          ...row,
          values: {
            name: "\u5c71\u7530 \u592a\u90ce",
            "address-level1": "\u6771\u4eac\u90fd",
            "address-level2": "\u65b0\u5bbf\u533a",
            "postal-code": "160-0022",
            country: "JP",
          },
        },
      })
      await reset()
      await fill()
      assert.equal((await values())[0], "\u5c71\u7530 \u592a\u90ce")
      assert.equal((await values())[7], "JP")
      await reset()
      await one.view.webContents.executeJavaScriptInIsolatedWorld(999, [
        {
          code: prepareContactScript(new URL(url).origin, "expired", ["name"]),
        },
      ])
      await assert.rejects(
        one.view.webContents.executeJavaScriptInIsolatedWorld(999, [
          {
            code: completeContactScript(new URL(url).origin, "expired", { name: "Not delivered" }, 0),
          },
        ]),
      )
      const encrypted = storage.get("contacts")
      saveLogins([{ origin: url, username: "unaffected-user", password: "synthetic-unaffected-secret" }])
      storage.set("contacts", "corrupt")
      assert.throws(() => readContacts())
      assert.equal(browserProfile().contactsUnavailable, true)
      assert.equal(browserProfile().vaultAvailable, true)
      assert.equal(browserProfile().credentials[0].username, "unaffected-user")
      await assert.rejects(command({ op: "contact-save", contact, create: false }))
      assert.equal(storage.get("contacts"), "corrupt")
      storage.set("contacts", encrypted)
      vaultAccess.lock()
      assert(!JSON.stringify(browserProfile()).includes("Changed contact"))
      await assert.rejects(command({ op: "contact-fill", tabID: first, id: contact.id, revision: row.revision }))
      await vaultAccess.unlock(win)
      dialog.showMessageBox = (async () => ({ response: 0, checkboxChecked: false })) as typeof dialog.showMessageBox
      await command({ op: "contact-delete", id: contact.id, revision: readContacts()[0].revision })
      assert.equal(readContacts().length, 1)
      dialog.showMessageBox = (async () => ({ response: 1, checkboxChecked: false })) as typeof dialog.showMessageBox
      await command({ op: "contact-delete", id: contact.id, revision: readContacts()[0].revision })
      assert.deepEqual(readContacts(), [])
      stage("PASS focused contacts")
    } finally {
      vaultAccess.lock()
      vaultAuthentication.verify = verify
      dialog.showMessageBox = consent
      win.destroy()
    }
    return
  }

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
    if (name === "download-cancel") await wait(() => !existsSync(destination))
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
