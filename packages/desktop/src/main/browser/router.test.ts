import { expect, test } from "bun:test"
import type { BrowserIpcRequest, Request } from "@cookiemonster/cm-browser/protocol"
import { registerBrowserTab, type BrowserRegistration } from "./registry"
import { routeBrowserRequest } from "./router"

test("agent routing enforces session, opt-in, allowlist, cross-tab refs and revocation", async () => {
  const calls: string[] = []
  let url = "http://localhost/"
  const tab: BrowserRegistration = {
    id: "route-one",
    sessionID: "route-session",
    ownerID: 1,
    revision: 0,
    agentAccess: false,
    contents: {
      isDestroyed: () => false,
      getURL: () => url,
      loadURL: async (next) => {
        url = next
        tab.revision++
      },
      debugger: {
        isAttached: () => true,
        attach: () => {},
        sendCommand: async (method) => {
          calls.push(method)
          return {
            result: {
              value: {
                url,
                title: "",
                visibleText: "hello",
                elements: [
                  {
                    tag: "button",
                    role: "",
                    label: "Send",
                    text: "Send",
                    fingerprint: "send",
                    rect: { x: 0, y: 0, width: 10, height: 10 },
                  },
                ],
              },
            },
          }
        },
      },
    },
  }
  const remove = registerBrowserTab(tab)
  const second = { ...tab, id: "route-two", agentAccess: true }
  const removeSecond = registerBrowserTab(second)
  const route = (request: Request, sessionID = tab.sessionID) =>
    routeBrowserRequest(
      { type: "browser_request", id: "request", sessionID, request } satisfies BrowserIpcRequest,
      (url) => url.startsWith("http://localhost/"),
    )
  try {
    expect(await route({ op: "read_state", tabID: tab.id }, "other")).toMatchObject({ code: "no_target" })
    expect(await route({ op: "read_state", tabID: tab.id })).toMatchObject({ code: "access_denied" })
    expect(calls).toEqual([])
    const list = await route({ op: "list_tabs" })
    expect(list.ok && list.result.tabs?.map((tab) => tab.tabID)).toEqual([second.id])
    tab.agentAccess = true
    expect(await route({ op: "navigate", tabID: tab.id, url: "https://blocked.test/" })).toMatchObject({
      code: "blocked_host",
    })
    expect(url).toBe("http://localhost/")
    expect((await route({ op: "navigate", tabID: tab.id, url: "http://localhost/next" })).ok).toBe(true)
    const snapshot = await route({ op: "read_state", tabID: tab.id })
    if (!snapshot.ok) throw new Error(snapshot.error)
    const ref = snapshot.result.elements[0].ref
    await route({ op: "read_state", tabID: second.id })
    expect(await route({ op: "click", tabID: second.id, ref })).toMatchObject({ code: "stale_ref" })
    const original = tab.contents.debugger.sendCommand
    tab.contents.debugger.sendCommand = async (method, params) => {
      const result = await original(method, params)
      if (method === "Input.dispatchMouseEvent") tab.agentAccess = false
      return result
    }
    expect(await route({ op: "fill", tabID: tab.id, ref, text: "private" })).toMatchObject({ ok: false })
    expect(calls.includes("Input.dispatchKeyEvent")).toBe(false)
  } finally {
    remove()
    removeSecond()
  }
})
