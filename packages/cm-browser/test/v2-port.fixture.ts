import type { BrowserPort } from "../src/port"
import type { BrowserState, Request, Response } from "../src/protocol"

// Stands in for Electron main at the parent-port boundary; the plugin and runtime above it are real.
// The plugin loader imports its own module instance, so state lives under one registered symbol.
const shared = ((globalThis as Record<symbol, unknown>)[Symbol.for("cm-browser.v2-test-port")] ??= {
  requests: [] as { sessionID: string; request: Request }[],
  handler: (() => ({ ok: false, code: "unavailable", error: "no handler" })) as (request: Request) => unknown,
}) as { requests: { sessionID: string; request: Request }[]; handler: (request: Request) => unknown }

export const requests = shared.requests

export function respond(next: (request: Request) => unknown) {
  shared.handler = next
}

export const port: BrowserPort = {
  async send(sessionID, request) {
    shared.requests.push({ sessionID, request })
    return shared.handler(request) as Response<BrowserState>
  },
}
