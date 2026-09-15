import { randomUUID } from "node:crypto"
import { open, writeFile } from "node:fs/promises"
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

export async function transferBookmarks(win: BrowserWindow, action: "bookmark-import" | "bookmark-export") {
  const { parseBookmarks, bookmarkHTML } = await import("./bookmark-format")
  if (action === "bookmark-export") {
    const chosen = await dialog.showSaveDialog(win, {
      title: nativeT("desktop.browser.exportBookmarks"),
      defaultPath: "bookmarks.html",
      filters: [{ name: "HTML", extensions: ["html"] }],
    })
    if (!chosen.canceled && chosen.filePath)
      await writeFile(chosen.filePath, bookmarkHTML(bookmarks(), nativeT("desktop.browser.bookmarks")), "utf8")
    return
  }
  const chosen = await dialog.showOpenDialog(win, {
    title: nativeT("desktop.browser.importBookmarks"),
    properties: ["openFile"],
    filters: [{ name: "HTML", extensions: ["html", "htm"] }],
  })
  if (chosen.canceled || !chosen.filePaths[0]) return
  const file = await open(chosen.filePaths[0], "r")
  const buffer = Buffer.alloc(5 * 1024 * 1024 + 1)
  let length = 0
  try {
    if (!(await file.stat()).isFile()) throw new Error("Invalid import file")
    while (length < buffer.length) {
      const result = await file.read(buffer, length, buffer.length - length, null)
      if (!result.bytesRead) break
      length += result.bytesRead
    }
  } finally {
    await file.close()
  }
  if (length === buffer.length) throw new Error("Bookmark import too large")
  const imported = parseBookmarks(buffer.toString("utf8", 0, length))
  const next = new Map(bookmarks().map((row) => [row.url, row]))
  imported.forEach((row) => {
    if (!next.has(row.url)) next.set(row.url, { ...row, id: randomUUID() })
  })
  if (next.size > 2000) throw new Error("Bookmark limit reached")
  getStore("cm-browser").set("bookmarks", [...next.values()])
}
