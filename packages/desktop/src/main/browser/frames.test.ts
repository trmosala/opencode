import { expect, test } from "bun:test"
import { boundEmbeddedDocuments } from "./frames"

test("embedded document aggregation trims payload but preserves frame inventory and omission outcomes", () => {
  const result = boundEmbeddedDocuments(
    [
      {
        frameRef: "a".repeat(36),
        origin: "https://calendar.example",
        url: "https://calendar.example/week",
        title: "Calendar week",
        status: "read",
        visibleText: "event ".repeat(600),
        elements: Array.from({ length: 8 }, (_, index) => ({
          ref: `frame.${"b".repeat(36)}:item-${index}`,
          tag: "button",
          role: "button",
          label: `Event ${index}`,
          text: `Event ${index}`,
        })),
      },
      {
        frameRef: "c".repeat(36),
        parentFrameRef: "a".repeat(36),
        origin: "null",
        url: "about:srcdoc",
        title: "Inline calendar",
        status: "unsupported",
        reason: "native_document_context_unavailable",
      },
      {
        frameRef: "d".repeat(36),
        origin: "https://calendar.example",
        url: "https://calendar.example/third-party",
        title: "Third party",
        status: "failed",
        reason: "native_read_failed",
      },
    ],
    [
      { frameRef: "a".repeat(36), origin: "https://calendar.example" },
      { frameRef: "c".repeat(36), origin: "null" },
    ],
    1_500,
  )

  expect(Buffer.byteLength(JSON.stringify(result))).toBeLessThanOrEqual(1_500)
  expect(result.documents.map((document) => document.frameRef)).toEqual([
    "a".repeat(36),
    "c".repeat(36),
    "d".repeat(36),
  ])
  expect(result.documents[0].status).toBe("truncated")
  expect(result.documents[0].reason).toBe("aggregate_transport_limit")
  expect(result.documents[1]).toMatchObject({ status: "unsupported", reason: "native_document_context_unavailable" })
  expect(result.documents[2]).toMatchObject({ status: "failed", reason: "native_read_failed" })
})
