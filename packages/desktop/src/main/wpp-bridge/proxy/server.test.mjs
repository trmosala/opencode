import { describe, expect, test } from "bun:test"
import { Readable } from "node:stream"
import { isAllowedBrowserRequest, isAllowedHost, readJson } from "./server.mjs"

describe("isAllowedHost", () => {
  test("allows localhost and IP literals, with or without a port", () => {
    const hosts = ["127.0.0.1:8787", "127.0.0.1", "localhost:8787", "LOCALHOST", "[::1]:8787", "192.168.1.20:8787"]
    expect(hosts.filter((host) => !isAllowedHost(host, "127.0.0.1"))).toEqual([])
  })

  test("rejects other hostnames, so a DNS-rebinding page cannot reach the proxy", () => {
    const hosts = [
      undefined,
      "",
      "rebind.example",
      "rebind.example:8787",
      "127.0.0.1.nip.io:8787",
      "localhost.rebind.example",
      "rebind.example@127.0.0.1",
      "127.0.0.1/rebind.example",
      "127.0.0.1 rebind.example",
    ]
    expect(hosts.filter((host) => isAllowedHost(host, "127.0.0.1"))).toEqual([])
  })

  test("allows the configured bind host name", () => {
    expect(isAllowedHost("devbox.lan:8787", "devbox.lan")).toBe(true)
    expect(isAllowedHost("DevBox.lan:8787", "devbox.lan")).toBe(true)
    expect(isAllowedHost("devbox.lan:8787", "127.0.0.1")).toBe(false)
  })
})

describe("isAllowedBrowserRequest", () => {
  test("rejects browser extension origins now that the extension job queue is gone", () => {
    expect(isAllowedBrowserRequest({ origin: "chrome-extension://abcdefghijklmnop" })).toBe(false)
    expect(isAllowedBrowserRequest({ origin: "http://127.0.0.1:8787", "sec-fetch-site": "same-origin" })).toBe(true)
    expect(isAllowedBrowserRequest({})).toBe(true)
  })
})

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
