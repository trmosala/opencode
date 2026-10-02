import assert from "node:assert/strict"
import { EventEmitter, once } from "node:events"
import { createServer } from "node:http"
import { BrowserWindow, dialog } from "electron"
import type { BrowserIpcResult, BrowserState, Request, Response } from "@cookiemonster/cm-browser/protocol"
import { attachBrowserBridge } from "./bridge"
import { createBrowserSessionResolver } from "./session-resolver"
import { browserCommand, registerBrowserOwner } from "./tabs"
import { browserOperationBusy, browserTabReserved, setBrowserAgentEnabled } from "./registry"
import { browserDelegation } from "../../../../cm-browser/src/delegation"

const wait = async (check: () => boolean) => {
  for (let i = 0; i < 150; i++) {
    if (check()) return
    await new Promise((resolve) => setTimeout(resolve, 20))
  }
  throw new Error("Delegation fixture condition timed out")
}

export async function delegationSmoke() {
  assert(process.env.CM_BROWSER_SMOKE_PROFILE, "Only run through the isolated smoke runner")
  const parentID = "delegation-parent"
  const childID = "delegation-child"
  const siblingID = "delegation-sibling"
  const heldChildID = "delegation-held-child"
  const exitChildID = "delegation-exit-child"
  const directory = process.cwd()
  const projectID = "delegation-project"
  const password = "fixture-sidecar-secret"
  const requests: { path: string; authorization: string | null }[] = []
  const nativeLoads = new Map<string, { entered: PromiseWithResolvers<void>; release: PromiseWithResolvers<void> }>()
  let nativeLoadID = 0
  const api = createServer((request, response) => {
    requests.push({ path: request.url ?? "", authorization: request.headers.authorization ?? null })
    const url = new URL(request.url ?? "/", "http://127.0.0.1")
    if (url.pathname === "/fixture-page") {
      response
        .writeHead(200, { "Content-Type": "text/html" })
        .end("<!doctype html><title>Delegation fixture</title><p>safe</p>")
      return
    }
    const native = nativeLoads.get(url.pathname)
    if (native) {
      native.entered.resolve()
      void native.release.promise.then(() => {
        response.writeHead(200, { "Content-Type": "text/html" }).end("<!doctype html><title>Settled</title>")
      })
      return
    }
    const id = url.pathname.split("/").at(-1)
    if (request.headers.authorization !== `Basic ${Buffer.from(`opencode:${password}`).toString("base64")}`) {
      response.writeHead(401).end()
      return
    }
    if (!id || ![parentID, childID, siblingID, heldChildID, exitChildID].includes(id)) {
      response.writeHead(404).end()
      return
    }
    response.writeHead(200, { "Content-Type": "application/json" }).end(
      JSON.stringify({
        data: {
          id,
          ...([childID, heldChildID, exitChildID].includes(id)
            ? { parentID }
            : id === siblingID
              ? { parentID: "unrelated-parent" }
              : {}),
          projectID,
          location: { directory, workspaceID: "delegation-workspace" },
        },
      }),
    )
  })
  api.listen(0, "127.0.0.1")
  await once(api, "listening")
  const address = api.address()
  assert(address && typeof address === "object")
  const win = new BrowserWindow({ width: 720, height: 520, show: false })
  const owner = registerBrowserOwner(win)
  win.showInactive()
  const consent = dialog.showMessageBox
  dialog.showMessageBox = (async () => ({ response: 1, checkboxChecked: false })) as typeof dialog.showMessageBox
  const replies = new Map<string, (response: Response<BrowserState>) => void>()
  const sidecar = Object.assign(new EventEmitter(), {
    postMessage(message: BrowserIpcResult) {
      replies.get(message.id)?.(message.response)
      replies.delete(message.id)
    },
  })
  const resolver = createBrowserSessionResolver(`http://127.0.0.1:${address.port}`, password)
  const stop = attachBrowserBridge(sidecar, undefined, resolver)
  let sequence = 0
  const dispatch = (sessionID: string, request: Request, id = `delegation-${++sequence}`) => {
    const reply = Promise.withResolvers<Response<BrowserState>>()
    replies.set(id, reply.resolve)
    sidecar.emit("message", { type: "browser_request", id, sessionID, request })
    return reply.promise
  }
  try {
    setBrowserAgentEnabled(true)
    const created = await browserCommand(owner, parentID, { op: "new" })
    assert(created.activeID, "Production tab creation did not return an active tab")
    const tab = owner.groups.get(parentID)?.tabs.find((entry) => entry.id === created.activeID)
    assert(tab, "Native tab missing after production create command")
    await browserCommand(owner, parentID, {
      op: "navigate",
      tabID: tab.id,
      url: `http://127.0.0.1:${address.port}/fixture-page`,
    })
    await wait(() => !tab.contents.isLoadingMainFrame() && tab.contents.getURL().endsWith("/fixture-page"))
    await browserCommand(owner, parentID, { op: "access", tabID: tab.id, enabled: true })
    assert.equal(tab.agentAccess, true, "Tab-wide access did not come from the production consent path")
    const privateTabState = await browserCommand(owner, parentID, { op: "new" })
    assert(privateTabState.activeID)
    const privateTab = owner.groups.get(parentID)?.tabs.find((entry) => entry.id === privateTabState.activeID)
    assert(privateTab && !privateTab.agentAccess, "New production tabs must require their own explicit access grant")

    const siblingGrant = await dispatch(parentID, {
      op: "grant_tabs",
      executionID: "sibling-execution",
      childSessionID: siblingID,
      tabIDs: [tab.id],
    })
    assert.equal(siblingGrant.ok, false, "A sibling session received a parent tab")
    const cleanup: Array<() => Promise<void>> = []
    let acknowledged = false
    const controller = new AbortController()
    await browserDelegation({ send: (sessionID, request) => dispatch(sessionID, request) })(
      {
        executionID: "delegation-execution",
        parentSessionID: parentID,
        childSessionID: childID,
        browserTabIDs: [tab.id],
        abort: controller.signal,
        ask: async (permission) =>
          assert.deepEqual(permission, {
            permission: "browser_delegate_tabs",
            patterns: [tab.id],
            always: [],
            metadata: { childSessionID: childID, tabIDs: [tab.id] },
          }),
      },
      {
        defer(action) {
          cleanup.push(action)
        },
        acknowledge() {
          acknowledged = true
        },
      },
    )
    assert.equal(acknowledged, true)
    const sessionRequests = requests.filter((entry) => entry.path.startsWith("/api/session/"))
    assert(sessionRequests.some((entry) => entry.path.startsWith(`/api/session/${parentID}`)))
    assert(sessionRequests.some((entry) => entry.path.startsWith(`/api/session/${childID}`)))
    assert(
      sessionRequests.every(
        (entry) => entry.authorization === `Basic ${Buffer.from(`opencode:${password}`).toString("base64")}`,
      ),
    )
    assert(
      sessionRequests.some(
        (entry) => new URL(entry.path, "http://127.0.0.1").searchParams.get("workspace") === "delegation-workspace",
      ),
    )
    const visible = await dispatch(childID, { op: "list_tabs" })
    assert(visible.ok && visible.result.tabs?.map((entry) => entry.tabID).join() === tab.id)
    assert((await dispatch(siblingID, { op: "read_state", tabID: tab.id })).ok === false)
    assert((await dispatch(childID, { op: "read_state", tabID: privateTab.id })).ok === false)
    assert(
      (
        await dispatch(childID, {
          op: "grant_tabs",
          executionID: "onward-execution",
          childSessionID: "delegation-grandchild",
          tabIDs: [tab.id],
        })
      ).ok === false,
    )
    const revoked = await dispatch(parentID, { op: "revoke_tabs", executionID: "delegation-execution" })
    assert.deepEqual(revoked.ok && revoked.result.delegation, { executionID: "delegation-execution", active: false })
    controller.abort()
    await cleanup[0]()
    assert((await dispatch(childID, { op: "read_state", tabID: tab.id })).ok === false)

    const heldNativeLoad = () => {
      const pathname = `/hold-native-${++nativeLoadID}`
      const entered = Promise.withResolvers<void>()
      const release = Promise.withResolvers<void>()
      nativeLoads.set(pathname, { entered, release })
      return { pathname, entered: entered.promise, release }
    }
    const runHeldNativeAction = async (mode: "cancel-revoke" | "sidecar-exit", delegatedChild: string) => {
      const executionID = `held-execution-${mode}`
      const grant = await dispatch(parentID, {
        op: "grant_tabs",
        executionID,
        childSessionID: delegatedChild,
        tabIDs: [tab.id],
      })
      assert(grant.ok && grant.result.delegation?.active)
      const native = heldNativeLoad()
      const navigate = {
        op: "navigate",
        tabID: tab.id,
        url: `http://127.0.0.1:${address.port}${native.pathname}`,
      } as const
      const prepared = await dispatch(delegatedChild, { op: "prepare_write", request: navigate })
      assert(prepared.ok && prepared.result.context, "Production tab write did not receive a context")
      const actionID = `held-action-${mode}`
      const pending = dispatch(delegatedChild, { ...navigate, context: prepared.result.context }, actionID)
      await native.entered
      assert.equal(browserOperationBusy.has(tab.id), true)
      assert.equal(browserTabReserved(tab), true)
      if (mode === "cancel-revoke") {
        sidecar.emit("message", { type: "browser_cancel", id: actionID, sessionID: delegatedChild })
        assert.equal((await pending).ok, false, "Cancellation did not return promptly")
        assert.equal(browserTabReserved(tab), true, "Cancellation released a reservation before native settlement")
        const revoked = await dispatch(parentID, { op: "revoke_tabs", executionID })
        assert(revoked.ok && revoked.result.delegation?.active === false)
        assert.equal(browserTabReserved(tab), true, "Revocation released a reservation before native settlement")
      }
      if (mode === "sidecar-exit") {
        sidecar.emit("exit", 0)
        assert.equal(tab.ownerScope?.(), undefined, "Sidecar exit left a stale trusted owner scope")
        assert.equal(browserTabReserved(tab), true, "Sidecar exit released a reservation before native settlement")
      }
      native.release.resolve()
      await wait(() => !browserOperationBusy.has(tab.id) && !browserTabReserved(tab))
      console.log(`PASS production tab reservation held through ${mode} native settlement`)
    }
    await runHeldNativeAction("cancel-revoke", heldChildID)
    await runHeldNativeAction("sidecar-exit", exitChildID)
    console.log(
      "PASS production-created native tab, authenticated V2 scope, child-only delegation, revoke and onward denial",
    )
  } finally {
    stop()
    setBrowserAgentEnabled(false)
    dialog.showMessageBox = consent
    if (!win.isDestroyed()) win.destroy()
    await new Promise<void>((resolve) => api.close(() => resolve()))
  }
}
