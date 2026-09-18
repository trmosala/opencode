import {
  OPERATION_TIMEOUT_MS,
  failure,
  parseBrowserIpcCancel,
  parseBrowserIpcRequest,
  type BrowserIpcResult,
} from "@cookiemonster/cm-browser/protocol"
import { routeBrowserRequest } from "./router"
import { nativeT } from "../native-translations"

type Sidecar = {
  on(event: "message" | "exit", listener: (message: unknown) => void): unknown
  off(event: "message" | "exit", listener: (message: unknown) => void): unknown
  postMessage(message: BrowserIpcResult): void
}

// One handler per child: IDs and cancellation authority never cross sidecars.
export function attachBrowserBridge(child: Sidecar, route = routeBrowserRequest) {
  const active = new Map<string, { sessionID: string; controller: AbortController }>()
  let stopped = false
  const post = (message: BrowserIpcResult, screenshot = false, check?: () => void) => {
    if (stopped) return
    try {
      if (
        message.response.ok &&
        (screenshot ||
          message.response.result.screenshot !== undefined ||
          message.response.result.frames !== undefined ||
          message.response.result.frameRef !== undefined ||
          message.response.result.frameContext !== undefined ||
          message.response.result.frameSelectContext !== undefined ||
          message.response.result.diagnostics !== undefined ||
          message.response.result.siteTools !== undefined ||
          message.response.result.siteToolContext !== undefined ||
          message.response.result.siteToolResult !== undefined)
      ) {
        try {
          if (!check) throw new Error("Missing screenshot delivery guard")
          check()
        } catch {
          message = {
            ...message,
            response: failure(
              "unavailable",
              nativeT(
                message.response.result.diagnostics !== undefined
                  ? "desktop.browser.diagnosticsDeliveryUnavailable"
                  : message.response.result.siteTools !== undefined ||
                      message.response.result.siteToolContext !== undefined ||
                      message.response.result.siteToolResult !== undefined
                    ? "desktop.browser.siteToolDeliveryUnavailable"
                    : "desktop.browser.screenshotDeliveryUnavailable",
              ),
            ),
          }
        }
      }
      // Disclosure commit: no await between the captured authority check and post.
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
    let screenshotCheck: (() => void) | undefined
    const deadline =
      Date.now() +
      (request.request.op === "search_history" || request.request.op === "open_history" ? 60_000 : OPERATION_TIMEOUT_MS)
    const reply = (response: BrowserIpcResult["response"]) => {
      if (replied) return
      replied = true
      controller.signal.removeEventListener("abort", abort)
      post(
        { type: "browser_result", id: request.id, response },
        request.request.op === "screenshot",
        screenshotCheck &&
          (() => {
            controller.signal.throwIfAborted()
            if (Date.now() >= deadline) throw new Error("Screenshot deadline")
            screenshotCheck!()
          }),
      )
    }
    const abort = () => reply(failure("cancelled", "Browser operation cancelled."))
    controller.signal.addEventListener("abort", abort, { once: true })
    const operation = route(request, undefined, {
      signal: controller.signal,
      deadline,
      onScreenshotDelivery: (check) => {
        screenshotCheck = check
      },
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
