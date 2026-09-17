import { randomUUID } from "node:crypto"
import { writeFile } from "node:fs/promises"
import { dialog } from "electron"
import type { BrowserWindow } from "electron"
import type { BrowserBookmark } from "@opencode-ai/app/browser-panel"
import { getStore } from "../store"
import { nativeT } from "../native-translations"
import { browserURL } from "./policy"

export function bookmarks() {
  return getStore("cm-browser").get("bookmarks", []) as BrowserBookmark[]
}

export function saveBookmark(value: Omit<BrowserBookmark, "id"> & { id?: string }) {
  if (
    !browserURL(value.url) ||
    value.url === "about:blank" ||
    typeof value.title !== "string" ||
    value.title.length > 512 ||
    typeof value.pinned !== "boolean" ||
    (value.id !== undefined && typeof value.id !== "string")
  )
    throw new Error("Invalid bookmark")
  const url = new URL(value.url).href
  const rows = bookmarks()
  const previous = rows.find((row) => (value.id ? row.id === value.id : row.url === url))
  if (value.id && !previous) throw new Error("Bookmark not found")
  const remaining = rows.filter((row) => row.id !== previous?.id && row.url !== url)
  if (remaining.length >= 2000) throw new Error("Bookmark limit reached")
  getStore("cm-browser").set("bookmarks", [
    { id: previous?.id ?? randomUUID(), url, title: value.title.trim() || url, pinned: value.pinned },
    ...remaining,
  ])
}

export function deleteBookmark(id: string) {
  if (typeof id !== "string") throw new Error("Invalid bookmark")
  getStore("cm-browser").set(
    "bookmarks",
    bookmarks().filter((row) => row.id !== id),
  )
}

export async function transferBookmarks(win: BrowserWindow) {
  const { bookmarkHTML } = await import("./bookmark-format")
  const chosen = await dialog.showSaveDialog(win, {
    title: nativeT("desktop.browser.exportBookmarks"),
    defaultPath: "bookmarks.html",
    filters: [{ name: "HTML", extensions: ["html"] }],
  })
  if (!chosen.canceled && chosen.filePath)
    await writeFile(chosen.filePath, bookmarkHTML(bookmarks(), nativeT("desktop.browser.bookmarks")), "utf8")
}
