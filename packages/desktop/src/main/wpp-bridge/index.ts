// WPP bridge seam entrypoint.
//
// Everything WPP-specific lives under this folder so a future extraction stays cheap and the
// upstream touch is minimal (just a single call from main/index.ts). This module owns booting
// the dep-free OpenAI-compatible proxy (server.mjs) in the Electron main process.
//
// The proxy keeps serving its HTTP /v1 surface (the OpenCode server sidecar reaches it over
// localhost; its server-to-server fetch sends no Origin, which the proxy's origin guard allows).
// The /bridge/* endpoints stay mounted for the status page; later phases can collapse that hop to
// direct extensionBridge calls now that the queue and the webview pool share this process.

import { startServer } from "./proxy/server.mjs"

const DEFAULT_HOST = process.env.O1_CODE_PROXY_HOST || "127.0.0.1"
const DEFAULT_PORT = Number(process.env.O1_CODE_PROXY_PORT || 8787)

let starting: Promise<void> | null = null

export type WppBridgeOptions = {
  host?: string
  port?: number
  openLogin?: () => void | Promise<void>
}

// Boot the proxy exactly once. Safe to call repeatedly — concurrent/late callers await the same
// in-flight promise. server.mjs already self-handles EADDRINUSE (an existing proxy on the port is
// the desired end state), so a second app instance won't crash here.
export function startWppBridge(options: WppBridgeOptions = {}): Promise<void> {
  if (starting) return starting

  const host = options.host ?? DEFAULT_HOST
  const port = options.port ?? DEFAULT_PORT

  starting = startServer({ host, port, openLogin: options.openLogin }).catch((error) => {
    // Reset so a later retry can re-attempt instead of being pinned to a rejected promise.
    starting = null
    throw error
  })

  return starting
}

export { DEFAULT_HOST as WPP_PROXY_HOST, DEFAULT_PORT as WPP_PROXY_PORT }
