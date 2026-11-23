import http from "node:http"
import { createHash, timingSafeEqual } from "node:crypto"
import { handleChatCompletions, listModels, writeJson } from "./openaiCompat.mjs"
import { writeChatCompletionError } from "./streamAdapter.mjs"
import { extensionBridge } from "./extensionBridge.mjs"
import { setRunLogDir } from "./logging.mjs"
import { renderStatusPage } from "./statusPage.mjs"
import {
  probeProxyOccupant,
  proxyInstanceConflictError,
  proxyPortConflictError,
  shouldIgnoreListenError,
} from "./server-startup.mjs"

const DEFAULT_HOST = process.env.O1_CODE_PROXY_HOST || "127.0.0.1"
const DEFAULT_PORT = Number(process.env.O1_CODE_PROXY_PORT || 8787)
export const MAX_REQUEST_BODY_BYTES = 64 * 1024 * 1024
const LOOPBACK_HOSTS = ["127.0.0.1", "localhost", "::1"]

export async function startServer(options = {}) {
  return startServerWithActions(options)
}

export async function startServerWithActions({
  host = DEFAULT_HOST,
  port = DEFAULT_PORT,
  openLogin = null,
  checkAuth = null,
  chatMode = "assistant",
  token = null,
  logDir = null,
} = {}) {
  // The proxy drives an authenticated WPP session: never expose it beyond this machine.
  if (!LOOPBACK_HOSTS.includes(String(host).toLowerCase())) {
    throw proxyStartupError(
      `Refusing to bind the O1-Code proxy to non-loopback host ${host}.`,
      "o1_code_proxy_non_loopback_host",
    )
  }
  // Every route that does work or exposes diagnostics requires this per-launch bearer token.
  if (typeof token !== "string" || token.length < 16) {
    throw proxyStartupError("The O1-Code proxy requires a per-launch access token.", "o1_code_proxy_token_missing")
  }
  if (logDir) setRunLogDir(logDir)
  extensionBridge.setChatMode(chatMode)
  if (typeof openLogin === "function") extensionBridge.onAuthRequired = openLogin
  const server = http.createServer(async (request, response) => {
    try {
      await route(request, response, { openLogin, checkAuth, token })
    } catch (error) {
      writeRouteError(response, error)
    }
  })

  try {
    await new Promise((resolve, reject) => {
      server.once("error", reject)
      server.listen(port, host, () => {
        server.removeListener("error", reject)
        resolve()
      })
    })
  } catch (error) {
    if (shouldIgnoreListenError(error)) {
      // Only treat EADDRINUSE as success when the occupant is CookieMonster's worker-pool bridge.
      // A foreign wpp-chat-cli extension queue on this port would otherwise swallow every turn.
      // A CookieMonster bridge from another launch holds a different token, so it cannot serve us.
      const occupant = await probeProxyOccupant(host, port, { token })
      if (occupant === "ours") {
        console.log(`o1-code-openai-proxy: already running on http://${host}:${port}/ — nothing to do.`)
        return
      }
      throw occupant === "cookiemonster" ? proxyInstanceConflictError(host, port) : proxyPortConflictError(host, port)
    }

    throw error
  }

  console.log(`o1-code-openai-proxy listening on http://${host}:${port}/v1`)
  return server
}

// Once an SSE stream has started, a JSON error can no longer be written: close the stream with an
// error frame instead (or just end it when the response is already finished).
export function writeRouteError(response, error) {
  if (!response.headersSent) {
    writeJson(response, error?.statusCode || 500, {
      error: {
        message: error?.message,
        type: error?.type || "o1_code_proxy_error",
      },
    })
    return
  }
  if (response.writableEnded) return
  if (String(response.getHeader("content-type") || "").startsWith("text/event-stream")) {
    writeChatCompletionError(response, error)
    return
  }
  response.end()
}

async function route(request, response, actions = {}) {
  const url = new URL(request.url, "http://127.0.0.1")

  // DNS-rebinding defence: a browser page on an attacker-controlled name that resolves to loopback
  // still sends its own Host header.
  if (!isLoopbackHostHeader(request.headers.host, request.socket.localPort)) {
    writeJson(response, 403, {
      error: { message: "Host header must name the loopback O1-Code proxy.", type: "forbidden_host" },
    })
    return
  }

  if (!enforceBrowserOrigin(request, response)) {
    return
  }

  if (request.method === "OPTIONS") {
    writeCors(response, request)
    response.writeHead(204)
    response.end()
    return
  }

  if (request.method === "GET" && (url.pathname === "/" || url.pathname === "/status")) {
    response.writeHead(200, { "content-type": "text/html; charset=utf-8" })
    response.end(renderStatusPage())
    return
  }

  if (request.method === "GET" && url.pathname === "/health") {
    writeJson(response, 200, { ok: true })
    return
  }

  if (
    (url.pathname.startsWith("/v1/") || url.pathname.startsWith("/bridge/")) &&
    !hasBearerToken(request.headers.authorization, actions.token)
  ) {
    writeJson(response, 401, {
      error: { message: "Missing or invalid O1-Code proxy access token.", type: "unauthorized" },
    })
    return
  }

  if (request.method === "GET" && url.pathname === "/bridge/health") {
    writeJson(response, 200, extensionBridge.health())
    return
  }

  if (request.method === "GET" && url.pathname === "/bridge/auth") {
    const state = typeof actions.checkAuth === "function" ? await actions.checkAuth() : { status: "unknown" }
    writeJson(response, 200, { status: state.status })
    return
  }

  if (request.method === "POST" && url.pathname === "/bridge/login") {
    if (typeof actions.openLogin !== "function") {
      writeJson(response, 501, { ok: false, error: "WPP login window is not available." })
      return
    }

    await actions.openLogin()
    writeJson(response, 200, { ok: true })
    return
  }

  if (request.method === "GET" && url.pathname === "/v1/models") {
    writeCors(response, request)
    writeJson(response, 200, listModels())
    return
  }

  if (request.method === "POST" && url.pathname === "/v1/chat/completions") {
    writeCors(response, request)
    const controller = new AbortController()
    const abort = () => {
      if (!response.writableEnded) controller.abort()
    }
    request.once("aborted", abort)
    response.once("close", abort)
    try {
      const body = await readJson(request)
      await handleChatCompletions(request, response, body, { signal: controller.signal })
    } finally {
      request.removeListener("aborted", abort)
      response.removeListener("close", abort)
    }
    return
  }

  writeJson(response, 404, {
    error: {
      message: `No route for ${request.method} ${url.pathname}`,
      type: "not_found",
    },
  })
}

function enforceBrowserOrigin(request, response) {
  if (isAllowedBrowserRequest(request.headers)) {
    return true
  }

  const origin = request.headers.origin || "(no origin)"
  const fetchSite = request.headers["sec-fetch-site"] || "(no sec-fetch-site)"

  writeJson(response, 403, {
    error: {
      message: `Browser request is not allowed to access the local O1-Code proxy: origin=${origin}, sec-fetch-site=${fetchSite}`,
      type: "forbidden_origin",
    },
  })
  return false
}

function writeCors(response, request) {
  const origin = request.headers.origin

  if (!origin || !isAllowedBrowserOrigin(origin)) {
    return
  }

  response.setHeader("access-control-allow-origin", origin)
  response.setHeader("access-control-allow-methods", "GET,POST,OPTIONS")
  response.setHeader("access-control-allow-headers", "content-type,authorization")
  response.setHeader("vary", "origin")
}

// Constant-time comparison of a request's `Authorization: Bearer <token>` against the launch token.
// Hashing first gives both sides one length, so timingSafeEqual never throws or leaks the length.
export function hasBearerToken(header, token) {
  const presented = /^Bearer\s+(\S+)\s*$/i.exec(String(header || ""))?.[1]
  if (!presented || typeof token !== "string" || !token) return false
  return timingSafeEqual(createHash("sha256").update(presented).digest(), createHash("sha256").update(token).digest())
}

export function isLoopbackHostHeader(host, port) {
  const match = /^(127\.0\.0\.1|localhost|\[::1\])(?::(\d+))?$/i.exec(String(host || ""))
  if (!match) return false
  return Number(match[2] ?? 80) === Number(port)
}

export function isAllowedBrowserOrigin(origin) {
  // Server-to-server callers (the OpenCode sidecar) send no Origin; they still need the bearer token.
  if (!origin) {
    return true
  }

  try {
    const url = new URL(origin)

    return url.protocol === "http:" && ["localhost", "127.0.0.1", "::1", "[::1]"].includes(url.hostname)
  } catch {
    return false
  }
}

export function isAllowedBrowserRequest(headers = {}) {
  const origin = headers.origin
  const fetchSite = headers["sec-fetch-site"]

  if (fetchSite === "cross-site") {
    return false
  }

  return isAllowedBrowserOrigin(origin)
}

export async function readJson(request, maxBytes = MAX_REQUEST_BODY_BYTES) {
  const chunks = []
  let totalBytes = 0

  const contentLength = Number(request.headers?.["content-length"])
  if (Number.isFinite(contentLength) && contentLength > maxBytes) {
    throw requestTooLarge(maxBytes)
  }

  for await (const chunk of request) {
    totalBytes += chunk.length
    if (totalBytes > maxBytes) {
      throw requestTooLarge(maxBytes)
    }
    chunks.push(chunk)
  }

  const raw = Buffer.concat(chunks).toString("utf8")

  if (!raw.trim()) {
    return {}
  }

  try {
    return JSON.parse(raw)
  } catch {
    const error = new Error("Request body must be valid JSON.")
    error.statusCode = 400
    throw error
  }
}

function proxyStartupError(message, type) {
  const error = new Error(message)
  error.statusCode = 500
  error.type = type
  return error
}

function requestTooLarge(maxBytes) {
  const error = new Error(`Request body exceeds the ${maxBytes} byte limit.`)
  error.statusCode = 413
  error.type = "request_too_large"
  return error
}
