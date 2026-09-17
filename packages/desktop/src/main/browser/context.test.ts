import { expect, test } from "bun:test"
import { captureBrowserContext } from "./context"

function fixture(command: "selection" | "pick" | "screenshot" = "screenshot", cancelled = false) {
  const started = Promise.withResolvers<void>()
  const capture = Promise.withResolvers<void>()
  const state = { destroyed: false, loading: false, visible: true, url: "https://example.test/" }
  const contents = {
    mainFrame: { detached: false },
    backgroundThrottling: true,
    isDestroyed: () => state.destroyed,
    isLoadingMainFrame: () => state.loading,
    getURL: () => state.url,
    executeJavaScriptInIsolatedWorld: async () => {
      if (command === "screenshot") return
      started.resolve()
      await capture.promise
      if (cancelled) return
      return command === "selection"
        ? "selected text"
        : { tag: "button", text: "Pick", role: "", label: "", id: "", className: "" }
    },
    capturePage: async () => {
      started.resolve()
      await capture.promise
      return {
        getSize: () => ({ width: 1, height: 1 }),
        isEmpty: () => false,
        toPNG: () => Buffer.from("fixture"),
      }
    },
  }
  const tab = { id: "tab", revision: 1, contents, view: { webContents: contents } }
  const group = { activeID: tab.id, tabs: [tab] }
  const owner = {
    win: { isVisible: () => state.visible, isDestroyed: () => false, isMinimized: () => false },
    groups: new Map([["task", group]]),
    attached: tab as typeof tab | undefined,
    taskEpoch: 1,
    screenshotEpoch: 1,
    shutting: false,
  }
  const pending = captureBrowserContext(
    owner as unknown as Parameters<typeof captureBrowserContext>[0],
    "task",
    "tab",
    command,
  )
  return { started, capture, state, contents, tab, group, owner, pending }
}

test("cancelled pickers resolve only while their capture target remains current", async () => {
  for (const change of ["none", "switch", "resize", "navigation", "replacement", "hide", "owner"] as const) {
    const f = fixture("pick", true)
    await f.started.promise
    if (change === "switch") {
      f.group.activeID = "other"
      f.owner.attached = undefined
    }
    if (change === "resize") f.owner.screenshotEpoch++
    if (change === "navigation") f.tab.revision++
    if (change === "replacement") f.group.tabs = [{ ...f.tab }]
    if (change === "hide") f.state.visible = false
    if (change === "owner") f.owner.shutting = true
    f.capture.resolve()
    if (change === "none") await expect(f.pending).resolves.toBeUndefined()
    else await expect(f.pending).rejects.toThrow("Browser tab not visible")
  }
})

test("panel captures reject preview revision changes after native work starts", async () => {
  for (const command of ["screenshot", "selection", "pick"] as const) {
    const f = fixture(command)
    await f.started.promise
    f.tab.revision++ // Apply/Rotate advance this production tab revision.
    f.capture.resolve()
    await expect(f.pending).rejects.toThrow("Browser tab not visible")
    expect(f.contents.backgroundThrottling).toBe(true)
  }
})

test("panel captures reject replacement, closure, navigation and owner changes", async () => {
  const changes: ((f: ReturnType<typeof fixture>) => void)[] = [
    (f) => {
      f.group.tabs = [{ ...f.tab }]
    },
    (f) => {
      f.group.tabs = []
    },
    (f) => {
      f.state.destroyed = true
    },
    (f) => {
      f.tab.view = { webContents: { ...f.contents } }
    },
    (f) => {
      f.contents.mainFrame = { detached: false }
    },
    (f) => {
      f.contents.mainFrame.detached = true
    },
    (f) => {
      f.state.url += "next"
    },
    (f) => {
      f.state.loading = true
    },
    (f) => {
      f.group.activeID = "other"
    },
    (f) => {
      f.owner.groups.set("task", { ...f.group })
    },
    (f) => {
      f.owner.taskEpoch++
    },
    (f) => {
      f.owner.screenshotEpoch++
    },
    (f) => {
      f.state.visible = false
    },
    (f) => {
      f.owner.shutting = true
    },
  ]
  for (const change of changes) {
    const f = fixture()
    await f.started.promise
    change(f)
    f.capture.resolve()
    await expect(f.pending).rejects.toThrow("Browser tab not visible")
  }
})

test("selected screenshots allow attachment-only changes without epoch changes and preserve capture errors", async () => {
  const f = fixture()
  await f.started.promise
  f.owner.attached = undefined
  f.capture.resolve()
  await expect(f.pending).resolves.toBe(`data:image/png;base64,${Buffer.from("fixture").toString("base64")}`)
  expect(f.contents.backgroundThrottling).toBe(true)

  const failed = fixture()
  await failed.started.promise
  failed.capture.reject(new Error("native capture failed"))
  await expect(failed.pending).rejects.toThrow("native capture failed")
  expect(failed.contents.backgroundThrottling).toBe(true)
})
