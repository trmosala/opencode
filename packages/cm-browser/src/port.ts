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

const actionRequest = (request: Request) =>
  [
    "navigate",
    "click",
    "hover",
    "drag",
    "select_option",
    "fill",
    "press_key",
    "scroll",
    "execute_site_tool",
    "frame_input",
    "visual_action",
  ].includes(request.op)

export function ipcPort(parent = (process as NodeJS.Process & { parentPort?: ParentPort }).parentPort): BrowserPort {
  const pending = new Map<string, { finish: (response: Response<BrowserState>) => void; action: boolean }>()
  const receive = (event: { data: unknown }) => {
    const result = parseBrowserIpcResult(event.data)
    if (result) pending.get(result.id)?.finish(result.response)
    if (result || !event.data || typeof event.data !== "object") return
    const malformed = event.data as Record<string, unknown>
    if (malformed.type !== "browser_result" || typeof malformed.id !== "string") return
    const entry = pending.get(malformed.id)
    entry?.finish({
      ...failure("bad_request", "CookieMonster browser acknowledgement was malformed."),
      ...(entry.action ? { actionStatus: "dispatched_uncertain", actionCause: "transport_unknown" } : {}),
    })
  }

  return {
    send(sessionID, request, signal) {
      if (signal?.aborted)
        return Promise.resolve({
          ...failure("cancelled", "Browser operation cancelled."),
          ...(actionRequest(request) ? { actionStatus: "not_dispatched" as const } : {}),
        })
      if (!parent)
        return Promise.resolve({
          ...failure("unavailable", "CookieMonster parent IPC is unavailable."),
          ...(actionRequest(request) ? { actionStatus: "not_dispatched" as const } : {}),
        })
      const id = randomUUID()
      return new Promise((resolve) => {
        let dispatched = false
        let cancelTimeout: ReturnType<typeof setTimeout> | undefined
        const finish = (response: Response<BrowserState>, cancel = false) => {
          if (!pending.delete(id)) return
          clearTimeout(timeout)
          clearTimeout(cancelTimeout)
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
        const abort = () => {
          if (!dispatched) return finish(failure("cancelled", "Browser operation cancelled."))
          try {
            parent.postMessage({ type: "browser_cancel", id, sessionID })
            cancelTimeout = setTimeout(
              () =>
                finish({
                  ...failure("cancelled", "Browser operation cancelled."),
                  ...(actionRequest(request)
                    ? { actionStatus: "dispatched_uncertain" as const, actionCause: "transport_unknown" as const }
                    : {}),
                }),
              1_000,
            )
          } catch {
            finish({
              ...failure("cancelled", "Browser operation cancelled."),
              ...(actionRequest(request)
                ? { actionStatus: "dispatched_uncertain" as const, actionCause: "transport_unknown" as const }
                : {}),
            })
          }
        }
        const timeout = setTimeout(
          () =>
            finish(
              {
                ...failure("timeout", "Browser operation timed out."),
                ...(dispatched && actionRequest(request)
                  ? { actionStatus: "dispatched_uncertain" as const, actionCause: "transport_unknown" as const }
                  : {}),
              },
              true,
            ),
          (request.op === "search_history" || request.op === "open_history" ? 60_000 : OPERATION_TIMEOUT_MS) + 1_000,
        )
        if (!pending.size) parent.on("message", receive)
        pending.set(id, { finish, action: actionRequest(request) })
        signal?.addEventListener("abort", abort, { once: true })
        if (signal?.aborted) return abort()
        try {
          dispatched = true
          parent.postMessage({ type: "browser_request", id, sessionID, request })
        } catch {
          finish(
            {
              ...failure("unavailable", "CookieMonster parent IPC is unavailable."),
              ...(actionRequest(request)
                ? { actionStatus: "dispatched_uncertain" as const, actionCause: "transport_unknown" as const }
                : {}),
            },
            true,
          )
        }
      })
    },
  }
}
