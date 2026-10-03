import { randomUUID } from "node:crypto"
import { writeFile } from "node:fs/promises"
import { dialog } from "electron"
import type { BrowserWindow } from "electron"
import type { BrowserBookmark } from "@opencode-ai/app/browser-panel"
import { getStore } from "../store"
import { nativeT } from "../native-translations"
import { browserNavigationURL } from "./policy"

function record(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value)
}

export function bookmarks() {
  const input: unknown = getStore("cm-browser").get("bookmarks", [])
  if (!Array.isArray(input) || input.length > 2000) throw new Error("Invalid bookmarks")
  const rows = input.map((value): BrowserBookmark => {
    if (!record(value)) throw new Error("Invalid bookmark")
    const row = value
    if (
      typeof row.id !== "string" ||
      !browserNavigationURL(row.url) ||
      row.url === "about:blank" ||
      typeof row.title !== "string" ||
      row.title.length > 512 ||
      (row.pinned !== undefined && typeof row.pinned !== "boolean")
    )
      throw new Error("Invalid bookmark")
    return {
      id: row.id,
      url: new URL(row.url).href,
      title: row.title.trim() || new URL(row.url).href,
      pinned: row.pinned === true,
      folder: bookmarkFolder(row.folder),
    }
  })
  validateFolders(rows)
  if (JSON.stringify(input) !== JSON.stringify(rows)) getStore("cm-browser").set("bookmarks", rows)
  return rows
}

function bookmarkFolder(value: unknown) {
  if (value === undefined) return []
  if (
    !Array.isArray(value) ||
    value.length > 8 ||
    value.some(
      (name) =>
        typeof name !== "string" || !name.trim() || name.trim().length > 128 || /[\u0000-\u001f\u007f›]/.test(name),
    )
  )
    throw new Error("Invalid bookmark folder")
  return value.map((name) => name.trim())
}

function validateFolders(rows: BrowserBookmark[]) {
  const folders = new Set<string>()
  rows.forEach((row) =>
    row.folder.forEach((_name, index) => folders.add(JSON.stringify(row.folder.slice(0, index + 1)))),
  )
  if (folders.size > 500) throw new Error("Bookmark folder limit reached")
}

export function validateBookmarks(rows: BrowserBookmark[]) {
  if (rows.length > 2000) throw new Error("Bookmark limit reached")
  validateFolders(rows)
}

export function writeBookmarks(rows: BrowserBookmark[]) {
  validateBookmarks(rows)
  getStore("cm-browser").set("bookmarks", rows)
}

export function saveBookmark(value: Omit<BrowserBookmark, "id" | "folder"> & { folder?: string[]; id?: string }) {
  if (
    !browserNavigationURL(value.url) ||
    value.url === "about:blank" ||
    typeof value.title !== "string" ||
    value.title.length > 512 ||
    typeof value.pinned !== "boolean" ||
    (value.id !== undefined && typeof value.id !== "string")
  )
    throw new Error("Invalid bookmark")
  const url = new URL(value.url).href
  const folder = bookmarkFolder(value.folder)
  const rows = bookmarks()
  const previous = rows.find((row) => (value.id ? row.id === value.id : row.url === url))
  if (value.id && !previous) throw new Error("Bookmark not found")
  const remaining = rows.filter((row) => row.id !== previous?.id && row.url !== url)
  if (remaining.length >= 2000) throw new Error("Bookmark limit reached")
  const next = { id: previous?.id ?? randomUUID(), url, title: value.title.trim() || url, pinned: value.pinned, folder }
  if (!previous) {
    const result = [next, ...remaining]
    writeBookmarks(result)
    return
  }
  const result = rows.flatMap((row) => (row.id === previous.id ? [next] : row.url === url ? [] : [row]))
  writeBookmarks(result)
}

export function deleteBookmark(id: string) {
  if (typeof id !== "string") throw new Error("Invalid bookmark")
  writeBookmarks(bookmarks().filter((row) => row.id !== id))
}

export function moveBookmark(id: string, direction: "up" | "down") {
  if (typeof id !== "string" || !["up", "down"].includes(direction)) throw new Error("Invalid bookmark move")
  const rows = bookmarks()
  const index = rows.findIndex((row) => row.id === id)
  if (index < 0) throw new Error("Bookmark not found")
  const folder = JSON.stringify(rows[index].folder)
  const siblings = rows.flatMap((row, index) => (JSON.stringify(row.folder) === folder ? [index] : []))
  const position = siblings.indexOf(index)
  const target = siblings[position + (direction === "up" ? -1 : 1)]
  if (target === undefined) return
  const next = [...rows]
  const current = next[index]
  next[index] = next[target]
  next[target] = current
  writeBookmarks(next)
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
