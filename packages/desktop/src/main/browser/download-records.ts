import { lstatSync } from "node:fs"
import { basename, isAbsolute } from "node:path"
import type { DownloadItem } from "electron"
import type { BrowserDownload } from "@opencode-ai/app/browser-panel"
import type { BrowserStore } from "./store"

type FileIdentity = { dev: number; ino: number; size: number; mtimeMs: number; birthtimeMs: number }
type SavedDownload = BrowserDownload & { path?: string; file?: FileIdentity }

export function downloadFile(path: string): FileIdentity | undefined {
  try {
    const file = lstatSync(path)
    if (!file.isFile() || file.isSymbolicLink()) return undefined
    return { dev: file.dev, ino: file.ino, size: file.size, mtimeMs: file.mtimeMs, birthtimeMs: file.birthtimeMs }
  } catch {
    return undefined
  }
}

export function completedDownload(path: string, received: number, total: number) {
  const file = downloadFile(path)
  return file && file.size === received && (total === 0 || total === received) ? file : undefined
}

export function savedDownloads(value: unknown): SavedDownload[] {
  if (!Array.isArray(value) || value.length > 200) throw new Error("Invalid download history")
  const ids = new Set<string>()
  return value.map((entry) => {
    if (
      !entry ||
      typeof entry !== "object" ||
      Array.isArray(entry) ||
      typeof entry.id !== "string" ||
      !entry.id ||
      ids.has(entry.id) ||
      typeof entry.filename !== "string" ||
      !["saving", "completed", "cancelled", "interrupted"].includes(entry.state) ||
      [entry.time, entry.received, entry.total].some((n) => n !== undefined && (!Number.isSafeInteger(n) || n < 0)) ||
      (entry.path !== undefined && (typeof entry.path !== "string" || !isAbsolute(entry.path))) ||
      (entry.file !== undefined &&
        (!entry.file ||
          typeof entry.file !== "object" ||
          Array.isArray(entry.file) ||
          !["dev", "ino", "size", "mtimeMs", "birthtimeMs"].every(
            (key) => typeof entry.file[key] === "number" && Number.isFinite(entry.file[key]),
          )))
    )
      throw new Error("Invalid download history")
    ids.add(entry.id)
    return {
      id: entry.id,
      filename: entry.filename,
      // A persisted running row is evidence of interruption, never authority to replay.
      state: entry.state === "saving" ? "interrupted" : entry.state,
      time: entry.time,
      received: entry.received,
      total: entry.total,
      path: entry.path,
      file:
        entry.file === undefined
          ? undefined
          : {
              dev: entry.file.dev,
              ino: entry.file.ino,
              size: entry.file.size,
              mtimeMs: entry.file.mtimeMs,
              birthtimeMs: entry.file.birthtimeMs,
            },
    }
  })
}

export function downloadHistoryRows(value: unknown): BrowserDownload[] {
  return savedDownloads(value).map(({ path, file, ...entry }) => {
    const current = entry.state === "completed" && path ? downloadFile(path) : undefined
    return {
      ...entry,
      canReveal:
        !!current &&
        (entry.received === undefined || current.size === entry.received) &&
        (!file ||
          (current.dev === file.dev &&
            current.ino === file.ino &&
            current.size === file.size &&
            current.mtimeMs === file.mtimeMs &&
            current.birthtimeMs === file.birthtimeMs)),
      canControl: false,
      paused: false,
    }
  })
}

export function saveDownloadRecord(
  store: Pick<BrowserStore, "get" | "set">,
  download: BrowserDownload,
  path?: string,
  live: ReadonlySet<string> = new Set(),
) {
  if (live.size >= 200 && !live.has(download.id)) throw new Error("Download admission limit reached")
  const rows = savedDownloads(store.get("downloads", []))
  const file =
    path && download.state === "completed"
      ? completedDownload(path, download.received ?? 0, download.total ?? 0)
      : undefined
  const entry = savedDownloads([
    {
      ...download,
      time: download.time ?? Date.now(),
      state: download.state === "completed" && !file ? "interrupted" : download.state,
      path: file ? path : undefined,
      file,
    },
  ])[0]
  const retained = rows.filter((row) => row.id !== entry.id)
  // Only the current process's transfer map pins records; persisted states cannot establish liveness.
  const active = retained.filter((row) => live.has(row.id))
  const history = retained.filter((row) => !live.has(row.id))
  store.set("downloads", [entry, ...active, ...history.slice(0, 199 - active.length)])
}

// This is the will-download admission/event boundary; native transfer and consent stay with the caller.
export function trackDownload(
  event: { preventDefault(): void },
  item: Pick<
    DownloadItem,
    "on" | "once" | "getReceivedBytes" | "getTotalBytes" | "isPaused" | "getSavePath" | "cancel"
  >,
  download: BrowserDownload,
  hooks: {
    save(download: BrowserDownload, path?: string): void
    start(): void
    release(): void
    publish(): void
  },
) {
  try {
    hooks.save(download)
  } catch {
    event.preventDefault()
    return false
  }
  const notify = () => {
    try {
      hooks.publish()
    } catch {
      // A store read or renderer teardown must not escape a native event callback.
      console.warn("Browser download status unavailable")
    }
  }
  item.on("updated", (_event, state) => {
    download.received = item.getReceivedBytes()
    download.total = item.getTotalBytes()
    download.paused = item.isPaused()
    notify()
    if (state !== "interrupted") return
    download.state = "interrupted"
    item.cancel()
  })
  item.once("done", (_event, state) => {
    download.canControl = false
    download.paused = false
    // Never unlink a reservation here: stat-then-unlink can delete a user's replacement.
    // Chromium may independently remove its own transfer file on cancel.
    try {
      download.received = item.getReceivedBytes()
      download.total = item.getTotalBytes()
      if (download.state !== "interrupted") download.state = state
      if (state === "completed") {
        download.filename = basename(item.getSavePath())
        if (!completedDownload(item.getSavePath(), download.received, download.total)) download.state = "interrupted"
      }
      hooks.save(download, download.state === "completed" ? item.getSavePath() : undefined)
    } catch {
      // The strict store keeps the admission record if terminal persistence fails. Never replay it.
      download.state = "interrupted"
      console.warn("Browser download result could not be recorded")
    } finally {
      hooks.release()
      notify()
    }
  })
  try {
    hooks.start()
  } catch {
    event.preventDefault()
    download.state = "interrupted"
    download.canControl = false
    hooks.release()
    notify()
    return false
  }
  notify()
  return true
}
