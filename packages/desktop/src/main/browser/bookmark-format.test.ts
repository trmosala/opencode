import { expect, test } from "bun:test"
import { bookmarkHTML, parseBookmarks } from "./bookmark-format"

test("browser bookmark HTML round-trips Unicode, escaped text, URLs and pin state", () => {
  const rows = [
    {
      url: "https://example.com/?a=1&b=%22",
      title: '<script> & " café',
      pinned: true,
      folder: ["Clients & partners", 'Launch "2026"'],
    },
  ]
  expect(parseBookmarks(bookmarkHTML(rows, "Bookmarks"))).toEqual(rows)
})

test("nested browser exports preserve supported folder paths and traversal order", () => {
  expect(
    parseBookmarks(
      `<DL><p>
        <DT><A HREF="https://root.test">Root</A>
        <DT><H3>Work &amp; clients</H3><DL><p>
          <DT><A HREF="https://example.com/?a=1&amp;b=2">A &amp; B</A>
          <DT><H3>Launch</H3><DL><p><DT><A HREF="https://nested.test" CM_PINNED="1">Nested</A></DL><p>
          <DT><A HREF="javascript:alert(1)">Bad</A>
        </DL><p>
        <DT><A HREF="file:///secret">File</A><A HREF="https://user:password@example.com">Secret</A>
      </DL><p>`,
    ),
  ).toEqual([
    { url: "https://root.test/", title: "Root", pinned: false, folder: [] },
    {
      url: "https://example.com/?a=1&b=2",
      title: "A & B",
      pinned: false,
      folder: ["Work & clients"],
    },
    { url: "https://nested.test/", title: "Nested", pinned: true, folder: ["Work & clients", "Launch"] },
  ])
})

test("bookmark import rejects malformed folder bounds and unsafe-only files", () => {
  expect(() => parseBookmarks('<A HREF="javascript:alert(1)">Bad</A>')).toThrow()
  expect(() => parseBookmarks("x".repeat(5 * 1024 * 1024 + 1))).toThrow()
  expect(() =>
    parseBookmarks(`<DL>${"<DT><H3>Deep</H3><DL>".repeat(9)}<A HREF="https://example.test">A</A></DL></DL>`),
  ).toThrow()
  expect(() =>
    parseBookmarks(`<DL><DT><H3>${"x".repeat(129)}</H3><DL><A HREF="https://example.test">A</A></DL></DL>`),
  ).toThrow()
  expect(() =>
    parseBookmarks(
      `<DL>${Array.from({ length: 2001 }, (_, index) => `<A HREF="https://${index}.example.test">A</A>`).join("")}</DL>`,
    ),
  ).toThrow()
  expect(() =>
    parseBookmarks(
      `<DL>${Array.from({ length: 501 }, (_, index) => `<DT><H3>Folder ${index}</H3><DL><A HREF="https://${index}.example.test">A</A></DL>`).join("")}</DL>`,
    ),
  ).toThrow()
  expect(() =>
    bookmarkHTML([{ url: "https://example.test", title: "A", pinned: false, folder: ["Invalid › folder"] }], "A"),
  ).toThrow()
})
