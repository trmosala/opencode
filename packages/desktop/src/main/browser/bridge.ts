import {
  OPERATION_TIMEOUT_MS,
  failure,
  parseBrowserIpcCancel,
  parseBrowserIpcRequest,
  type BrowserIpcResult,
  type BrowserIpcRequest,
  type ActionStatus,
  type ActionFailureCause,
} from "@cookiemonster/cm-browser/protocol"
import { browserDeliveryError, browserResponseNeedsDeliveryCheck, routeBrowserRequest } from "./router"
import { nativeT } from "../native-translations"
import { createBrowserDelegations } from "./delegation"
import type { BrowserSessionResolver } from "./session-resolver"
import { setBrowserOwnerScopeResolver } from "./session-resolver"

type Sidecar = {
  on(event: "message" | "exit", listener: (message: unknown) => void): unknown
  off(event: "message" | "exit", listener: (message: unknown) => void): unknown
  postMessage(message: BrowserIpcResult): void
}

// One handler per child: IDs and cancellation authority never cross sidecars.
export function attachBrowserBridge(child: Sidecar, route = routeBrowserRequest, resolver?: BrowserSessionResolver) {
  const delegations = createBrowserDelegations(resolver)
  const clearOwnerScopeResolver = resolver?.resolveOwnerScope
    ? setBrowserOwnerScopeResolver(resolver.resolveOwnerScope)
    : undefined
  const active = new Map<string, { sessionID: string; controller: AbortController; executionID?: string }>()
  let stopped = false
  const post = (message: BrowserIpcResult, op: BrowserIpcRequest["request"]["op"], check?: () => void) => {
    if (stopped) return
    try {
      if (message.response.ok && browserResponseNeedsDeliveryCheck(op, message.response.result)) {
        try {
          if (!check) throw new Error("Missing browser delivery guard")
          check()
        } catch {
          message = {
            ...message,
            response: {
              ...failure("unavailable", nativeT(browserDeliveryError(op, message.response.result))),
              ...(message.response.actionStatus
                ? {
                    actionStatus:
                      message.response.actionStatus === "dispatched_observed"
                        ? "dispatched_uncertain"
                        : message.response.actionStatus,
                    actionCause: "observation_failed",
                    error: nativeT("desktop.browser.actionObservationFailed"),
                  }
                : {}),
            },
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
      if (entry?.sessionID === cancel.sessionID) {
        if (entry.executionID) delegations.cancel(entry.sessionID, entry.executionID)
        entry.controller.abort()
      }
      return
    }
    const request = parseBrowserIpcRequest(message)
    if (!request) return
    // An occupied correlation ID belongs to its original waiter, even across sessions.
    if (active.has(request.id)) return
    if (active.size >= 256 && request.request.op !== "revoke_tabs") return
    const controller = new AbortController()
    active.set(request.id, {
      sessionID: request.sessionID,
      controller,
      executionID: request.request.op === "grant_tabs" ? request.request.executionID : undefined,
    })
    let replied = false
    let actionDispatched = false
    let actionObservationStarted = false
    const actionStatus = (): ActionStatus => (actionDispatched ? "dispatched_uncertain" : "not_dispatched")
    const actionCause = (): ActionFailureCause => (timedOut ? "timeout" : "cancelled")
    const tracksAction = [
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
    ].includes(request.request.op)
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
        request.request.op,
        screenshotCheck &&
          (() => {
            controller.signal.throwIfAborted()
            if (Date.now() >= deadline) throw new Error("Screenshot deadline")
            screenshotCheck!()
          }),
      )
    }
    let timedOut = false
    const abort = () => {
      if (request.request.op === "grant_tabs") delegations.cancel(request.sessionID, request.request.executionID)
      reply({
        ...failure(
          timedOut ? "timeout" : "cancelled",
          timedOut ? "Browser operation timed out." : "Browser operation cancelled.",
        ),
        ...(tracksAction
          ? {
              actionStatus: actionStatus(),
              ...(actionDispatched ? { actionCause: actionCause() } : {}),
            }
          : {}),
      })
    }
    controller.signal.addEventListener("abort", abort, { once: true })
    const timer = setTimeout(
      () => {
        timedOut = true
        controller.abort()
      },
      Math.max(0, deadline - Date.now()),
    )
    const delivery = (check: () => void) => {
      screenshotCheck = check
    }
    const authority = delegations.authority(request.sessionID)
    const operation =
      request.request.op === "grant_tabs" || request.request.op === "revoke_tabs"
        ? delegations.run(request.sessionID, request.request, controller.signal, delivery)
        : route(request, undefined, {
            authority,
            signal: controller.signal,
            deadline,
            onActionDispatch: () => {
              actionDispatched = true
            },
            onActionObservation: () => {
              actionObservationStarted = true
            },
            onScreenshotDelivery: delivery,
            onSettled: (pending) => {
              settlement = pending
              authority.trackNative?.(pending)
            },
          })
    void operation
      .then(reply, () =>
        reply({
          ...failure("unavailable", "Browser operation unavailable."),
          ...(tracksAction
            ? {
                actionStatus: actionStatus(),
                ...(actionDispatched
                  ? {
                      actionCause: actionObservationStarted
                        ? ("observation_failed" as const)
                        : ("native_action_failed" as const),
                    }
                  : {}),
              }
            : {}),
        }),
      )
      .finally(async () => {
        clearTimeout(timer)
        // A bounded reply is not evidence that an already-dispatched native call finished.
        await settlement?.catch(() => {})
        active.delete(request.id)
      })
  }
  const stop = () => {
    if (stopped) return
    stopped = true
    delegations.stop()
    clearOwnerScopeResolver?.()
    child.off("message", receive)
    child.off("exit", stop)
    active.forEach(({ controller }) => controller.abort())
    active.clear()
  }
  child.on("message", receive)
  child.on("exit", stop)
  return stop
}
