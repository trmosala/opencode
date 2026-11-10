// WPP bridge seam entrypoint.
//
// Everything WPP-specific lives under this folder so a future extraction stays cheap and the
// upstream touch is minimal (just a single call from main/index.ts). This module owns booting
// the dep-free OpenAI-compatible proxy (server.mjs) in the Electron main process.
//
// The proxy keeps serving its HTTP /v1 surface (the OpenCode server sidecar reaches it over
// localhost; its server-to-server fetch sends no Origin, which the proxy's origin guard allows).
// The extension job queue (/bridge/jobs|results|...) is gone: jobs run in-process via the webview
// worker pool. Only /bridge/health and /bridge/login remain, feeding the diagnostic status page.

import { getStore } from "../store"
import { startServer } from "./proxy/server.mjs"

const DEFAULT_HOST = process.env.O1_CODE_PROXY_HOST || "127.0.0.1"
const DEFAULT_PORT = Number(process.env.O1_CODE_PROXY_PORT || 8787)

let starting: Promise<void> | null = null

export type WppBridgeOptions = {
  host?: string
  port?: number
  openLogin?: () => void | Promise<void>
  checkAuth?: () => Promise<{ status: string }>
}

// Boot the proxy exactly once. Safe to call repeatedly — concurrent/late callers await the same
// in-flight promise. server.mjs treats EADDRINUSE as success only when the occupant advertises the
// CookieMonster worker-pool bridge health marker; a foreign proxy (e.g. wpp-chat-cli) fails loud.
export function startWppBridge(options: WppBridgeOptions = {}): Promise<void> {
  if (starting) return starting

  const host = options.host ?? DEFAULT_HOST
  const port = options.port ?? DEFAULT_PORT

  starting = startServer({
    host,
    port,
    chatMode: getStore().get("wppChatMode") === "agent" ? "agent" : "assistant",
    openLogin: options.openLogin,
    checkAuth: options.checkAuth,
  }).catch((error) => {
    // Reset so a later retry can re-attempt instead of being pinned to a rejected promise.
    starting = null
    throw error
  })

  return starting
}

export { DEFAULT_HOST as WPP_PROXY_HOST, DEFAULT_PORT as WPP_PROXY_PORT }
