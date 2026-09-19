import type { OnCompletedListenerDetails, WebContents, WebFrameMain, WebRequest } from "electron"
import {
  MIN_NETWORK_OBSERVATION_MS,
  MAX_NETWORK_OBSERVATION_MS,
  type NetworkObservation,
} from "@cookiemonster/cm-browser/protocol"

type Source = Pick<WebContents, "id" | "isDestroyed"> & { readonly mainFrame: Pick<WebFrameMain, "detached"> }
type Requests = Pick<WebRequest, "onCompleted" | "onErrorOccurred">
type Details = Pick<OnCompletedListenerDetails, "webContentsId" | "frame" | "resourceType"> &
  Partial<Pick<OnCompletedListenerDetails, "statusCode">>
type Subscriber = (details: Details, failed: boolean, received: number) => void
// webRequest is Session-owned. These two event slots must have no other registrant.
const observers = new WeakMap<Requests, Set<Subscriber>>()
const filter = { urls: ["http://*/*", "https://*/*"], types: ["xhr"] as ["xhr"] }

// Call only after native consent, with authority bound to the exact source/task epochs.
// ponytail: terminal events only; no request history, worker exclusion or complete-coverage claim.
export async function observeNetwork(
  webRequest: Requests,
  contents: Source,
  durationMs: number,
  check: () => void,
  signal?: AbortSignal,
): Promise<NetworkObservation> {
  const unavailable = () => new Error("Network observation unavailable")
  try {
    check()
    signal?.throwIfAborted()
    if (
      !Number.isInteger(durationMs) ||
      durationMs < MIN_NETWORK_OBSERVATION_MS ||
      durationMs > MAX_NETWORK_OBSERVATION_MS
    )
      throw unavailable()
    const frame = contents.mainFrame
    const id = contents.id
    const authority = () => {
      check()
      signal?.throwIfAborted()
      if (contents.isDestroyed() || !frame || frame.detached || contents.mainFrame !== frame || contents.id !== id)
        throw unavailable()
    }
    authority()
    const end = performance.now() + durationMs
    const counts = { http1xx: 0, http2xx: 0, http3xx: 0, http4xx: 0, http5xx: 0, other: 0, failed: 0 }
    let subscribers = observers.get(webRequest)
    const first = !subscribers
    if (!subscribers) {
      subscribers = new Set()
      observers.set(webRequest, subscribers)
    }
    const active = subscribers
    return await new Promise<NetworkObservation>((resolve, reject) => {
      let settled = false
      let timer: ReturnType<typeof setTimeout> | undefined
      const finish = (invalid = false) => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        signal?.removeEventListener("abort", abort)
        active.delete(receive)
        if (!active.size) {
          observers.delete(webRequest)
          // Try both removals even if a native registration/removal throws.
          try {
            webRequest.onCompleted(filter, null)
          } catch {
            invalid = true
          }
          try {
            webRequest.onErrorOccurred(filter, null)
          } catch {
            invalid = true
          }
        }
        try {
          authority()
          if (invalid) throw unavailable()
          resolve({ ...counts, durationMs, total: Object.values(counts).reduce((sum, count) => sum + count, 0) })
        } catch {
          reject(unavailable())
        }
      }
      const receive: Subscriber = (details, failed, received) => {
        if (settled) return
        try {
          // Check authority and cutoff before accessing any event field.
          authority()
          if (received >= end) return finish()
          if (details.webContentsId !== id || details.resourceType !== "xhr") return
          const requesting = details.frame
          if (!requesting || requesting !== frame || requesting.detached) return
          if (failed) {
            counts.failed++
            return
          }
          const status = details.statusCode
          if (typeof status !== "number" || !Number.isInteger(status) || status < 100 || status >= 600) {
            counts.other++
            return
          }
          if (status < 200) {
            counts.http1xx++
            return
          }
          if (status < 300) {
            counts.http2xx++
            return
          }
          if (status < 400) {
            counts.http3xx++
            return
          }
          if (status < 500) {
            counts.http4xx++
            return
          }
          counts.http5xx++
        } catch {
          finish(true)
        }
      }
      const abort = () => finish(true)
      const expire = () => {
        const remaining = end - performance.now()
        if (remaining > 0) {
          timer = setTimeout(expire, remaining)
          return
        }
        finish()
      }
      active.add(receive)
      signal?.addEventListener("abort", abort, { once: true })
      try {
        authority()
        if (first) {
          webRequest.onCompleted(filter, (details) => {
            const received = performance.now()
            active.forEach((subscriber) => subscriber(details, false, received))
          })
          webRequest.onErrorOccurred(filter, (details) => {
            const received = performance.now()
            active.forEach((subscriber) => subscriber(details, true, received))
          })
        }
        if (!settled) timer = setTimeout(expire, Math.max(0, end - performance.now()))
      } catch {
        finish(true)
      }
    })
  } catch {
    // Never propagate native/authority errors that might contain request data.
    throw unavailable()
  }
}
