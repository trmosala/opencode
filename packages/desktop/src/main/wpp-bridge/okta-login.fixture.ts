import assert from "node:assert/strict"
import { app, BrowserWindow, session } from "electron"
import {
  WPP_OKTA_ORIGIN,
  prepareOktaLoginScript,
  completeOktaLoginScript,
  clearOktaLoginScript,
} from "./okta-login-form"
import { prepareLoginScript } from "../browser/login-form"

const directory = process.env.CM_WPP_LOGIN_FIXTURE_DIR
if (!directory) throw new Error("Missing isolated fixture directory")
app.setPath("userData", directory)
app.setPath("sessionData", directory)

const username = '<input id="identifier" name="identifier" autocomplete="username">'
const password =
  '<input id="username" name="username" value="fixture@wpp.test" style="display:none"><label for="credentials.passcode">Password</label><input id="credentials.passcode" name="credentials.passcode" type="password" autocomplete="current-password">'
const login = { origin: WPP_OKTA_ORIGIN, username: "fixture@wpp.test", password: "fixture-secret" }
const html = (fields = username, attributes = "") =>
  `<!doctype html><html><body><div id="okta-sign-in"><form ${attributes}>${fields}<button>Verify</button></form></div></body></html>`

async function run() {
  await app.whenReady()
  const isolated = session.fromPartition("cm-wpp-login-fixture")
  // Intercept every HTTPS request in this disposable partition. No WPP traffic or real credentials.
  isolated.protocol.handle("https", () => new Response(html(), { headers: { "content-type": "text/html" } }))
  const win = new BrowserWindow({
    show: false,
    width: 1280,
    height: 900,
    webPreferences: { session: isolated, sandbox: true, contextIsolation: true, nodeIntegration: false },
  })
  const contents = win.webContents
  const execute = (code: string) => contents.executeJavaScriptInIsolatedWorld(999, [{ code }])
  const reset = async (fields = username, attributes = "", origin = WPP_OKTA_ORIGIN) => {
    await win.loadURL(`${origin}/oauth2/v1/authorize`)
    await contents.executeJavaScript(
      `document.body.innerHTML = ${JSON.stringify(html(fields, attributes).split("<body>")[1].split("</body>")[0])}; true`,
    )
  }
  try {
    await reset()
    assert.equal(await execute(prepareOktaLoginScript("username")), "username")
    assert(!completeOktaLoginScript("username", login, "username", Date.now() + 5000).includes(login.password))
    await assert.rejects(execute(prepareLoginScript(WPP_OKTA_ORIGIN, "generic", "username")))
    await execute(completeOktaLoginScript("username", login, "username", Date.now() + 5000))
    assert.equal(await contents.executeJavaScript("document.getElementById('identifier').value"), login.username)

    await reset(password)
    await contents.executeJavaScript(
      `['input', 'change', 'submit'].forEach(name => document.querySelector('form').addEventListener(name, event => { document.body.dataset[name] = String(Number(document.body.dataset[name] || 0) + 1); if (name === 'submit') event.preventDefault() })); true`,
    )
    assert.equal(await execute(prepareOktaLoginScript("password")), "password")
    await execute(completeOktaLoginScript("password", login, "password", Date.now() + 5000))
    assert.equal(
      await contents.executeJavaScript("document.getElementById('credentials.passcode').value"),
      login.password,
    )
    assert.deepEqual(await contents.executeJavaScript("({...document.body.dataset})"), { input: "1", change: "1" })

    await reset(password)
    await execute(prepareOktaLoginScript("mismatch"))
    await assert.rejects(
      execute(
        completeOktaLoginScript("mismatch", { ...login, username: "other@wpp.test" }, "password", Date.now() + 5000),
      ),
    )
    assert.equal(await contents.executeJavaScript("document.getElementById('credentials.passcode').value"), "")

    for (const invalid of [
      username + username,
      password + '<input type="password">',
      password.replace("current-password", "new-password"),
      password.replace('type="password"', 'type="text"'),
      password.replace('style="display:none"', ""),
      password.replace('id="credentials.passcode"', 'id="otp"'),
      username.replace('autocomplete="username"', ""),
      password.replace('name="username"', 'name="other"'),
    ]) {
      await reset(invalid)
      await assert.rejects(execute(prepareOktaLoginScript("invalid")))
    }
    for (const attributes of ['method="get"', 'method="post"', 'action="/login"', 'action="https://other.test"']) {
      await reset(username, attributes)
      await assert.rejects(execute(prepareOktaLoginScript("form")))
    }
    await reset(username + '<button formaction="https://other.test">Send</button>')
    await assert.rejects(execute(prepareOktaLoginScript("submitter")))
    await reset(username, "", "https://wpp.okta.com.other.test")
    await assert.rejects(execute(prepareOktaLoginScript("origin")))

    for (const mutation of [
      "document.getElementById('identifier').outerHTML = document.getElementById('identifier').outerHTML",
      "document.querySelector('form').setAttribute('action', 'https://other.test')",
      "document.body.innerHTML = '<div id=okta-sign-in><form><input id=identifier name=identifier autocomplete=username></form></div>'",
    ]) {
      await reset()
      await execute(prepareOktaLoginScript("changed"))
      await contents.executeJavaScript(`${mutation}; true`)
      await assert.rejects(execute(completeOktaLoginScript("changed", login, "username", Date.now() + 5000)))
      assert.equal(await contents.executeJavaScript("document.querySelector('input').value"), "")
    }
    await reset()
    await execute(prepareOktaLoginScript("expired"))
    await assert.rejects(execute(completeOktaLoginScript("expired", login, "username", Date.now() - 1)))
    await execute(clearOktaLoginScript("expired"))
    await assert.rejects(execute(completeOktaLoginScript("expired", login, "username", Date.now() + 5000)))
    await execute(prepareOktaLoginScript("once"))
    await execute(completeOktaLoginScript("once", login, "username", Date.now() + 5000))
    await assert.rejects(execute(completeOktaLoginScript("once", login, "username", Date.now() + 5000)))
    assert.throws(
      () =>
        completeOktaLoginScript("origin", { ...login, origin: "https://other.test" }, "username", Date.now() + 5000),
      /origin mismatch/,
    )
    console.log(
      "PASS WPP Okta native field fixture: separate screens, default-GET exception, account binding, events, no submission, stale fields, expiry, origin and form rejection",
    )
  } finally {
    win.destroy()
  }
}

run()
  .then(() => app.exit(0))
  .catch((error) => {
    console.error(error)
    app.exit(1)
  })
