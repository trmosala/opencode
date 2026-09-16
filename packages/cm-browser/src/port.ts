import { randomUUID } from "node:crypto"
import {
  OPERATION_TIMEOUT_MS,
  failure,
  parseBrowserIpcResult,
  type BrowserIpcRequest,
  type BrowserIpcCancel,
  type BrowserState,
  type Request,
  type Response,
} from "./protocol"

type ParentPort = {
  postMessage(message: BrowserIpcRequest | BrowserIpcCancel): void
  on(event: "message", listener: (event: { data: unknown }) => void): void
  off(event: "message", listener: (event: { data: unknown }) => void): void
}

export type BrowserPort = {
  readonly send: (sessionID: string, request: Request, signal?: AbortSignal) => Promise<Response<BrowserState>>
}

export function ipcPort(parent = (process as NodeJS.Process & { parentPort?: ParentPort }).parentPort): BrowserPort {
  const pending = new Map<string, (response: Response<BrowserState>) => void>()
  const receive = (event: { data: unknown }) => {
    const result = parseBrowserIpcResult(event.data)
    if (result) pending.get(result.id)?.(result.response)
  }

  return {
    send(sessionID, request, signal) {
      if (signal?.aborted) return Promise.resolve(failure("cancelled", "Browser operation cancelled."))
      if (!parent) return Promise.resolve(failure("unavailable", "CookieMonster parent IPC is unavailable."))
      const id = randomUUID()
      return new Promise((resolve) => {
        let dispatched = false
        const finish = (response: Response<BrowserState>, cancel = false) => {
          if (!pending.delete(id)) return
          clearTimeout(timeout)
          signal?.removeEventListener("abort", abort)
          if (!pending.size) parent.off("message", receive)
          if (cancel && dispatched) {
            // A dead parent cannot receive cancellation; local cleanup must still complete.
            try {
              parent.postMessage({ type: "browser_cancel", id, sessionID })
            } catch {}
          }
          resolve(response)
        }
        const abort = () => finish(failure("cancelled", "Browser operation cancelled."), true)
        const timeout = setTimeout(
          () => finish(failure("timeout", "Browser operation timed out."), true),
          (request.op === "search_history" || request.op === "open_history" ? 60_000 : OPERATION_TIMEOUT_MS) + 1_000,
        )
        if (!pending.size) parent.on("message", receive)
        pending.set(id, finish)
        signal?.addEventListener("abort", abort, { once: true })
        if (signal?.aborted) return abort()
        try {
          dispatched = true
          parent.postMessage({ type: "browser_request", id, sessionID, request })
        } catch {
          finish(failure("unavailable", "CookieMonster parent IPC is unavailable."), true)
        }
      })
    },
  }
}
