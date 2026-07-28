import electron from "electron"
import type { WebContents } from "electron"
import type { Target } from "./driver"

type RegistryContents = Pick<WebContents, "id" | "isDestroyed" | "getType" | "hostWebContents" | "once">
const sessions = new Map<string, RegistryContents>()

export function registerBrowserWebview(owner: WebContents, sessionID: string, webContentsID: number) {
  const guest = electron.webContents.fromId(webContentsID)
  return registerKnownBrowserWebview(owner.id, sessionID, guest)
}

export function registerKnownBrowserWebview(ownerID: number, sessionID: string, guest: RegistryContents | undefined) {
  if (!sessionID || sessionID.length > 256) throw new Error("Invalid browser session ID")
  if (!guest || guest.isDestroyed() || guest.getType() !== "webview") throw new Error("Browser webview not found")
  if (guest.hostWebContents?.id !== ownerID) throw new Error("Browser webview does not belong to this renderer")

  sessions.set(sessionID, guest)
  guest.once("destroyed", () => {
    if (sessions.get(sessionID) === guest) sessions.delete(sessionID)
  })
}

export function unregisterBrowserWebview(owner: WebContents, sessionID: string, webContentsID: number) {
  const guest = sessions.get(sessionID)
  if (guest?.id === webContentsID && guest.hostWebContents?.id === owner.id) sessions.delete(sessionID)
}

export function resolveBrowserTarget(sessionID: string): Target | undefined {
  const contents = sessions.get(sessionID)
  if (!contents || contents.isDestroyed()) {
    sessions.delete(sessionID)
    return
  }
  return { contents: contents as WebContents }
}
