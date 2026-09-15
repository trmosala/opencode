import { parse } from "parse5"
import type { DefaultTreeAdapterMap } from "parse5"
import { browserURL } from "./policy"

export function parseBookmarks(html: string) {
  if (Buffer.byteLength(html) > 5 * 1024 * 1024) throw new Error("Bookmark import too large")
  const nodes: DefaultTreeAdapterMap["node"][] = [parse(html)]
  const rows: { url: string; title: string; pinned: boolean }[] = []
  while (nodes.length) {
    const node = nodes.pop()!
    if ("tagName" in node && node.tagName === "a") {
      const url = node.attrs.find((attr) => attr.name === "href")?.value
      if (browserURL(url) && url !== "about:blank") {
        const text: string[] = []
        const children: DefaultTreeAdapterMap["node"][] = [...node.childNodes].reverse()
        while (children.length) {
          const child = children.pop()!
          if ("value" in child && child.nodeName === "#text") text.push(child.value)
          if ("childNodes" in child) children.push(...[...child.childNodes].reverse())
        }
        rows.push({
          url: new URL(url).href,
          title: text.join("").trim().slice(0, 512) || url,
          pinned: node.attrs.some((attr) => attr.name === "cm_pinned" && attr.value === "1"),
        })
        if (rows.length > 2000) throw new Error("Bookmark limit reached")
      }
    }
    if ("childNodes" in node) nodes.push(...[...node.childNodes].reverse())
  }
  if (!rows.length) throw new Error("No supported bookmarks in file")
  return rows
}

export function bookmarkHTML(rows: { url: string; title: string; pinned: boolean }[], title: string) {
  const escape = (value: string) =>
    value.replaceAll("&", "&amp;").replaceAll('"', "&quot;").replaceAll("<", "&lt;").replaceAll(">", "&gt;")
  return (
    `<!DOCTYPE NETSCAPE-Bookmark-file-1>\n<META HTTP-EQUIV="Content-Type" CONTENT="text/html; charset=UTF-8">\n<TITLE>${escape(title)}</TITLE>\n<H1>${escape(title)}</H1>\n<DL><p>\n` +
    rows
      .map((row) => `<DT><A HREF="${escape(row.url)}" CM_PINNED="${row.pinned ? 1 : 0}">${escape(row.title)}</A>`)
      .join("\n") +
    "\n</DL><p>\n"
  )
}
