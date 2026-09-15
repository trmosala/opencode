import { expect, test } from "bun:test"
import { bookmarkHTML, parseBookmarks } from "./bookmark-format"

test("browser bookmark HTML round-trips Unicode, escaped text, URLs and pin state", () => {
  const rows = [{ url: "https://example.com/?a=1&b=%22", title: '<script> & " café', pinned: true }]
  expect(parseBookmarks(bookmarkHTML(rows, "Bookmarks"))).toEqual(rows)
})

test("nested browser exports flatten folders, decode entities and reject unsafe destinations", () => {
  expect(
    parseBookmarks(
      '<DL><DT><H3>Work</H3><DL><DT><A HREF="https://example.com/?a=1&amp;b=2">A &amp; B</A></DL><A HREF="javascript:alert(1)">Bad</A><A HREF="file:///secret">File</A><A HREF="https://user:password@example.com">Secret</A></DL>',
    ),
  ).toEqual([{ url: "https://example.com/?a=1&b=2", title: "A & B", pinned: false }])
  expect(() => parseBookmarks('<A HREF="javascript:alert(1)">Bad</A>')).toThrow()
  expect(() => parseBookmarks("x".repeat(5 * 1024 * 1024 + 1))).toThrow()
})
