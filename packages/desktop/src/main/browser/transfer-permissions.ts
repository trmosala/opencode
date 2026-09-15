import { dialog } from "electron"
import type { BrowserWindow, WebContents } from "electron"
import type { BrowserTransferRule } from "@opencode-ai/app/browser-panel"
import type { BrowserRegistration } from "./registry"
import { getStore } from "../store"
import { nativeT } from "../native-translations"
import { transferRule, validateTransferRule } from "./transfer-policy"

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
  const autoAttach = {
    autoAttach: true,
    waitForDebuggerOnStart: true,
    flatten: true,
    filter: [{ type: "iframe" }, { exclude: true }],
  }
  contents.debugger.on("message", (_event, method, params, sessionID) => {
    if (method === "Target.detachedFromTarget") {
      sessions.delete(params.sessionId)
      return
    }
    if (method === "Target.attachedToTarget") {
      sessions.add(params.sessionId)
      const child = (async () => {
        await contents.debugger.sendCommand("Page.enable", {}, params.sessionId)
        await contents.debugger.sendCommand(
          "Page.setInterceptFileChooserDialog",
          { enabled: true, cancel: true },
          params.sessionId,
        )
        await contents.debugger.sendCommand("Target.setAutoAttach", autoAttach, params.sessionId)
        await contents.debugger.sendCommand("Runtime.runIfWaitingForDebugger", {}, params.sessionId)
      })()
      children.add(child)
      void child
        .catch(() => {
          if (sessions.has(params.sessionId) && !contents.isDestroyed()) contents.close()
        })
        .finally(() => children.delete(child))
      return
    }
    if (method !== "Page.fileChooserOpened" || sessionID || pending) return
    pending = true
    void select(params)
      .catch(() => undefined)
      .finally(() => {
        pending = false
      })
  })
  contents.debugger.on("detach", () => {
    // Losing interception must not silently restore an unguarded chooser.
    tab.agentAccess = false
    tab.accessRevision = (tab.accessRevision ?? 0) + 1
    // Detach also fires during destruction; don't reenter WebContents teardown.
    setImmediate(() => {
      if (tab.transferGuarded && !contents.isDestroyed()) contents.close()
    })
  })
  async function select(params: { backendNodeId?: number; frameId?: string; mode?: string }) {
    const url = contents.getURL()
    const navigation = tab.revision
    const access = tab.accessRevision
    const policy = revision
    const valid = () =>
      !contents.isDestroyed() &&
      !win.isDestroyed() &&
      tab.revision === navigation &&
      tab.accessRevision === access &&
      revision === policy &&
      contents.getURL() === url
    if (!params.backendNodeId || !valid() || transferRule(transferRules(), url).uploads === "block") return
    const tree = await contents.debugger.sendCommand("Page.getFrameTree")
    if (!valid() || tree.frameTree.frame.id !== params.frameId) return
    const node = await contents.debugger.sendCommand("DOM.describeNode", { backendNodeId: params.backendNodeId })
    // Directory and iframe selection need a separate consent design.
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
  await contents.debugger.sendCommand("Page.setInterceptFileChooserDialog", { enabled: true })
  await contents.debugger.sendCommand("Target.setAutoAttach", autoAttach)
  await Promise.all(children)
}
