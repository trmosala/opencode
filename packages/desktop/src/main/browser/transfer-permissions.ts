import { dialog } from "electron"
import type { BrowserWindow, WebContents } from "electron"
import type { BrowserTransferRule } from "@opencode-ai/app/browser-panel"
import {
  browserAccessAllowed,
  browserAgentEnabled,
  browserRegistration,
  browserOperationBusy,
  type BrowserRegistration,
} from "./registry"
import { bindFrameUpload } from "./frames"
import { hostPolicyRevision } from "./allowlist"
import { browserInputFailure } from "./driver"
import { getStore } from "../store"
import { nativeT } from "../native-translations"
import { transferRule, validateTransferRule } from "./transfer-policy"
import { createFrameSessions } from "./frame-sessions"

let revision = 0
export function transferRules(): BrowserTransferRule[] {
  const value: unknown = getStore("cm-browser").get("transferRules", [
    { origin: "*", uploads: "ask", downloads: "ask" },
  ])
  try {
    if (!Array.isArray(value) || value.length > 200) throw new Error("Invalid transfer rules")
    return value.map(validateTransferRule)
  } catch {
    return [{ origin: "*", uploads: "block", downloads: "block" }]
  }
}
export function saveTransferRule(value: BrowserTransferRule, remove = false) {
  if (typeof remove !== "boolean") throw new Error("Invalid transfer permission")
  const rule = validateTransferRule(value)
  const rows = transferRules().filter((row) => row.origin !== rule.origin)
  if (!remove && rows.length >= 200) throw new Error("Transfer rule limit reached")
  if (remove && rule.origin === "*") throw new Error("Cannot remove default transfer rule")
  getStore("cm-browser").set("transferRules", remove ? rows : [...rows, rule])
  revision++
}

// Download attribution is deliberately conservative: exposure survives revocation and navigation.
export function allowDownload(win: BrowserWindow, tab: BrowserRegistration, filename: string, url: string) {
  if (!tab.transferGuarded) return true
  const rule = transferRule(transferRules(), tab.contents.getURL())
  if (rule.downloads === "block") return false
  if (rule.downloads === "allow") return true
  return (
    dialog.showMessageBoxSync(win, {
      type: "question",
      message: nativeT("desktop.browser.transfer.download"),
      detail: nativeT("desktop.browser.transfer.downloadDetail", {
        origin: new URL(tab.contents.getURL()).origin,
        filename,
        url,
      }),
      buttons: [nativeT("desktop.browser.cancel"), nativeT("desktop.browser.allow")],
      defaultId: 0,
      cancelId: 0,
    }) === 1
  )
}

export async function guardUploads(win: BrowserWindow, tab: BrowserRegistration, contents: WebContents) {
  if (!contents.debugger.isAttached()) contents.debugger.attach("1.3")
  let pending = false
  const children = new Set<Promise<void>>()
  const sessions = new Set<string>()
  const frames = (tab.frameSessions = createFrameSessions(contents))
  contents.on("did-start-navigation", frames.invalidate)
  contents.once("destroyed", frames.close)
  const autoAttach = {
    autoAttach: true,
    waitForDebuggerOnStart: true,
    flatten: true,
    filter: [{ type: "iframe" }, { exclude: true }],
  }
  contents.debugger.on("message", (_event, method, params, sessionID) => {
    frames.message(method, params, sessionID ?? "")
    if (method === "Target.detachedFromTarget") {
      frames.detached(params.sessionId)
      sessions.delete(params.sessionId)
      return
    }
    if (method === "Target.attachedToTarget") {
      frames.attached(params.sessionId, sessionID ?? "")
      sessions.add(params.sessionId)
      const child = (async () => {
        await contents.debugger.sendCommand("Page.enable", {}, params.sessionId)
        await contents.debugger.sendCommand(
          "Page.setInterceptFileChooserDialog",
          { enabled: true, cancel: true },
          params.sessionId,
        )
        await contents.debugger.sendCommand("Target.setAutoAttach", autoAttach, params.sessionId)
        await contents.debugger.sendCommand("Runtime.enable", {}, params.sessionId)
        await contents.debugger.sendCommand("DOM.enable", {}, params.sessionId)
        await contents.debugger.sendCommand("Runtime.runIfWaitingForDebugger", {}, params.sessionId)
        frames.ready(params.sessionId)
      })()
      children.add(child)
      void child
        .catch(() => {
          if (sessions.has(params.sessionId) && !contents.isDestroyed()) contents.close()
        })
        .finally(() => children.delete(child))
      return
    }
    if (method !== "Page.fileChooserOpened" || pending) return
    pending = true
    void select(params, sessionID ?? "")
      .catch(() => undefined)
      .finally(() => {
        pending = false
      })
  })
  contents.debugger.on("detach", () => {
    frames.close()
    // Losing interception must not silently restore an unguarded chooser.
    tab.agentAccess = false
    tab.accessRevision = (tab.accessRevision ?? 0) + 1
    // Detach also fires during destruction; don't reenter WebContents teardown.
    setImmediate(() => {
      if (tab.transferGuarded && !contents.isDestroyed()) contents.close()
    })
  })
  async function select(params: { backendNodeId?: number; frameId?: string; mode?: string }, sessionID: string) {
    const url = contents.getURL()
    const owner = tab.ownerID
    const task = tab.sessionID
    const deadline = Date.now() + 60_000
    const navigation = tab.revision
    const access = tab.accessRevision
    const policy = revision
    const hosts = hostPolicyRevision()
    const valid = () =>
      !contents.isDestroyed() &&
      !win.isDestroyed() &&
      tab.revision === navigation &&
      tab.accessRevision === access &&
      revision === policy &&
      hostPolicyRevision() === hosts &&
      contents.getURL() === url
    if (
      !Number.isInteger(params.backendNodeId) ||
      !params.backendNodeId ||
      !params.frameId ||
      !["selectSingle", "selectMultiple"].includes(params.mode ?? "") ||
      !valid() ||
      transferRule(transferRules(), url).uploads === "block"
    )
      return
    // Only metadata overflow bypasses child tracking; ordinary invalidation must still reject.
    const root = frames.overflowed() ? undefined : frames.capture()
    const tree = (await (root ? root.tree() : contents.debugger.sendCommand("Page.getFrameTree"))) as {
      frameTree: { frame: { id: string } }
    }
    if (!valid()) return
    if (sessionID || tree.frameTree.frame.id !== params.frameId) {
      if (!root) return
      const check = (receiver?: string) => {
        if (
          !valid() ||
          Date.now() >= deadline ||
          !tab.agentAccess ||
          !browserAgentEnabled() ||
          tab.contents !== contents ||
          tab.ownerID !== owner ||
          owner !== win.webContents.id ||
          browserRegistration(task, tab.id) !== tab ||
          browserInputFailure(contents) ||
          !browserAccessAllowed(tab, url) ||
          !browserAccessAllowed(tab, new URL(url).origin) ||
          transferRule(transferRules(), url).uploads === "block" ||
          (receiver &&
            (!browserAccessAllowed(tab, receiver) ||
              !browserAccessAllowed(tab, new URL(receiver).origin) ||
              transferRule(transferRules(), receiver).uploads === "block"))
        )
          throw new Error("Upload authority changed")
        root.check()
      }
      check()
      if (browserOperationBusy.has(tab.id)) return
      browserOperationBusy.add(tab.id)
      let binding: Awaited<ReturnType<typeof bindFrameUpload>> | undefined
      try {
        binding = await bindFrameUpload(
          tab,
          contents,
          params.frameId,
          sessionID,
          params.backendNodeId,
          params.mode!,
          check,
        )
        check(binding.origin)
        const consent = await dialog.showMessageBox(win, {
          type: "question",
          message: nativeT("desktop.browser.transfer.frameUpload"),
          detail: nativeT("desktop.browser.transfer.frameUploadDetail", {
            topOrigin: binding.topOrigin,
            origin: binding.origin,
          }),
          buttons: [nativeT("desktop.browser.cancel"), nativeT("desktop.browser.allow")],
          defaultId: 0,
          cancelId: 0,
        })
        check(binding.origin)
        if (consent.response !== 1) return
        await binding.validate()
        const answer = await dialog.showOpenDialog(win, {
          title: nativeT("desktop.browser.transfer.upload", { origin: binding.origin }),
          properties: params.mode === "selectMultiple" ? ["openFile", "multiSelections"] : ["openFile"],
        })
        check(binding.origin)
        if (
          answer.canceled ||
          !answer.filePaths.length ||
          answer.filePaths.length > 100 ||
          (params.mode === "selectSingle" && answer.filePaths.length !== 1)
        )
          return
        await binding.deliver(answer.filePaths)
      } finally {
        await binding?.dispose()
        browserOperationBusy.delete(tab.id)
      }
      return
    }
    const node = await contents.debugger.sendCommand("DOM.describeNode", { backendNodeId: params.backendNodeId })
    // Directory selection remains unsupported.
    if (!valid() || node.node.nodeName !== "INPUT" || node.node.attributes?.includes("webkitdirectory")) return
    const answer = await dialog.showOpenDialog(win, {
      title: nativeT("desktop.browser.transfer.upload", { origin: new URL(url).origin }),
      properties: params.mode === "selectMultiple" ? ["openFile", "multiSelections"] : ["openFile"],
    })
    if (!valid() || answer.canceled || !answer.filePaths.length || answer.filePaths.length > 100) return
    await contents.debugger.sendCommand("DOM.setFileInputFiles", {
      backendNodeId: params.backendNodeId,
      files: answer.filePaths,
    })
  }
  await contents.debugger.sendCommand("Page.enable")
  await contents.debugger.sendCommand("Page.setInterceptFileChooserDialog", { enabled: true, cancel: true })
  await contents.debugger.sendCommand("Target.setAutoAttach", autoAttach)
  await contents.debugger.sendCommand("Runtime.enable")
  await contents.debugger.sendCommand("DOM.enable")
  await Promise.all(children)
  frames.ready("")
}
