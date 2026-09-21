import { test, expect } from "bun:test"
import { EventEmitter } from "node:events"
import type { BrowserDownload } from "@opencode-ai/app/browser-panel"
import { mkdtempSync, writeFileSync, readFileSync, rmSync, renameSync, mkdirSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { BrowserStore } from "./store"
import {
  completedDownload,
  downloadHistoryRows,
  savedDownloads,
  saveDownloadRecord,
  trackDownload,
} from "./download-records"

function transfer(path: string, received = 0, total = 6) {
  const events = new EventEmitter()
  return Object.assign(events, {
    getReceivedBytes: () => received,
    getTotalBytes: () => total,
    getSavePath: () => path,
    isPaused: () => false,
    cancel: () => events.emit("done", {}, "cancelled"),
  })
}

test("native cancellation preserves staged interruption, explicit cancellation does not", () => {
  for (const explicit of [false, true]) {
    const item = transfer("/fixture")
    const download: BrowserDownload = { id: "fixture", filename: "file", state: "saving", canControl: true }
    const states: string[] = []
    trackDownload({ preventDefault() {} }, item, download, {
      save: (row) => states.push(row.state),
      start() {},
      release() {},
      publish() {},
      preserveOnNativeCancel: true,
    })
    if (explicit) download.state = "cancelled"
    item.cancel()
    expect(states).toEqual(["saving", explicit ? "cancelled" : "interrupted"])
  }
})

test("interruption checkpoints before Chromium cancellation; staged completion records the published path", async () => {
  const directory = mkdtempSync(join(tmpdir(), "cm-download-lifecycle-"))
  try {
    const checkpoint = Promise.withResolvers<void>()
    const item = transfer(join(directory, "partial"), 3)
    const download: BrowserDownload = { id: "fixture", filename: "file", state: "saving", canControl: true }
    let released = false
    trackDownload({ preventDefault() {} }, item, download, {
      save() {},
      start() {},
      release: () => {
        released = true
      },
      publish() {},
      checkpoint: () => checkpoint.promise,
    })
    item.emit("updated", {}, "interrupted")
    expect(released).toBe(false)
    checkpoint.resolve()
    await Bun.sleep(0)
    expect(released).toBe(true)
    expect(download.state).toBe("interrupted")
    const source = join(directory, "staging")
    const destination = join(directory, "completed")
    writeFileSync(source, "abcdef")
    writeFileSync(destination, "abcdef")
    const normal = transfer(source, 6)
    const final = Promise.withResolvers<string>()
    const paths: (string | undefined)[] = []
    released = false
    trackDownload(
      { preventDefault() {} },
      normal,
      { id: "normal", filename: "file", state: "saving" },
      {
        save: (_row, path) => {
          paths.push(path)
        },
        start() {},
        release: () => {
          released = true
        },
        publish() {},
        finish: () => final.promise,
      },
    )
    normal.emit("done", {}, "completed")
    expect(released).toBe(false)
    final.resolve(destination)
    await Bun.sleep(0)
    expect(released).toBe(true)
    expect(paths).toEqual([undefined, destination])
  } finally {
    rmSync(directory, { recursive: true, force: true })
  }
})

test("full live cap and failed admission reads/writes reject before saving or attaching transfer listeners", () => {
  const dir = mkdtempSync(join(tmpdir(), "cm-download-admission-"))
  try {
    const store = new BrowserStore(join(dir, "store.json"))
    const rows = Array.from({ length: 200 }, (_, i) => ({ id: String(i), filename: "file", state: "saving" }))
    store.set("downloads", rows)
    const live = new Set(rows.map((row) => row.id))
    const original = readFileSync(store.path, "utf8")
    for (const failure of ["cap", "read", "write"]) {
      const item = transfer(join(dir, failure))
      let prevented = 0
      let starts = 0
      let releases = 0
      const download: BrowserDownload = { id: "new", filename: "file", state: "saving" }
      const boundary = {
        get(key: string, fallback?: unknown) {
          if (failure === "read") throw new Error("fixture read failure")
          return store.get(key, fallback)
        },
        set() {
          throw new Error("fixture write failure")
        },
      }
      expect(
        trackDownload(
          {
            preventDefault: () => {
              prevented++
            },
          },
          item,
          download,
          {
            save: (row, path) =>
              saveDownloadRecord(failure === "cap" ? store : boundary, row, path, failure === "cap" ? live : new Set()),
            start: () => {
              starts++
              writeFileSync(item.getSavePath(), "must not save", { flag: "wx" })
            },
            release: () => {
              releases++
            },
            publish: () => {
              throw new Error("must not publish an unadmitted transfer")
            },
          },
        ),
      ).toBe(false)
      expect(prevented).toBe(1)
      expect(starts).toBe(0)
      expect(releases).toBe(0)
      expect(item.listenerCount("done")).toBe(0)
      expect(item.listenerCount("updated")).toBe(0)
      expect(() => readFileSync(item.getSavePath())).toThrow()
      expect(readFileSync(store.path, "utf8")).toBe(original)
    }
    // Completing one live ID can replace its own admission even at capacity.
    saveDownloadRecord(store, { ...rows[0], state: "cancelled" }, undefined, live)
    live.delete(rows[0].id)
    saveDownloadRecord(store, { id: "new", filename: "file", state: "saving" }, undefined, live)
    expect(savedDownloads(store.get("downloads"))).toHaveLength(200)
    expect(savedDownloads(store.get("downloads")).some((row) => row.id === "new")).toBe(true)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test("completion persistence and notification failures do not escape; durable admission remains interrupted", () => {
  const dir = mkdtempSync(join(tmpdir(), "cm-download-completion-"))
  try {
    const store = new BrowserStore(join(dir, "store.json"))
    const path = join(dir, "file")
    const item = transfer(path, 6, 6)
    const download: BrowserDownload = { id: "one", filename: "file", state: "saving", received: 0, total: 6 }
    const live = new Set<string>()
    let failed = false
    let releases = 0
    let writes = 0
    const boundary = {
      get: (key: string, fallback?: unknown) => store.get(key, fallback),
      set(key: string, value?: unknown) {
        writes++
        if (failed) throw new Error("fixture disk failure")
        store.set(key, value)
      },
    }
    expect(
      trackDownload(
        {
          preventDefault: () => {
            throw new Error("unexpected rejection")
          },
        },
        item,
        download,
        {
          save: (row, file) => saveDownloadRecord(boundary, row, file, live),
          start: () => {
            live.add(download.id)
            writeFileSync(path, "abcdef", { flag: "wx" })
          },
          release: () => {
            releases++
            live.delete(download.id)
          },
          publish: () => {
            if (failed) throw new Error("fixture unavailable store during publish")
          },
        },
      ),
    ).toBe(true)
    const admission = readFileSync(store.path, "utf8")
    failed = true
    expect(() => item.emit("done", {}, "completed")).not.toThrow()
    expect(() => item.emit("done", {}, "completed")).not.toThrow()
    expect(releases).toBe(1)
    expect(writes).toBe(2)
    expect(live.size).toBe(0)
    expect(download.state).toBe("interrupted")
    expect(download.canControl).toBe(false)
    expect(readFileSync(path, "utf8")).toBe("abcdef")
    expect(readFileSync(store.path, "utf8")).toBe(admission)
    expect(downloadHistoryRows(new BrowserStore(store.path).get("downloads"))[0].state).toBe("interrupted")
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test("application cancellation handler retains empty, populated and replaced reservation paths", () => {
  const dir = mkdtempSync(join(tmpdir(), "cm-download-cancel-"))
  try {
    const store = new BrowserStore(join(dir, "store.json"))
    const live = new Set<string>()
    for (const contents of ["", "partial", "replacement"]) {
      const path = join(dir, contents || "empty")
      const item = transfer(path)
      const download: BrowserDownload = { id: path, filename: "file", state: "saving" }
      let releases = 0
      expect(
        trackDownload(
          {
            preventDefault: () => {
              throw new Error("unexpected rejection")
            },
          },
          item,
          download,
          {
            save: (row, file) => saveDownloadRecord(store, row, file, live),
            start: () => {
              live.add(download.id)
              writeFileSync(path, "", { flag: "wx" })
            },
            release: () => {
              releases++
              live.delete(download.id)
            },
            publish: () => {},
          },
        ),
      ).toBe(true)
      if (contents === "replacement") renameSync(path, `${path}.original`)
      if (contents) writeFileSync(path, contents)
      // This seam emits native cancellation but performs no Chromium filesystem cleanup.
      item.cancel()
      item.cancel()
      expect(releases).toBe(1)
      expect(readFileSync(path, "utf8")).toBe(contents)
      expect(download.state).toBe("cancelled")
      expect(downloadHistoryRows(store.get("downloads")).find((row) => row.id === path)?.state).toBe("cancelled")
      if (contents === "replacement") expect(readFileSync(`${path}.original`, "utf8")).toBe("")
    }
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test("download records survive reopen without restoring running authority or disclosing private metadata", () => {
  const dir = mkdtempSync(join(tmpdir(), "cm-download-records-"))
  try {
    const path = join(dir, "store.json")
    const store = new BrowserStore(path)
    const download = { id: "one", filename: "file", state: "saving" as const, received: 3, total: 6, time: 1 }
    saveDownloadRecord(store, download)
    const reopened = new BrowserStore(path)
    expect(downloadHistoryRows(reopened.get("downloads"))).toEqual([
      { ...download, state: "interrupted", canReveal: false, canControl: false, paused: false },
    ])
    saveDownloadRecord(reopened, { ...download, state: "cancelled" })
    expect(savedDownloads(reopened.get("downloads"))).toHaveLength(1)
    expect(downloadHistoryRows(reopened.get("downloads"))[0].state).toBe("cancelled")
    expect(
      downloadHistoryRows([{ ...download, urlChain: ["secret"], headers: { cookie: "secret" }, canControl: true }])[0],
    ).not.toHaveProperty("urlChain")
    expect(JSON.stringify(savedDownloads([{ ...download, headers: { cookie: "secret" } }]))).not.toContain("secret")
    const before = readFileSync(path, "utf8")
    for (const invalid of [
      null,
      {},
      [null],
      [{ ...download, received: -1 }],
      [{ ...download, total: NaN }],
      [{ ...download, path: "relative" }],
      [download, download],
      [{ ...download, file: {} }],
    ]) {
      expect(() => savedDownloads(invalid)).toThrow("Invalid download history")
    }
    expect(readFileSync(path, "utf8")).toBe(before)
    store.set("downloads", {})
    const corrupt = readFileSync(path, "utf8")
    expect(() => saveDownloadRecord(store, download)).toThrow()
    expect(readFileSync(path, "utf8")).toBe(corrupt)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test("live admission survives history rollover and reopening; crashed admissions do not pin history", () => {
  const dir = mkdtempSync(join(tmpdir(), "cm-download-rollover-"))
  try {
    const path = join(dir, "store.json")
    const store = new BrowserStore(path)
    const row = { id: "long", filename: "file", state: "saving" as const }
    const live = new Set([row.id])
    saveDownloadRecord(store, row)
    for (let index = 0; index < 205; index++) {
      saveDownloadRecord(store, { ...row, id: String(index) }, undefined, live)
    }
    const reopened = new BrowserStore(path)
    expect(savedDownloads(reopened.get("downloads"))).toHaveLength(200)
    expect(downloadHistoryRows(reopened.get("downloads")).find((entry) => entry.id === row.id)?.state).toBe(
      "interrupted",
    )
    // Reopening storage does not invent process ownership.
    for (let index = 0; index < 200; index++) {
      saveDownloadRecord(reopened, { ...row, id: `new-${index}` }, undefined, new Set())
    }
    expect(savedDownloads(reopened.get("downloads")).some((entry) => entry.id === row.id)).toBe(false)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test("only actual complete regular files are revealable; missing, truncated and replaced files fail closed", () => {
  const dir = mkdtempSync(join(tmpdir(), "cm-download-files-"))
  try {
    const store = new BrowserStore(join(dir, "store.json"))
    const path = join(dir, "file")
    const row = { id: "one", filename: "file", state: "completed" as const, received: 6, total: 6 }
    writeFileSync(path, "abcdef")
    expect(completedDownload(path, 6, 0)?.size).toBe(6)
    expect(completedDownload(path, 6, 7)).toBeUndefined()
    expect(completedDownload(dir, 6, 6)).toBeUndefined()
    saveDownloadRecord(store, row, path)
    expect(downloadHistoryRows(store.get("downloads"))[0].canReveal).toBe(true)
    expect(downloadHistoryRows(store.get("downloads"))[0]).not.toHaveProperty("path")
    expect(downloadHistoryRows(store.get("downloads"))[0]).not.toHaveProperty("file")
    renameSync(path, join(dir, "original"))
    writeFileSync(path, "ghijkl")
    expect(downloadHistoryRows(store.get("downloads"))[0].canReveal).toBe(false)
    writeFileSync(path, "abc")
    saveDownloadRecord(store, row, path)
    expect(downloadHistoryRows(store.get("downloads"))[0].state).toBe("interrupted")
    rmSync(path)
    expect(completedDownload(path, 6, 6)).toBeUndefined()
    mkdirSync(path)
    expect(completedDownload(path, 0, 0)).toBeUndefined()
    expect(readFileSync(join(dir, "original"), "utf8")).toBe("abcdef")
    expect(
      downloadHistoryRows([{ id: "legacy", filename: "old", state: "completed", path: join(dir, "original") }])[0]
        .canReveal,
    ).toBe(true)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})
