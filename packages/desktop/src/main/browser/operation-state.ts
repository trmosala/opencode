import { randomUUID } from "node:crypto"
import type { BrowserState, Response } from "@cookiemonster/cm-browser/protocol"
import type { BrowserRegistration } from "./registry"
import { browserInputFailure } from "./driver"

type Operation = {
  tab: BrowserRegistration
  id: string
  op: string
  settled: boolean
  response?: Response<BrowserState>
}
const current = new WeakMap<BrowserRegistration, Operation>()

export function startBrowserOperation(tab: BrowserRegistration, op: string, signal: AbortSignal) {
  const operation: Operation = { tab, id: randomUUID(), op, settled: false }
  current.set(tab, operation)
  tab.operation = { id: operation.id, op, status: "running" }
  const interrupted = () => {
    if (current.get(tab) !== operation || operation.settled) return
    tab.operation = { ...tab.operation!, status: "settling" }
    tab.operationChanged?.()
  }
  signal.addEventListener("abort", interrupted, { once: true })
  tab.operationChanged?.()
  return {
    report(response: Response<BrowserState>) {
      if (current.get(tab) !== operation) return
      operation.response = response
      publish(operation)
    },
    finish() {
      signal.removeEventListener("abort", interrupted)
      operation.settled = true
      if (current.get(tab) === operation) publish(operation)
    },
  }
}

function publish(operation: Operation) {
  const tab = operation.tab
  const blocked = browserInputFailure(tab.contents)
  const failed = operation.response && !operation.response.ok ? operation.response : undefined
  const status = !operation.settled
    ? (tab.operation?.status ?? "running")
    : blocked
      ? "quarantined"
      : failed
        ? "failed"
        : undefined
  tab.operation = status
    ? {
        id: operation.id,
        op: operation.op,
        status,
        ...(failed ? { code: failed.code, message: failed.error } : {}),
        ...(blocked ? { code: "input_held", message: blocked.error } : {}),
        ...(operation.response?.actionStatus ? { actionStatus: operation.response.actionStatus } : {}),
        ...(operation.response?.actionCause ? { actionCause: operation.response.actionCause } : {}),
      }
    : undefined
  tab.operationChanged?.()
}
