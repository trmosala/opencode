import {
  OPERATION_TIMEOUT_MS,
  failure,
  parseBrowserIpcCancel,
  parseBrowserIpcRequest,
  type BrowserIpcResult,
} from "@cookiemonster/cm-browser/protocol"
import { routeBrowserRequest } from "./router"

type Sidecar = {
  on(event: "message" | "exit", listener: (message: unknown) => void): unknown
  off(event: "message" | "exit", listener: (message: unknown) => void): unknown
  postMessage(message: BrowserIpcResult): void
}

// One handler per child: IDs and cancellation authority never cross sidecars.
export function attachBrowserBridge(child: Sidecar, route = routeBrowserRequest) {
  const active = new Map<string, { sessionID: string; controller: AbortController }>()
  let stopped = false
  const post = (message: BrowserIpcResult) => {
    if (stopped) return
    try {
      child.postMessage(message)
    } catch {
      stop()
    }
  }
  const receive = (message: unknown) => {
    if (stopped) return
    const cancel = parseBrowserIpcCancel(message)
    if (cancel) {
      const entry = active.get(cancel.id)
      if (entry?.sessionID === cancel.sessionID) entry.controller.abort()
      return
    }
    const request = parseBrowserIpcRequest(message)
    if (!request) return
    // An occupied correlation ID belongs to its original waiter, even across sessions.
    if (active.has(request.id)) return
    const controller = new AbortController()
    active.set(request.id, { sessionID: request.sessionID, controller })
    let replied = false
    let settlement: Promise<unknown> | undefined
    const reply = (response: BrowserIpcResult["response"]) => {
      if (replied) return
      replied = true
      controller.signal.removeEventListener("abort", abort)
      post({ type: "browser_result", id: request.id, response })
    }
    const abort = () => reply(failure("cancelled", "Browser operation cancelled."))
    controller.signal.addEventListener("abort", abort, { once: true })
    const operation = route(request, undefined, {
      signal: controller.signal,
      deadline:
        Date.now() +
        (request.request.op === "search_history" || request.request.op === "open_history"
          ? 60_000
          : OPERATION_TIMEOUT_MS),
      onSettled: (pending) => {
        settlement = pending
      },
    })
    void operation
      .then(reply, () => reply(failure("unavailable", "Browser operation unavailable.")))
      .finally(async () => {
        // A bounded reply is not evidence that an already-dispatched native call finished.
        await settlement?.catch(() => {})
        active.delete(request.id)
      })
  }
  const stop = () => {
    if (stopped) return
    stopped = true
    child.off("message", receive)
    child.off("exit", stop)
    active.forEach(({ controller }) => controller.abort())
    active.clear()
  }
  child.on("message", receive)
  child.on("exit", stop)
  return stop
}
