// MAIN-world, document-start injection of the controller relay — the transport counterpart to
// recorder-injection's probe. content.js runs in the same main world and speaks a postMessage
// protocol: job/inspect requests arrive as CONTROLLER_SOURCE frames; results and progress leave
// as BRIDGE_OUT_SOURCE frames. This module bridges those frames to the Electron main process over
// a CDP binding, mirroring recorder-injection's PROBE_BINDING/PROBE_SOURCE pattern.
//
// Inbound (main -> page): Runtime.evaluate posts a CONTROLLER_SOURCE frame into the page's main
// world. Outbound (page -> main): the injected relay forwards every BRIDGE_OUT_SOURCE frame to
// window.<OUT_BINDING>, which surfaces here as a Runtime.bindingCalled event.

import type { WebContents } from "electron"
import { installInRootAndChildTargets } from "./cdp-targets"
import contentSource from "./injected/content.js?raw"

const CONTROLLER_SOURCE = "o1-code-bridge-controller"
const BRIDGE_OUT_SOURCE = "o1-code-bridge-out"
const OUT_BINDING = "__wppBridgeOut"

const RELAY_SOURCE = `
(() => {
  if (window.__wppBridgeControllerInstalled) return;
  window.__wppBridgeControllerInstalled = true;
  window.addEventListener("message", (event) => {
    if (event.source !== window) return;
    const data = event.data;
    if (data && data.source === "${BRIDGE_OUT_SOURCE}" && typeof window.${OUT_BINDING} === "function") {
      try {
        window.${OUT_BINDING}(JSON.stringify(data));
      } catch (_e) {}
    }
  });
})();
`

export type ProgressFrame = { seq: number; finalText: string }
type Pending = { resolve: (result: unknown) => void; reject: (error: Error) => void }

// content.js replies with JOB_RESULT / INSPECT_RESULT keyed by requestId, and emits JOB_PROGRESS
// keyed by jobId. Route the first kind to the awaiting request, the second to the job's progress
// subscriber. Pure (maps in, mutations out) so it tests without Electron.
export function routeOutboundFrame(
  frame: { type?: string; requestId?: string; jobId?: string; result?: unknown; frame?: ProgressFrame },
  pending: Map<string, Pending>,
  progress: Map<string, (frame: ProgressFrame) => void>,
) {
  if (frame.type === "O1_CODE_BRIDGE_JOB_PROGRESS") {
    if (frame.jobId && frame.frame) progress.get(frame.jobId)?.(frame.frame)
    return
  }

  if (frame.type !== "O1_CODE_BRIDGE_JOB_RESULT" && frame.type !== "O1_CODE_BRIDGE_INSPECT_RESULT") return
  if (!frame.requestId) return

  const waiter = pending.get(frame.requestId)
  if (!waiter) return
  pending.delete(frame.requestId)
  waiter.resolve(frame.result)
}

export type Controller = {
  runJob: (job: { id?: string }, onProgress?: (frame: ProgressFrame) => void) => Promise<unknown>
  inspectChat: (timeoutMs?: number) => Promise<unknown>
}

// Attach the debugger, register the outbound binding + relay script, and return a handle that
// posts job/inspect requests into the page and resolves when their matching reply arrives. Shares
// the WebContents debugger with installRecorder; attach + Page.enable are idempotent across both.
export async function installController(contents: WebContents): Promise<Controller> {
  const dbg = contents.debugger

  const pending = new Map<string, Pending>()
  const progress = new Map<string, (frame: ProgressFrame) => void>()

  dbg.on("message", (_event, method, params) => {
    if (method !== "Runtime.bindingCalled") return
    const payload = params as { name?: string; payload?: string }
    if (payload.name !== OUT_BINDING) return
    const frame = parseFrame(payload.payload)
    if (frame) routeOutboundFrame(frame, pending, progress)
  })

  await installInRootAndChildTargets(contents, async (sessionId) => {
    await dbg.sendCommand("Runtime.enable", {}, sessionId)
    await dbg.sendCommand("Runtime.addBinding", { name: OUT_BINDING }, sessionId)
    await dbg.sendCommand("Page.enable", {}, sessionId)
    await dbg.sendCommand("Page.addScriptToEvaluateOnNewDocument", {
      source: RELAY_SOURCE,
      runImmediately: true,
    }, sessionId)
    await dbg.sendCommand("Page.addScriptToEvaluateOnNewDocument", {
      source: contentSource,
      runImmediately: true,
    }, sessionId)
  })

  return {
    runJob: (job, onProgress) => {
      if (onProgress && job?.id) progress.set(job.id, onProgress)
      return send(dbg, pending, "O1_CODE_BRIDGE_RUN_JOB", { job }).finally(() => {
        if (job?.id) progress.delete(job.id)
      })
    },
    inspectChat: (timeoutMs) => send(dbg, pending, "O1_CODE_BRIDGE_INSPECT_CHAT", {}, timeoutMs),
  }
}

function send(
  dbg: WebContents["debugger"],
  pending: Map<string, Pending>,
  type: string,
  extra: Record<string, unknown>,
  timeoutMs = 0,
): Promise<unknown> {
  const requestId = crypto.randomUUID()
  // ponytail: the frame (incl. base64 image payloads) is embedded inline in the evaluate
  // expression. Fine for prompts + a few images; switch to a chunked/binding-fed feed if a large
  // multi-image job ever blows the evaluate string limit.
  const frame = JSON.stringify({ source: CONTROLLER_SOURCE, type, requestId, ...extra })
  const expression = `(() => { const frame = ${frame}; window.postMessage(frame, "*"); for (let i = 0; i < window.frames.length; i += 1) { try { window.frames[i].postMessage(frame, "*"); } catch (_e) {} } })()`

  return new Promise((resolve, reject) => {
    const timeout = timeoutMs > 0
      ? setTimeout(() => {
        pending.delete(requestId)
        reject(new Error(`Timed out waiting for ${type} after ${timeoutMs} ms.`))
      }, timeoutMs)
      : null
    pending.set(requestId, {
      resolve: (result) => {
        if (timeout) clearTimeout(timeout)
        resolve(result)
      },
      reject: (error) => {
        if (timeout) clearTimeout(timeout)
        reject(error)
      },
    })
    dbg.sendCommand("Runtime.evaluate", { expression }).catch((error) => {
      if (timeout) clearTimeout(timeout)
      pending.delete(requestId)
      reject(error)
    })
  })
}

function parseFrame(payload?: string) {
  if (!payload) return null
  try {
    return JSON.parse(payload)
  } catch {
    // A malformed binding frame is unactionable; the awaiting request waits out its own timeout
    // (owned by the caller / extensionBridge), so dropping it here is safe.
    return null
  }
}
