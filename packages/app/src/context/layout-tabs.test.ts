import { describe, expect, test } from "bun:test"
import {
  SESSION_OPEN_FILE_TAB,
  closeSessionTab,
  openSessionTab,
  previewSessionTab,
  reconcileBrowserSessionTabs,
  type SessionTabState,
} from "./layout-tabs"

const state = (all: string[], active?: string, preview?: string): SessionTabState => ({
  tabs: { all, active },
  preview,
})

describe("previewSessionTab", () => {
  test("appends the Open File placeholder", () => {
    expect(previewSessionTab(state(["file://a.ts"], "file://a.ts"), SESSION_OPEN_FILE_TAB)).toEqual(
      state(["file://a.ts", SESSION_OPEN_FILE_TAB], SESSION_OPEN_FILE_TAB, SESSION_OPEN_FILE_TAB),
    )
  })

  test("replaces the current preview in place", () => {
    expect(
      previewSessionTab(
        state(["context", SESSION_OPEN_FILE_TAB, "file://b.ts"], SESSION_OPEN_FILE_TAB, SESSION_OPEN_FILE_TAB),
        "file://a.ts",
      ),
    ).toEqual(state(["context", "file://a.ts", "file://b.ts"], "file://a.ts", "file://a.ts"))
  })

  test("activates a durable tab without duplicating it", () => {
    expect(
      previewSessionTab(
        state(["file://a.ts", SESSION_OPEN_FILE_TAB, "file://b.ts"], SESSION_OPEN_FILE_TAB, SESSION_OPEN_FILE_TAB),
        "file://b.ts",
      ),
    ).toEqual(state(["file://a.ts", "file://b.ts"], "file://b.ts"))
  })

  test("replaces a restored Open File placeholder", () => {
    expect(
      previewSessionTab(state(["file://a.ts", SESSION_OPEN_FILE_TAB], SESSION_OPEN_FILE_TAB), "file://b.ts"),
    ).toEqual(state(["file://a.ts", "file://b.ts"], "file://b.ts", "file://b.ts"))
  })
})

describe("openSessionTab", () => {
  test("pins the current preview", () => {
    expect(openSessionTab(state(["file://a.ts"], "file://a.ts", "file://a.ts"), "file://a.ts")).toEqual(
      state(["file://a.ts"], "file://a.ts"),
    )
  })

  test("replaces a preview with a directly opened file", () => {
    expect(openSessionTab(state(["file://a.ts"], "file://a.ts", "file://a.ts"), "file://b.ts")).toEqual(
      state(["file://b.ts"], "file://b.ts"),
    )
  })

  test("keeps the preview when switching to Review", () => {
    expect(openSessionTab(state(["file://a.ts"], "file://a.ts", "file://a.ts"), "review")).toEqual(
      state(["file://a.ts"], "review", "file://a.ts"),
    )
  })

  test("opens the desktop browser as a pinned special tab", () => {
    expect(openSessionTab(state(["file://a.ts"], "file://a.ts", "file://a.ts"), "browser")).toEqual(
      state(["browser", "file://a.ts"], "browser", "file://a.ts"),
    )
  })

  test("replaces a restored Open File placeholder with a direct open", () => {
    expect(openSessionTab(state(["file://a.ts", SESSION_OPEN_FILE_TAB], SESSION_OPEN_FILE_TAB), "file://b.ts")).toEqual(
      state(["file://a.ts", "file://b.ts"], "file://b.ts"),
    )
  })
})

describe("closeSessionTab", () => {
  test("clears preview metadata and selects the left neighbor", () => {
    expect(
      closeSessionTab(
        state(["file://a.ts", "file://b.ts", "file://c.ts"], "file://b.ts", "file://b.ts"),
        "file://b.ts",
      ),
    ).toEqual(state(["file://a.ts", "file://c.ts"], "file://a.ts"))
  })
})

describe("reconcileBrowserSessionTabs", () => {
  test("migrates the Browser wrapper and keeps pages beside files", () => {
    expect(
      reconcileBrowserSessionTabs({ all: ["browser", "file://a.ts"], active: "browser" }, ["a", "b"], "a"),
    ).toEqual({ all: ["file://a.ts", "browser:a", "browser:b"], active: "browser:a" })
  })
  test("keeps Review selected during page updates and selects new popups", () => {
    const current = { all: ["browser:a", "new-tab:one"], active: "review" }
    expect(reconcileBrowserSessionTabs(current, ["a"], "a", "a").active).toBe("review")
    expect(reconcileBrowserSessionTabs(current, ["a", "b"], "b", "a").active).toBe("browser:b")
  })
  test("retains refused closes, follows native selection, and removes closed pages", () => {
    const current = { all: ["browser:a", "file://a.ts", "browser:b"], active: "browser:a" }
    expect(reconcileBrowserSessionTabs(current, ["a", "b"], "a", "a")).toEqual(current)
    expect(reconcileBrowserSessionTabs(current, ["a", "b"], "b", "a").active).toBe("browser:b")
    expect(reconcileBrowserSessionTabs(current, ["b"], "b", "a")).toEqual({
      all: ["file://a.ts", "browser:b"],
      active: "browser:b",
    })
    expect(reconcileBrowserSessionTabs(current, [], undefined, "a").active).toBe("review")
  })
  test("reflects native pinning and moves without moving file slots", () => {
    expect(
      reconcileBrowserSessionTabs({ all: ["browser:a", "file://a.ts", "browser:b"] }, ["b", "a"], "a", "a").all,
    ).toEqual(["browser:b", "file://a.ts", "browser:a"])
  })
})
