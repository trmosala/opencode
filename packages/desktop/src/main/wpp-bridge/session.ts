// Isolated session + worker-window factory for the WPP assistant pool.
//
// All WPP traffic lives in a dedicated persistent partition so SSO cookies survive restarts
// (the "one-time login" requirement) and stay fully isolated from the oc://renderer session.
// Worker windows are created hidden — the only time one is ever shown is the first-run
// interactive SSO login, handled by a later phase.

import { BrowserWindow, session, type Session } from "electron"

export const WPP_PARTITION = "persist:wpp"

// Origins the assistant is reachable on (mirrors extension/manifest.json host_permissions and
// background.js ASSISTANT_ORIGINS / WORKSPACE_ORIGIN).
export const WPP_WORKSPACE_ORIGIN = "https://ogilvy.os.wpp.com"
export const WPP_ASSISTANT_ORIGINS = [
  "https://open-web-assistant-cs.wpp.ai",
  "https://open-web-deeplink-cs.wpp.ai",
]

export function wppSession(): Session {
  return session.fromPartition(WPP_PARTITION)
}

// One offscreen worker window hosting a single authenticated WPP assistant page. Replaces one
// "owned tab" from the MV3 background.js tab pool. Hidden by default; the pool manager (next
// phase) owns lifecycle, LRU reuse, and per-agent affinity across N of these.
export function createWorkerWindow({ show = false } = {}): BrowserWindow {
  return new BrowserWindow({
    show,
    webPreferences: {
      partition: WPP_PARTITION,
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  })
}
