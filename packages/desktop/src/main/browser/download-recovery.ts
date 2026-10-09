import { app, dialog, session } from "electron"
import type { BrowserWindow, DownloadItem } from "electron"
import type { BrowserDownload } from "@opencode-ai/app/browser-panel"
import { dirname, basename, join } from "node:path"
import { unlink, readdir } from "node:fs/promises"
import { accessSync, constants, mkdirSync, statSync } from "node:fs"
import { physicalDownloadPath, physicalDownloadPathSync } from "./download-path"
import { randomUUID } from "node:crypto"
import { getStore } from "../store"
import { nativeT } from "../native-translations"
import { savedDownloads, saveDownloadRecord } from "./download-records"
import {
  downloadCheckpoint,
  recoveryData,
  recoveryDestination,
  recoveryURL,
  restoreDownload,
  publishDownload,
} from "./download-recovery-data"
import { browserPreferencesState, downloadDirectory, downloadFilename } from "./preferences"
import { transferRules } from "./transfer-permissions"
import { transferRule } from "./transfer-policy"
import { BROWSER_PARTITION } from "./policy"

const root = () => join(app.getPath("userData"), "browser-download-parts")
const store = () => getStore("cm-browser")
const active = new Map<string, { win: BrowserWindow; sessionID: string; controller: AbortController }>()
let captures = 0
const staging = new Set<string>()
export const recoveringDownloads = () => new Set(active.keys())

export async function pruneDownloadRecovery() {
  if (captures || active.size) return
  const directory = root()
  if (!(await physicalDownloadPath(directory).catch(() => false))) return
  const entries = await readdir(directory, { withFileTypes: true })
  // Recheck after asynchronous enumeration. Never collect an in-flight checkpoint or recovery.
  if (captures || active.size) return
  const retained = new Set(
    savedDownloads(store().get("downloads", [])).flatMap((row) => (row.recovery ? [row.recovery.checkpoint] : [])),
  )
  await Promise.all(
    entries
      .filter(
        (entry) =>
          entry.isFile() &&
          /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}\.(part|work|native)$/.test(entry.name) &&
          !retained.has(entry.name) &&
          !staging.has(join(directory, entry.name)),
      )
      .map((entry) => unlink(join(directory, entry.name)).catch(() => undefined)),
  )
}

export function stagedDownload(win: BrowserWindow, item: DownloadItem, download: BrowserDownload, origin: string) {
  if (
    item.getURLChain().length !== 1 ||
    !recoveryURL(item.getURL()) ||
    !recoveryURL(origin) ||
    !/^"[^"\r\n]{1,512}"$/.test(item.getETag()) ||
    !Number.isFinite(Date.parse(item.getLastModifiedTime())) ||
    !Number.isSafeInteger(item.getTotalBytes()) ||
    item.getTotalBytes() <= 1
  )
    return
  const path = join(root(), `${randomUUID()}.native`)
  let destination: { destination: string; directoryDev: string; directoryIno: string } | undefined
  let checkpoint: ReturnType<typeof checkpointDownload> | undefined
  return {
    start() {
      const defaultPath = join(downloadDirectory(), downloadFilename(download.filename))
      const available = (() => {
        try {
          if (!statSync(dirname(defaultPath)).isDirectory()) return false
          // Preflight without a public reservation; publication still checks identity and creates exclusively.
          accessSync(dirname(defaultPath), constants.W_OK | constants.X_OK)
          return true
        } catch {
          return false
        }
      })()
      const selected =
        browserPreferencesState().askDownloadLocation || !available
          ? dialog.showSaveDialogSync(win, {
              title: nativeT("desktop.browser.saveDownload"),
              defaultPath: available
                ? defaultPath
                : join(app.getPath("downloads"), downloadFilename(download.filename)),
            })
          : defaultPath
      if (!selected) throw new Error("Download cancelled")
      if (!physicalDownloadPathSync(dirname(selected))) throw new Error("Download destination changed")
      const directory = statSync(dirname(selected), { bigint: true })
      if (!directory.isDirectory()) throw new Error("Download destination changed")
      destination = {
        destination: selected,
        directoryDev: directory.dev.toString(),
        directoryIno: directory.ino.toString(),
      }
      mkdirSync(root(), { recursive: true, mode: 0o700 })
      if (!physicalDownloadPathSync(root())) throw new Error("Invalid recovery directory")
      staging.add(path)
      item.setSavePath(path)
      checkpoint = checkpointDownload(item, download, origin, destination)
    },
    checkpoint: (interrupted: boolean) => checkpoint?.(interrupted) ?? Promise.resolve(),
    async finish(source: string) {
      if (!destination || source !== path) throw new Error("Download destination changed")
      return publishDownload(source, destination)
    },
    release() {
      staging.delete(path)
      void pruneDownloadRecovery().catch(() => undefined)
    },
  }
}

// Keep at most the first 64 MiB per transfer. Larger files can still recover from this
// prefix, without recopying an unbounded partial file on every progress event.
function checkpointDownload(
  item: DownloadItem,
  download: BrowserDownload,
  origin: string,
  destination: { destination: string; directoryDev: string; directoryIno: string },
) {
  let pending: Promise<void> | undefined
  let updated = 0
  let captured = 0
  return async (interrupted: boolean) => {
    if (pending) return pending
    const offset = Math.min(item.getReceivedBytes(), 64 * 1024 * 1024)
    if (!download.canControl || offset <= captured || (!interrupted && updated && Date.now() - updated < 30_000)) return
    updated = Date.now()
    captures++
    pending = (async () => {
      const urls = item.getURLChain()
      if (urls.length !== 1 || !recoveryURL(urls[0]) || !recoveryURL(origin)) return
      await recoveryDestination(destination)
      const metadata = recoveryData({
        version: 1,
        url: urls[0],
        origin,
        ...destination,
        checkpoint: "00000000-0000-0000-0000-000000000000.part",
        offset,
        total: item.getTotalBytes(),
        eTag: item.getETag(),
        lastModified: item.getLastModifiedTime(),
        sha256: "0".repeat(64),
      })
      if (!metadata) return
      const snapshot = await downloadCheckpoint(root(), item.getSavePath(), offset)
      try {
        const rows = savedDownloads(store().get("downloads", []))
        const previous = rows.find((row) => row.id === download.id)
        // Completion, cancellation or clearing history while copying must not resurrect a record.
        if (!download.canControl || !previous || previous.state !== "interrupted") return
        store().set(
          "downloads",
          rows.map((row) =>
            row.id === download.id
              ? { ...row, recovery: { ...metadata, ...snapshot }, received: offset, total: metadata.total }
              : row,
          ),
        )
        captured = offset
        if (previous.recovery) await unlink(join(root(), previous.recovery.checkpoint)).catch(() => undefined)
      } finally {
        if (captured !== offset) await unlink(join(root(), snapshot.checkpoint)).catch(() => undefined)
      }
    })()
    try {
      await pending
    } finally {
      pending = undefined
      captures--
      void pruneDownloadRecovery().catch(() => undefined)
    }
  }
}

export function cancelRecoveredDownload(win: BrowserWindow, sessionID: string, id: string) {
  const entry = active.get(id)
  if (!entry || entry.win !== win || entry.sessionID !== sessionID) return false
  entry.controller.abort()
  return true
}

export async function recoverDownload(
  win: BrowserWindow,
  sessionID: string,
  id: string,
  live: () => ReadonlySet<string>,
  publish: (download: BrowserDownload) => void,
) {
  const row = savedDownloads(store().get("downloads", [])).find((entry) => entry.id === id)
  if (!row?.recovery || row.state !== "interrupted" || live().has(id) || live().size >= 200 || active.has(id))
    throw new Error(nativeT("desktop.browser.downloadRecovery.unavailable"))
  const recovery = row.recovery
  let started = false
  const controller = new AbortController()
  active.set(id, { win, sessionID, controller })
  const close = () => controller.abort()
  win.once("closed", close)
  const check = () => {
    controller.signal.throwIfAborted()
    const current = savedDownloads(store().get("downloads", [])).find((entry) => entry.id === id)
    if (
      win.isDestroyed() ||
      current?.recovery?.checkpoint !== recovery.checkpoint ||
      transferRule(transferRules(), recovery.origin).downloads === "block" ||
      transferRule(transferRules(), recovery.url).downloads === "block"
    )
      throw new Error("Download recovery authority changed")
  }
  try {
    check()
    const answer = await dialog.showMessageBox(win, {
      type: "question",
      message: nativeT("desktop.browser.downloadRecovery.title"),
      detail: nativeT("desktop.browser.downloadRecovery.detail", {
        origin: recovery.origin,
        source: new URL(recovery.url).origin,
        filename: row.filename,
        directory: dirname(recovery.destination),
      }),
      buttons: [nativeT("desktop.browser.cancel"), nativeT("desktop.browser.allow")],
      defaultId: 0,
      cancelId: 0,
    })
    check()
    if (answer.response !== 1) return
    const download: BrowserDownload = {
      id,
      filename: row.filename,
      state: "saving",
      time: row.time,
      received: recovery.offset,
      total: recovery.total,
      canControl: true,
      canPause: false,
    }
    saveDownloadRecord(store(), download, undefined, live())
    publish(download)
    started = true
    // Return after admission so the renderer can cancel the transfer. All background
    // failures are recorded as interrupted; no raw URL, cookie or filesystem error is exposed.
    void (async () => {
      try {
        const path = await restoreDownload(
          root(),
          recovery,
          (url, options) => session.fromPartition(BROWSER_PARTITION).fetch(url, options),
          controller.signal,
          check,
          (received) => {
            download.received = received
            publish(download)
          },
        )
        check()
        download.state = "completed"
        download.filename = basename(path)
        download.received = recovery.total
        saveDownloadRecord(store(), download, path, live())
        await unlink(join(root(), recovery.checkpoint)).catch(() => undefined)
      } catch {
        download.state = controller.signal.aborted && !win.isDestroyed() ? "cancelled" : "interrupted"
        // Clearing history is final, including while an HTTP response is in flight.
        if (savedDownloads(store().get("downloads", [])).some((entry) => entry.id === id))
          saveDownloadRecord(store(), download, undefined, live())
      } finally {
        active.delete(id)
        win.removeListener("closed", close)
        download.canControl = false
        void pruneDownloadRecovery().catch(() => undefined)
        publish(download)
      }
    })().catch(() => undefined)
  } catch {
    throw new Error(nativeT("desktop.browser.downloadRecovery.unavailable"))
  } finally {
    // A saving row remains active until its background transfer settles.
    if (!started) {
      active.delete(id)
      win.removeListener("closed", close)
    }
  }
}
