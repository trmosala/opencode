import { describe, expect, test } from "bun:test"
import { Readable } from "node:stream"
import { readJson } from "./server.mjs"

describe("readJson", () => {
  test("rejects a declared request body above the limit before reading it", async () => {
    const request = Readable.from([Buffer.from("{}")])
    request.headers = { "content-length": "11" }

    await expect(readJson(request, 10)).rejects.toMatchObject({
      statusCode: 413,
      type: "request_too_large",
    })
  })

  test("rejects a streamed request body once it crosses the limit", async () => {
    const request = Readable.from([Buffer.from('{"value":'), Buffer.from('"large"}')])
    request.headers = {}

    await expect(readJson(request, 10)).rejects.toMatchObject({
      statusCode: 413,
      type: "request_too_large",
    })
  })
})
