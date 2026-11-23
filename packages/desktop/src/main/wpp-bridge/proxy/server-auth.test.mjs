import { expect, test } from "bun:test"
import http from "node:http"
import {
  hasBearerToken,
  isAllowedBrowserOrigin,
  isAllowedBrowserRequest,
  isLoopbackHostHeader,
  startServerWithActions,
  writeRouteError,
} from "./server.mjs"

const token = "test-token-0123456789abcdef"
const authorization = { authorization: `Bearer ${token}` }

async function withServer(options, run) {
  const server = await startServerWithActions({ host: "127.0.0.1", port: 0, token, ...options })
  try {
    await run("http://127.0.0.1:" + server.address().port, server.address().port)
  } finally {
    server.closeAllConnections()
    await new Promise((resolve) => server.close(resolve))
  }
}

// fetch() always derives Host from the URL, so a rebinding Host header needs a raw request.
function rawRequest(port, path, headers) {
  return new Promise((resolve, reject) => {
    const request = http.request({ host: "127.0.0.1", port, path, method: "GET", headers }, (response) => {
      response.resume()
      response.on("end", () => resolve(response.statusCode))
    })
    request.on("error", reject)
    request.end()
  })
}

test("live auth probe discloses only status, enforces origin checks and opens sign-in", async () => {
  let status = "signed-out"
  let login = 0
  await withServer(
    {
      checkAuth: async () => ({ status, expires_at: 123, access_token: "must-not-be-disclosed" }),
      openLogin: async () => {
        login++
      },
    },
    async (url) => {
      expect(await (await fetch(url + "/bridge/auth", { headers: authorization })).json()).toEqual({
        status: "signed-out",
      })
      status = "signed-in"
      expect(await (await fetch(url + "/bridge/auth", { headers: authorization })).json()).toEqual({
        status: "signed-in",
      })
      expect(
        (await fetch(url + "/bridge/auth", { headers: { ...authorization, Origin: "https://untrusted.example" } }))
          .status,
      ).toBe(403)
      expect((await fetch(url + "/bridge/login", { method: "POST", headers: authorization })).status).toBe(200)
      expect(login).toBe(1)
    },
  )
})

test("missing auth probe reports unknown", async () => {
  await withServer({}, async (url) => {
    const response = await fetch(url + "/bridge/auth", { headers: authorization })
    expect(await response.json()).toEqual({ status: "unknown" })
  })
})

test("every /v1 and /bridge route requires the launch token", async () => {
  let login = 0
  await withServer(
    {
      openLogin: async () => {
        login++
      },
    },
    async (url) => {
      const routes = [
        ["GET", "/v1/models"],
        ["POST", "/v1/chat/completions"],
        ["GET", "/bridge/health"],
        ["GET", "/bridge/auth"],
        ["POST", "/bridge/login"],
      ]
      for (const [method, path] of routes) {
        expect((await fetch(url + path, { method })).status).toBe(401)
        expect((await fetch(url + path, { method, headers: { authorization: "Bearer wrong-token" } })).status).toBe(401)
        expect((await fetch(url + path, { method, headers: { authorization: token } })).status).toBe(401)
      }
      expect(login).toBe(0)
      expect((await fetch(url + "/v1/models", { headers: authorization })).status).toBe(200)
      expect((await fetch(url + "/bridge/health", { headers: authorization })).status).toBe(200)
      // The status shell and liveness check carry no session data.
      expect((await fetch(url + "/health")).status).toBe(200)
      expect((await fetch(url + "/status")).status).toBe(200)
    },
  )
})

test("rejects a DNS-rebinding Host header even with the token", async () => {
  await withServer({}, async (_url, port) => {
    expect(await rawRequest(port, "/bridge/health", { ...authorization, host: `127.0.0.1:${port}` })).toBe(200)
    expect(await rawRequest(port, "/bridge/health", { ...authorization, host: `localhost:${port}` })).toBe(200)
    expect(await rawRequest(port, "/bridge/health", { ...authorization, host: `attacker.example:${port}` })).toBe(403)
    expect(await rawRequest(port, "/status", { host: `attacker.example:${port}` })).toBe(403)
    expect(await rawRequest(port, "/bridge/health", { ...authorization, host: `127.0.0.1:${port + 1}` })).toBe(403)
  })
})

test("refuses to start on a non-loopback host or without a token", async () => {
  await expect(startServerWithActions({ host: "0.0.0.0", port: 0, token })).rejects.toMatchObject({
    type: "o1_code_proxy_non_loopback_host",
  })
  await expect(startServerWithActions({ host: "192.168.1.10", port: 0, token })).rejects.toMatchObject({
    type: "o1_code_proxy_non_loopback_host",
  })
  await expect(startServerWithActions({ host: "127.0.0.1", port: 0 })).rejects.toMatchObject({
    type: "o1_code_proxy_token_missing",
  })
})

test("bearer and host checks", () => {
  expect(hasBearerToken(`Bearer ${token}`, token)).toBe(true)
  expect(hasBearerToken(`bearer ${token}`, token)).toBe(true)
  expect(hasBearerToken(`Bearer ${token}x`, token)).toBe(false)
  expect(hasBearerToken("Bearer ", token)).toBe(false)
  expect(hasBearerToken(undefined, token)).toBe(false)
  expect(hasBearerToken(`Bearer ${token}`, null)).toBe(false)
  expect(isLoopbackHostHeader("127.0.0.1:8787", 8787)).toBe(true)
  expect(isLoopbackHostHeader("[::1]:8787", 8787)).toBe(true)
  expect(isLoopbackHostHeader("LOCALHOST:8787", 8787)).toBe(true)
  expect(isLoopbackHostHeader("127.0.0.1", 8787)).toBe(false)
  expect(isLoopbackHostHeader("127.0.0.1.attacker.example:8787", 8787)).toBe(false)
  expect(isLoopbackHostHeader(undefined, 8787)).toBe(false)
})

test("no longer trusts chrome-extension origins", () => {
  expect(isAllowedBrowserOrigin("chrome-extension://abcdefghijklmnop")).toBe(false)
  expect(isAllowedBrowserRequest({ origin: "chrome-extension://abcdefghijklmnop" })).toBe(false)
  expect(isAllowedBrowserRequest({ origin: "http://127.0.0.1:3000", "sec-fetch-site": "same-site" })).toBe(true)
  expect(isAllowedBrowserRequest({})).toBe(true)
})

test("a route failure after SSE headers ends the stream with an error frame", () => {
  const writes = []
  let ended = false
  const response = {
    headersSent: true,
    writableEnded: false,
    getHeader: () => "text/event-stream; charset=utf-8",
    writeHead: () => {
      throw new Error("ERR_HTTP_HEADERS_SENT")
    },
    write: (chunk) => writes.push(chunk),
    end: () => {
      ended = true
    },
  }
  writeRouteError(response, Object.assign(new Error("boom"), { type: "o1_code_prompt_too_large" }))
  expect(ended).toBe(true)
  expect(writes.join("")).toContain('"type":"o1_code_prompt_too_large"')
  expect(writes.join("")).toContain("data: [DONE]")
})
