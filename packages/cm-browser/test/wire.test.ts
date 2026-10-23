import { expect, test } from "bun:test"
import { MAX_BROWSER_REQUEST_BYTES, parseBrowserWireRequest } from "../src/protocol"

test("wire boundary includes unused fields and UTF-8 bytes in the budget", () => {
  const request = { type: "browser_request", id: "one", sessionID: "session", request: { op: "list_tabs" } } as const
  expect(parseBrowserWireRequest(JSON.stringify(request))).toEqual(request)
  expect(parseBrowserWireRequest(JSON.stringify(request).padEnd(MAX_BROWSER_REQUEST_BYTES, " "))).toEqual(request)
  expect(parseBrowserWireRequest(JSON.stringify(request).padEnd(MAX_BROWSER_REQUEST_BYTES + 1, " "))).toBeUndefined()
  expect(parseBrowserWireRequest(JSON.stringify({ ...request, unused: "x".repeat(1024 * 1024) }))).toBeUndefined()
  expect(
    parseBrowserWireRequest(JSON.stringify({ ...request, unused: "界".repeat(MAX_BROWSER_REQUEST_BYTES / 2) })),
  ).toBeUndefined()
  expect(parseBrowserWireRequest("{")).toBeUndefined()
  expect(
    parseBrowserWireRequest(
      JSON.stringify({
        ...request,
        request: {
          op: "prepare_write",
          request: { op: "fill", tabID: "one", ref: "one", text: "\u0000".repeat(10000) },
        },
      }),
    ),
  ).toBeDefined()
})
