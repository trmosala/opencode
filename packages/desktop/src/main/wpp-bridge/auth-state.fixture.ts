import assert from "node:assert/strict"
import { createWorkerWindow, WPP_WORKSPACE_ORIGIN, wppAuth, wppSession } from "./session"

export async function wppAuthSmoke() {
  assert(process.env.CM_BROWSER_SMOKE_PROFILE, "Only run through the isolated smoke runner")
  const current = wppSession()
  let status = 200
  const requests: boolean[] = []
  current.protocol.handle("https", (request) => {
    if (request.url === `${WPP_WORKSPACE_ORIGIN}/api/users/me`) {
      const authenticated = request.headers.get("authorization") === "Bearer smoke-token"
      requests.push(authenticated)
      return Response.json(authenticated ? { data: { id: "smoke-user" } } : {}, {
        status: authenticated ? status : 401,
      })
    }
    return new Response(
      `<!doctype html><script>localStorage.setItem("oidc.user:https://authenticate.os.wpp.com/auth/realms/os-prod:smoke", JSON.stringify({access_token:"smoke-token", expires_at:Date.now()/1000+3600}))</script>`,
      { headers: { "content-type": "text/html" } },
    )
  })
  const win = createWorkerWindow()
  try {
    await win.loadURL(`${WPP_WORKSPACE_ORIGIN}/`)
    assert.equal((await wppAuth.check()).status, "signed-in", "A token-authenticated WPP page must be detected")
    status = 403
    assert.equal((await wppAuth.check()).status, "unknown", "Project denial does not mean signed out")
    const count = requests.length
    for (const value of ["invalid", { access_token: "smoke-token", expires_at: 0 }, {}]) {
      await win.webContents.executeJavaScript(
        `localStorage.clear(); localStorage.setItem("oidc.user:https://authenticate.os.wpp.com/auth/realms/os-prod:smoke", ${JSON.stringify(typeof value === "string" ? value : JSON.stringify(value))})`,
      )
      assert.equal((await wppAuth.check()).status, "unknown")
    }
    assert.equal(requests.length, count, "Missing or expired credentials must not trigger an unauthenticated probe")
    await win.loadURL("https://unrelated.test/")
    assert.equal((await wppAuth.check()).status, "unknown", "Never read credentials from an unrelated page")
    assert.equal(requests.length, count)
    await win.loadURL(`${WPP_WORKSPACE_ORIGIN}/`)
    status = 401
    assert.equal((await wppAuth.check()).status, "signed-out")
    assert(requests.every(Boolean), "Identity probes must carry the page's token")
  } finally {
    win.destroy()
    current.protocol.unhandle("https")
  }
}
