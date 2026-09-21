import { test, expect } from "bun:test"
import { mkdtemp, writeFile, readFile, rm, stat, symlink, rename, realpath } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { BrowserStore } from "./store"
import { downloadHistoryRows, savedDownloads, saveDownloadRecord } from "./download-records"
import {
  copyDownloadPrefix,
  downloadCheckpoint,
  recoveryData,
  restoreDownload,
  validRangeResponse,
} from "./download-recovery-data"

async function fixture() {
  // macOS exposes its temporary directory through the /var symlink.
  const directory = await realpath(await mkdtemp(join(tmpdir(), "cm-download-recovery-")))
  const destination = join(directory, "file.txt")
  await writeFile(destination, "abc")
  const file = await stat(directory)
  const snapshot = await downloadCheckpoint(join(directory, "parts"), destination, 3)
  const recovery = {
    version: 1 as const,
    url: "https://example.com/file?private=token",
    origin: "https://example.com",
    destination,
    directoryDev: file.dev,
    directoryIno: file.ino,
    ...snapshot,
    offset: 3,
    total: 6,
    eTag: '"v1"',
    lastModified: "Mon, 01 Jun 2026 10:00:00 GMT",
  }
  return {
    directory,
    destination,
    root: join(directory, "parts"),
    recovery,
    clean: () => rm(directory, { recursive: true, force: true }),
  }
}

function response(
  recovery: Awaited<ReturnType<typeof fixture>>["recovery"],
  body = "def",
  changes: Record<string, string> = {},
  status = 206,
) {
  return new Response(body, {
    status,
    headers: {
      "Content-Range": "bytes 3-5/6",
      "Content-Length": "3",
      ETag: recovery.eTag,
      "Last-Modified": recovery.lastModified,
      ...changes,
    },
  })
}

test("recovery metadata is bounded and private; legacy and terminal records are never replay authority", async () => {
  const f = await fixture()
  try {
    expect(recoveryData(f.recovery)).toEqual(f.recovery)
    for (const change of [
      { checkpoint: "../../file" },
      { checkpoint: "-".repeat(36) + ".part" },
      { eTag: 'W/"v1"' },
      { offset: 0 },
      { offset: 6 },
      { total: Infinity },
      { url: "file:///tmp/secret" },
      { url: "https://user:pass@example.com/file" },
      { url: "http://example.com/file" },
      { origin: "https://example.com/page" },
      { lastModified: "invalid" },
      { sha256: "bad" },
    ])
      expect(recoveryData({ ...f.recovery, ...change })).toBeUndefined()
    const store = new BrowserStore(join(f.directory, "store"))
    store.set("downloads", [{ id: "test", filename: "file", state: "saving", recovery: f.recovery }])
    expect(savedDownloads(store.get("downloads"))[0].state).toBe("interrupted")
    const row = downloadHistoryRows(store.get("downloads"))[0]
    expect(row.canResume).toBe(true)
    expect(JSON.stringify(row)).not.toContain("token")
    expect(JSON.stringify(row)).not.toContain(f.directory)
    expect(JSON.stringify(row)).not.toContain(f.recovery.sha256)
    saveDownloadRecord(store, { id: "test", filename: "file", state: "saving" })
    expect(savedDownloads(store.get("downloads"))[0].recovery).toEqual(f.recovery)
    saveDownloadRecord(store, { id: "test", filename: "file", state: "cancelled" })
    expect(savedDownloads(store.get("downloads"))[0].recovery).toBeUndefined()
    expect(downloadHistoryRows([{ id: "old", filename: "file", state: "interrupted" }])[0].canResume).toBeUndefined()
  } finally {
    await f.clean()
  }
})

test("validated range appends exact bytes and publishes a new sibling without overwriting files or symlinks", async () => {
  const f = await fixture()
  try {
    await writeFile(join(f.directory, "file (1).txt"), "keep")
    await symlink(f.destination, join(f.directory, "file (2).txt"))
    const result = await restoreDownload(
      f.root,
      f.recovery,
      async (url, options) => {
        expect(url).toBe(f.recovery.url)
        expect(options.redirect).toBe("error")
        expect(options.credentials).toBe("include")
        expect(options.headers).toEqual({ Range: "bytes=3-", "If-Range": '"v1"', "Accept-Encoding": "identity" })
        return response(f.recovery)
      },
      new AbortController().signal,
      () => {},
      () => {},
    )
    expect(result).toBe(join(f.directory, "file (3).txt"))
    expect(await readFile(result, "utf8")).toBe("abcdef")
    expect(await readFile(f.destination, "utf8")).toBe("abc")
    expect(await readFile(join(f.directory, "file (1).txt"), "utf8")).toBe("keep")
    expect(await readFile(join(f.root, f.recovery.checkpoint), "utf8")).toBe("abc")
  } finally {
    await f.clean()
  }
})

test("changed validators, ranges, encodings, lengths and authentication never produce a completed file", async () => {
  const f = await fixture()
  try {
    for (const changes of [
      { ETag: '"changed"' },
      { "Last-Modified": "Tue, 02 Jun 2026 10:00:00 GMT" },
      { "Content-Range": "bytes 0-5/6" },
      { "Content-Range": "bytes 3-5/7" },
      { "Content-Length": "6" },
      { "Content-Encoding": "gzip" },
    ]) {
      const invalid = response(f.recovery, "def", changes)
      expect(validRangeResponse(invalid.status, invalid.headers, f.recovery)).toBe(false)
      await expect(
        restoreDownload(
          f.root,
          f.recovery,
          async () => invalid,
          new AbortController().signal,
          () => {},
          () => {},
        ),
      ).rejects.toThrow()
    }
    for (const code of [200, 302, 401, 403, 416, 500]) {
      await expect(
        restoreDownload(
          f.root,
          f.recovery,
          async () => response(f.recovery, "def", {}, code),
          new AbortController().signal,
          () => {},
          () => {},
        ),
      ).rejects.toThrow()
    }
    for (const body of ["d", "defg"]) {
      await expect(
        restoreDownload(
          f.root,
          f.recovery,
          async () => response(f.recovery, body),
          new AbortController().signal,
          () => {},
          () => {},
        ),
      ).rejects.toThrow()
    }
    expect(await readFile(f.destination, "utf8")).toBe("abc")
    await expect(stat(join(f.directory, "file (1).txt"))).rejects.toThrow()
  } finally {
    await f.clean()
  }
})

test("missing, edited, truncated and symlinked checkpoints fail before network access", async () => {
  for (const change of ["missing", "edited", "truncated", "symlink", "ancestor"]) {
    const f = await fixture()
    try {
      const path = join(f.root, f.recovery.checkpoint)
      if (change === "missing" || change === "symlink") await rm(path)
      if (change === "edited") await writeFile(path, "xyz")
      if (change === "truncated") await writeFile(path, "a")
      if (change === "symlink") await symlink(f.destination, path)
      if (change === "ancestor") {
        await rename(f.root, `${f.root}-moved`)
        await symlink(`${f.root}-moved`, f.root)
      }
      let requests = 0
      await expect(
        restoreDownload(
          f.root,
          f.recovery,
          async () => {
            requests++
            return response(f.recovery)
          },
          new AbortController().signal,
          () => {},
          () => {},
        ),
      ).rejects.toThrow()
      expect(requests).toBe(0)
      expect(await readFile(f.destination, "utf8")).toBe("abc")
    } finally {
      await f.clean()
    }
  }
})

test("copy refuses existing destinations; cancellation and permission changes prevent publication", async () => {
  const f = await fixture()
  try {
    const exists = join(f.directory, "exists")
    await writeFile(exists, "keep")
    await expect(copyDownloadPrefix(f.destination, exists, 3)).rejects.toThrow()
    expect(await readFile(exists, "utf8")).toBe("keep")
    const controller = new AbortController()
    await expect(
      restoreDownload(
        f.root,
        f.recovery,
        async () => response(f.recovery),
        controller.signal,
        () => {},
        () => controller.abort(),
      ),
    ).rejects.toThrow()
    let authorized = true
    await expect(
      restoreDownload(
        f.root,
        f.recovery,
        async () => response(f.recovery),
        new AbortController().signal,
        () => {
          if (!authorized) throw new Error("revoked")
        },
        () => {
          authorized = false
        },
      ),
    ).rejects.toThrow()
    await expect(stat(join(f.directory, "file (1).txt"))).rejects.toThrow()
  } finally {
    await f.clean()
  }
})
