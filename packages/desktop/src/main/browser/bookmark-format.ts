import { parse } from "parse5"
import type { DefaultTreeAdapterMap } from "parse5"
import { browserURL } from "./policy"

type Node = DefaultTreeAdapterMap["node"]
type Bookmark = { url: string; title: string; pinned: boolean; folder: string[] }
type Tree = { items: ({ bookmark: Bookmark } | { folder: string; tree: Tree })[]; folders: Map<string, Tree> }

function children(node: Node) {
  return "childNodes" in node ? [...node.childNodes] : []
}

function text(node: Node) {
  const values: string[] = []
  const nodes = [node]
  while (nodes.length) {
    const current = nodes.pop()!
    if ("value" in current && current.nodeName === "#text") values.push(current.value)
    nodes.push(...children(current).reverse())
  }
  return values.join("").trim()
}

function folderName(node: Node) {
  const name = text(node)
  if (!name || name.length > 128 || /[\u0000-\u001f\u007f›]/.test(name)) throw new Error("Invalid bookmark folder")
  return name
}

export function parseBookmarks(html: string, counts = { unsupported: 0 }) {
  if (Buffer.byteLength(html) > 5 * 1024 * 1024) throw new Error("Bookmark import too large")
  const rows: Bookmark[] = []
  const folders = new Set<string>()
  const visit = (node: Node, folder: string[]) => {
    if ("tagName" in node && node.tagName === "a") {
      const url = node.attrs.find((attr) => attr.name === "href")?.value
      if (browserURL(url) && url !== "about:blank") {
        rows.push({
          url: new URL(url).href,
          title: text(node).slice(0, 512) || url,
          pinned: node.attrs.some((attr) => attr.name === "cm_pinned" && attr.value === "1"),
          folder: [...folder],
        })
        if (rows.length > 2000) throw new Error("Bookmark limit reached")
      } else counts.unsupported++
      return
    }
    if ("tagName" in node && node.tagName === "dt") {
      const direct = children(node)
      const heading = direct.find((child) => "tagName" in child && child.tagName === "h3")
      const nested = direct.find((child) => "tagName" in child && child.tagName === "dl")
      direct.filter((child) => "tagName" in child && child.tagName === "a").forEach((child) => visit(child, folder))
      if (heading && nested) {
        if (folder.length >= 8) throw new Error("Bookmark folder depth exceeded")
        const next = [...folder, folderName(heading)]
        folders.add(JSON.stringify(next))
        if (folders.size > 500) throw new Error("Bookmark folder limit reached")
        visit(nested, next)
      }
      direct
        .filter((child) => child !== heading && child !== nested && !("tagName" in child && child.tagName === "a"))
        .forEach((child) => visit(child, folder))
      return
    }
    children(node).forEach((child) => visit(child, folder))
  }
  visit(parse(html), [])
  if (!rows.length) throw new Error("No supported bookmarks in file")
  return rows
}

export function bookmarkHTML(rows: Bookmark[], title: string) {
  const escape = (value: string) =>
    value.replaceAll("&", "&amp;").replaceAll('"', "&quot;").replaceAll("<", "&lt;").replaceAll(">", "&gt;")
  const root: Tree = { items: [], folders: new Map() }
  rows.forEach((row) => {
    let tree = root
    if (!Array.isArray(row.folder) || row.folder.length > 8) throw new Error("Invalid bookmark folder")
    row.folder.forEach((value) => {
      if (!value || value.length > 128 || /[\u0000-\u001f\u007f›]/.test(value))
        throw new Error("Invalid bookmark folder")
      let nested = tree.folders.get(value)
      if (!nested) {
        nested = { items: [], folders: new Map() }
        tree.folders.set(value, nested)
        tree.items.push({ folder: value, tree: nested })
      }
      tree = nested
    })
    tree.items.push({ bookmark: row })
  })
  const render = (tree: Tree): string =>
    tree.items
      .map((item) => {
        if ("bookmark" in item)
          return `<DT><A HREF="${escape(item.bookmark.url)}" CM_PINNED="${item.bookmark.pinned ? 1 : 0}">${escape(item.bookmark.title)}</A>`
        return `<DT><H3>${escape(item.folder)}</H3>\n<DL><p>\n${render(item.tree)}\n</DL><p>`
      })
      .join("\n")
  return `<!DOCTYPE NETSCAPE-Bookmark-file-1>\n<META HTTP-EQUIV="Content-Type" CONTENT="text/html; charset=UTF-8">\n<TITLE>${escape(title)}</TITLE>\n<H1>${escape(title)}</H1>\n<DL><p>\n${render(root)}\n</DL><p>\n`
}
