import type { EventEmitter } from "node:events"
import type { ConsoleObservation } from "@cookiemonster/cm-browser/protocol"

export async function observeConsole(
  contents: EventEmitter,
  durationMs: number,
  check: () => void,
  signal?: AbortSignal,
) {
  check()
  const counts = { debug: 0, info: 0, warning: 0, error: 0, other: 0 }
  return new Promise<ConsoleObservation>((resolve, reject) => {
    let settled = false
    const finish = (error?: unknown) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      contents.removeListener("console-message", message)
      signal?.removeEventListener("abort", abort)
      if (error) {
        reject(error)
        return
      }
      try {
        check()
        resolve({ ...counts, durationMs, total: Object.values(counts).reduce((total, count) => total + count, 0) })
      } catch (cause) {
        reject(cause)
      }
    }
    const message = (event: unknown) => {
      try {
        check()
        const details = event as { level?: unknown; params?: { level?: unknown } }
        const level = details.level ?? details.params?.level
        if (level === "debug") counts.debug++
        else if (level === "info") counts.info++
        else if (level === "warning") counts.warning++
        else if (level === "error") counts.error++
        else counts.other++
      } catch (cause) {
        finish(cause)
      }
    }
    const abort = () => finish(signal?.reason ?? new DOMException("Browser operation cancelled", "AbortError"))
    const timer = setTimeout(() => finish(), durationMs)
    contents.on("console-message", message)
    signal?.addEventListener("abort", abort, { once: true })
    if (signal?.aborted) abort()
  })
}
