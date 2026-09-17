import { app, dialog, shell } from "electron"
import type { BrowserWindow } from "electron"
import { closeSync, openSync } from "node:fs"
import { downloadHistoryRows, savedDownloads, saveDownloadRecord } from "./download-records"
import { basename, extname, join } from "node:path"
import type { BrowserDownload, BrowserPermission, BrowserPreferences } from "@opencode-ai/app/browser-panel"
import { getStore } from "../store"
import { nativeT } from "../native-translations"
import { loginOrigin } from "./import-data"

let revision = 0
export const browserPreferencesRevision = () => revision
const store = () => getStore("cm-browser")
export function browserPreferencesState(): BrowserPreferences {
  const value = store().get("preferences", {}) as Partial<BrowserPreferences>
  return {
    offerSaveLogins: value.offerSaveLogins !== false,
    agentHistory: value.agentHistory === "allow" ? "allow" : value.agentHistory === "never" ? "never" : "ask",
    webLinks: value.webLinks === "browser" ? "browser" : "external",
    localLinks: value.localLinks === "external" ? "external" : "browser",
    agentEnabled: value.agentEnabled !== false,
    showFullURL: value.showFullURL !== false,
    selectionScreenshots: value.selectionScreenshots === true,
    askDownloadLocation: value.askDownloadLocation !== false,
    restoreTabs: value.restoreTabs !== false,
  }
}
export function saveBrowserPreferences(values: Partial<BrowserPreferences>) {
  const current = browserPreferencesState()
  if (
    !values ||
    typeof values !== "object" ||
    Object.entries(values).some(
      ([key, value]) =>
        !Object.hasOwn(current, key) ||
        (key === "agentHistory"
          ? !["never", "ask", "allow"].includes(String(value))
          : ["webLinks", "localLinks"].includes(key)
            ? value !== "browser" && value !== "external"
            : typeof value !== "boolean"),
    )
  )
    throw new Error("Invalid browser preferences")
  store().set("preferences", { ...current, ...values })
  revision++
}
export function downloadDirectory() {
  return store().get("downloadDirectory", app.getPath("downloads")) as string
}
export async function chooseDownloadDirectory(win: BrowserWindow, reset = false) {
  if (typeof reset !== "boolean") throw new Error("Invalid directory request")
  if (reset) {
    store().delete("downloadDirectory")
    return
  }
  const result = await dialog.showOpenDialog(win, {
    title: nativeT("desktop.browser.downloadDirectory"),
    defaultPath: downloadDirectory(),
    properties: ["openDirectory", "createDirectory"],
  })
  if (!result.canceled && result.filePaths[0]) store().set("downloadDirectory", result.filePaths[0])
}
export function reserveDownload(directory: string, filename: string) {
  const clean =
    basename(filename.replaceAll("\\", "/"))
      .replace(/[<>:"/\\|?*\x00-\x1f]/g, "_")
      .replace(/[. ]+$/, "")
      .slice(0, 180) || "download"
  const safe = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(clean) ? `_${clean}` : clean
  const ext = extname(safe)
  for (let index = 0; index < 1000; index++) {
    const path = join(directory, index ? `${safe.slice(0, safe.length - ext.length)} (${index})${ext}` : safe)
    try {
      closeSync(openSync(path, "wx"))
      return path
    } catch (error) {
      if (!error || typeof error !== "object" || !("code" in error) || error.code !== "EEXIST") throw error
    }
  }
  throw new Error("Download name limit reached")
}
export function downloadHistory() {
  return downloadHistoryRows(store().get("downloads", []))
}
export function recordDownload(download: BrowserDownload, live: ReadonlySet<string>, path?: string) {
  saveDownloadRecord(store(), download, path, live)
}
export function revealDownload(id: string) {
  const rows = savedDownloads(store().get("downloads", []))
  const row = rows.find((entry) => entry.id === id)
  if (!row?.path || !downloadHistoryRows([row])[0].canReveal) throw new Error("Saved download not found")
  shell.showItemInFolder(row.path)
}
export function sitePermissions() {
  return store().get("sites", []) as { origin: string; camera: BrowserPermission; microphone: BrowserPermission }[]
}
export function saveSitePermission(origin: string, camera: BrowserPermission, microphone: BrowserPermission) {
  if (typeof origin !== "string" || ![camera, microphone].every((value) => ["ask", "allow", "block"].includes(value)))
    throw new Error("Invalid site permission")
  const normalized = loginOrigin(origin)
  const rows = sitePermissions().filter((entry) => entry.origin !== normalized)
  if (rows.length >= 200) throw new Error("Site limit reached")
  store().set("sites", [{ origin: normalized, camera, microphone }, ...rows])
  return normalized
}
export function mediaPermission(origin: string, media: "audio" | "video"): BrowserPermission {
  return (
    sitePermissions().find((entry) => entry.origin === origin)?.[media === "video" ? "camera" : "microphone"] ?? "block"
  )
}
export function mediaOrigin(top: string, requested: string, main: boolean) {
  if (!main || !URL.canParse(top) || !URL.canParse(requested)) return
  const url = new URL(requested)
  if (url.origin !== new URL(top).origin || url.username || url.password) return
  if (
    url.protocol !== "https:" &&
    !(url.protocol === "http:" && ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname))
  )
    return
  return url.origin
}
