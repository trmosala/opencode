import { expect, test } from "bun:test"
import type { BrowserIpcRequest } from "@cookiemonster/cm-browser/protocol"
import { registerKnownBrowserWebview } from "./registry"
import { routeBrowserRequest } from "./router"

function request(sessionID: string, request: BrowserIpcRequest["request"]): BrowserIpcRequest {
  return { type: "browser_request", id: "req-1", sessionID, request }
}

function guest() {
  let url = "http://localhost/"
  let loaded = ""
  return {
    id: 50,
    hostWebContents: { id: 1 },
    isDestroyed: () => false,
    getType: () => "webview" as const,
    once: () => undefined as never,
    getURL: () => url,
    loadURL: async (next: string) => {
      loaded = next
      url = next
    },
    debugger: {
      isAttached: () => true,
      attach: () => undefined,
      sendCommand: async (method: string) =>
        method === "Runtime.evaluate" ? { result: { value: { url, title: "", visibleText: "", elements: [] } } } : {},
    },
    loaded: () => loaded,
  }
}

test("returns no_target instead of falling back to another session", async () => {
  expect(await routeBrowserRequest(request("ses_missing", { op: "read_state" }), () => true)).toMatchObject({
    ok: false,
    code: "no_target",
  })
})

test("blocks navigation before load and allows an approved destination", async () => {
  const view = guest()
  registerKnownBrowserWebview(1, "ses_route", view)
  const blocked = await routeBrowserRequest(
    request("ses_route", { op: "navigate", url: "https://evil.test/" }),
    (url) => !url.includes("evil"),
  )
  expect(blocked).toMatchObject({ ok: false, code: "blocked_host" })
  expect(view.loaded()).toBe("")

  const allowed = await routeBrowserRequest(
    request("ses_route", { op: "navigate", url: "https://teams.microsoft.com/" }),
    () => true,
  )
  expect(allowed.ok && allowed.result.url).toBe("https://teams.microsoft.com/")
})
