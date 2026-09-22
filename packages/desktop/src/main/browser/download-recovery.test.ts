import { afterAll, expect, test } from "bun:test"
import type { DownloadItem } from "electron"
import type { BrowserDownload } from "@opencode-ai/app/browser-panel"
import { EventEmitter } from "node:events"
import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  realpathSync,
  renameSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

// Keep the cached browser store and changes to the shared Electron preload in a child process.
if (process.env.CM_STAGED_DOWNLOAD_TEST !== "1") {
  test("staged download destination and lifecycle regressions", () => {
    const result = Bun.spawnSync([process.execPath, "test", import.meta.path], {
      cwd: join(import.meta.dir, "../../.."),
      env: { ...process.env, CM_STAGED_DOWNLOAD_TEST: "1" },
      stdout: "pipe",
      stderr: "pipe",
      timeout: 20_000,
    })
    expect(result.exitCode, Buffer.concat([result.stdout, result.stderr]).toString()).toBe(0)
  }, 25_000)
} else {
  const { app, BrowserWindow, dialog } = await import("electron")
  const { getStore } = await import("../store")
  const { stagedDownload, pruneDownloadRecovery } = await import("./download-recovery")
  const { trackDownload } = await import("./download-records")
  const { nativeT } = await import("../native-translations")
  // Resolve macOS's /var temporary-directory symlink before exercising destination identity checks.
  const directory = realpathSync(mkdtempSync(join(tmpdir(), "cm-staged-download-")))
  app.getPath = (name) => join(directory, name)
  mkdirSync(app.getPath("downloads"))
  const store = getStore("cm-browser")
  const parts = join(app.getPath("userData"), "browser-download-parts")
  mkdirSync(parts, { recursive: true })
  afterAll(() => rmSync(directory, { recursive: true, force: true }))

  function fixture(ask = false) {
    const target = mkdtempSync(join(directory, "destination-"))
    store.set("preferences", { askDownloadLocation: ask })
    store.set("downloadDirectory", target)
    const win = new BrowserWindow({ show: false })
    const download: BrowserDownload = {
      id: target,
      filename: "report.txt",
      state: "saving",
      canControl: true,
    }
    const item = Object.assign(new EventEmitter(), {
      path: "",
      getURL: () => "https://example.com/report",
      getURLChain: () => ["https://example.com/report"],
      getETag: () => '"v1"',
      getLastModifiedTime: () => "Mon, 01 Jun 2026 10:00:00 GMT",
      getTotalBytes: () => 6,
      getReceivedBytes: () => 0,
      getSavePath: () => item.path,
      setSavePath: (path: string) => {
        item.path = path
      },
      isPaused: () => false,
      cancel: () => item.emit("done", {}, "cancelled"),
    })
    // Only the DownloadItem methods exercised by staging and transfer admission are implemented.
    // oxlint-disable-next-line typescript-eslint/no-unsafe-type-assertion
    const nativeItem = item as unknown as DownloadItem
    const staged = stagedDownload(win, nativeItem, download, "https://example.com")!
    const dialogs: Electron.SaveDialogOptions[] = []
    const selection = { path: join(target, "chosen.txt") as string | undefined }
    Object.assign(dialog, {
      showSaveDialogSync: (owner: Electron.BrowserWindow, options: Electron.SaveDialogOptions) => {
        expect(owner).toBe(win)
        expect(item.path).toBe("")
        dialogs.push(options)
        return selection.path
      },
    })
    return {
      target,
      item,
      nativeItem,
      download,
      staged,
      dialogs,
      selection,
      async clean() {
        staged.release()
        await pruneDownloadRecovery()
        store.clear()
        rmSync(target, { recursive: true, force: true })
      },
    }
  }

  test
    .skipIf(process.platform === "win32" || process.getuid?.() === 0)
    .each(["unwritable", "unsearchable", "stat-denied"])(
    "%s directory falls back before staging and publishes to the chosen location",
    async (failure) => {
      const f = fixture()
      const selected = join(app.getPath("downloads"), `${failure}.txt`)
      f.selection.path = selected
      if (failure === "stat-denied") {
        mkdirSync(join(f.target, "child"))
        store.set("downloadDirectory", join(f.target, "child"))
      }
      chmodSync(f.target, failure === "unwritable" ? 0o500 : failure === "unsearchable" ? 0o600 : 0o000)
      try {
        if (failure === "stat-denied")
          expect(() => statSync(join(f.target, "child"), { throwIfNoEntry: false })).toThrow()
        else expect(statSync(f.target).isDirectory()).toBe(true)
        f.staged.start()
        expect(f.dialogs).toEqual([
          {
            title: nativeT("desktop.browser.saveDownload"),
            defaultPath: join(app.getPath("downloads"), "report.txt"),
          },
        ])
        expect(f.item.path.startsWith(parts + "/")).toBe(true)
        expect(existsSync(selected)).toBe(false)
        writeFileSync(f.item.path, "abcdef")
        expect(await f.staged.finish(f.item.path)).toBe(selected)
        expect(readFileSync(selected, "utf8")).toBe("abcdef")
      } finally {
        chmodSync(f.target, 0o700)
        expect(readdirSync(f.target)).toEqual(failure === "stat-denied" ? ["child"] : [])
        await f.clean()
      }
      expect(readdirSync(parts)).toEqual([])
    },
  )

  test.each(["missing", "file"])("%s destination directory opens the fallback chooser", async (failure) => {
    const f = fixture()
    const invalid = join(f.target, "invalid")
    if (failure === "file") writeFileSync(invalid, "keep")
    store.set("downloadDirectory", invalid)
    try {
      f.staged.start()
      expect(f.dialogs[0]?.defaultPath).toBe(join(app.getPath("downloads"), "report.txt"))
      expect(f.dialogs).toHaveLength(1)
      if (failure === "file") expect(readFileSync(invalid, "utf8")).toBe("keep")
    } finally {
      await f.clean()
    }
  })

  test.each([false, true])(
    "usable destination with ask=%s leaves no reservation and publishes exact bytes",
    async (ask) => {
      const f = fixture(ask)
      try {
        f.staged.start()
        expect(f.dialogs).toHaveLength(ask ? 1 : 0)
        if (ask) expect(f.dialogs[0].defaultPath).toBe(join(f.target, "report.txt"))
        expect(readdirSync(f.target)).toEqual([])
        writeFileSync(f.item.path, "abcdef")
        await pruneDownloadRecovery()
        expect(readFileSync(f.item.path, "utf8")).toBe("abcdef")
        const destination = join(f.target, ask ? "chosen.txt" : "report.txt")
        expect(await f.staged.finish(f.item.path)).toBe(destination)
        expect(readFileSync(destination, "utf8")).toBe("abcdef")
      } finally {
        await f.clean()
      }
      expect(readdirSync(parts)).toEqual([])
    },
  )

  test.each([false, true])("chooser cancellation with ask=%s prevents staging and releases admission", async (ask) => {
    const f = fixture(ask)
    if (!ask) store.set("downloadDirectory", join(f.target, "missing"))
    f.selection.path = undefined
    let prevented = 0
    let released = 0
    try {
      expect(
        trackDownload({ preventDefault: () => prevented++ }, f.nativeItem, f.download, {
          save() {},
          start: () => f.staged.start(),
          release() {
            released++
            f.staged.release()
          },
          publish() {},
          checkpoint: f.staged.checkpoint,
          finish: (path) => f.staged.finish(path),
          preserveOnNativeCancel: true,
        }),
      ).toBe(false)
      expect(f.dialogs).toHaveLength(1)
      expect(prevented).toBe(1)
      expect(released).toBe(1)
      expect(f.download.canControl).toBe(false)
      expect(f.item.path).toBe("")
      expect(readdirSync(f.target)).toEqual([])
      await f.staged.checkpoint(true)
    } finally {
      await f.clean()
    }
    expect(readdirSync(parts)).toEqual([])
  })

  test("publication skips files, directories, symlinks and collisions created after preflight", async () => {
    const f = fixture()
    try {
      writeFileSync(join(f.target, "report.txt"), "keep")
      mkdirSync(join(f.target, "report (1).txt"))
      symlinkSync(join(f.target, "report.txt"), join(f.target, "report (2).txt"))
      f.staged.start()
      expect(f.dialogs).toHaveLength(0)
      expect(readdirSync(f.target)).toHaveLength(3)
      writeFileSync(join(f.target, "report (3).txt"), "late collision")
      writeFileSync(f.item.path, "abcdef")
      expect(await f.staged.finish(f.item.path)).toBe(join(f.target, "report (4).txt"))
      expect(readFileSync(join(f.target, "report.txt"), "utf8")).toBe("keep")
      expect(statSync(join(f.target, "report (1).txt")).isDirectory()).toBe(true)
      expect(lstatSync(join(f.target, "report (2).txt")).isSymbolicLink()).toBe(true)
      expect(readFileSync(join(f.target, "report (3).txt"), "utf8")).toBe("late collision")
      expect(readFileSync(join(f.target, "report (4).txt"), "utf8")).toBe("abcdef")
    } finally {
      await f.clean()
    }
  })

  test.each(["replacement", "symlink"])("a destination %s after preflight still fails publication", async (change) => {
    const f = fixture()
    const moved = `${f.target}-moved`
    try {
      f.staged.start()
      writeFileSync(f.item.path, "abcdef")
      renameSync(f.target, moved)
      if (change === "symlink") symlinkSync(moved, f.target)
      else mkdirSync(f.target)
      await expect(f.staged.finish(f.item.path)).rejects.toThrow("Download destination changed")
      expect(readdirSync(f.target)).toEqual([])
      expect(readdirSync(moved)).toEqual([])
    } finally {
      await f.clean()
      rmSync(moved, { recursive: true, force: true })
    }
  })

  test("explicit cancellation cleans private staging without removing a new public file", async () => {
    const f = fixture()
    try {
      expect(
        trackDownload({ preventDefault() {} }, f.nativeItem, f.download, {
          save() {},
          start: () => f.staged.start(),
          release: () => f.staged.release(),
          publish() {},
          checkpoint: f.staged.checkpoint,
          finish: (path) => f.staged.finish(path),
          preserveOnNativeCancel: true,
        }),
      ).toBe(true)
      writeFileSync(f.item.path, "abc")
      writeFileSync(join(f.target, "report.txt"), "user file")
      f.download.state = "cancelled"
      f.item.cancel()
      await pruneDownloadRecovery()
      expect(f.download.state).toBe("cancelled")
      expect(f.download.canControl).toBe(false)
      expect(existsSync(f.item.path)).toBe(false)
      expect(readFileSync(join(f.target, "report.txt"), "utf8")).toBe("user file")
    } finally {
      await f.clean()
    }
  })
}
