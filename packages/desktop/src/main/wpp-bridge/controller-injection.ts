import type { WebContents, WebFrameMain } from "electron"
import { installInRootAndChildTargets } from "./cdp-targets"
import { SpawnGate } from "./spawn-gate"
import { agentChatFrame } from "./agent-chat"
import contentSource from "./injected/content.js?raw"

const CONTROLLER_SOURCE = "o1-code-bridge-controller"
const BRIDGE_OUT_SOURCE = "o1-code-bridge-out"
const OUT_BINDING = "__wppBridgeOut"
const ROUTE_KEY = "__wppBridgeControllerRoute"

const RELAY_SOURCE = `
(() => {
  if (window.__wppBridgeControllerInstalled) return;
  window.__wppBridgeControllerInstalled = true;
  window.addEventListener("message", (event) => {
    if (event.source !== window) return;
    const data = event.data;
    if (data && data.source === "${BRIDGE_OUT_SOURCE}" && window.${ROUTE_KEY} && typeof window.${OUT_BINDING} === "function") {
      try {
        window.${OUT_BINDING}(JSON.stringify({ ...data, route: window.${ROUTE_KEY} }));
      } catch (_e) {}
    }
  });
})();
`

export type ProgressFrame = { seq: number; finalText: string }
type Pending = { resolve: (result: unknown) => void; reject: (error: Error) => void }
type Route = { frame: WebFrameMain; token: string; active: boolean }

export function rejectPendingRequests(pending: Map<string, Pending>, error: Error) {
  for (const waiter of pending.values()) waiter.reject(error)
  pending.clear()
}

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
  runJob: (job: { id?: string }, onProgress?: (frame: ProgressFrame) => void, timeoutMs?: number) => Promise<unknown>
  inspectChat: (timeoutMs?: number) => Promise<unknown>
}

export async function installController(contents: WebContents): Promise<Controller> {
  const dbg = contents.debugger
  const pending = new Map<string, Pending>()
  const progress = new Map<string, (frame: ProgressFrame) => void>()
  let route: Route | undefined
  const rejectPending = (message: string) => {
    if (route) route.active = false
    rejectPendingRequests(pending, new Error(message))
    progress.clear()
  }
  contents.once("destroyed", () => rejectPending("WPP worker window was destroyed."))
  contents.once("render-process-gone", (_event, details) => {
    rejectPending(`WPP worker renderer exited (${details.reason}).`)
  })

  dbg.on("message", (_event, method, params) => {
    if (method !== "Runtime.bindingCalled") return
    if (!params || typeof params !== "object" || Reflect.get(params, "name") !== OUT_BINDING) return
    const payload = Reflect.get(params, "payload")
    if (typeof payload !== "string") return
    const frame = parseFrame(payload)
    const current = route
    if (!frame || !current?.active || frame.route !== current.token) return
    void controllerRouteActive(contents, current)
      .then(async (active) => {
        if (!active || !current.active || route !== current) return
        if (frame.type === "O1_CODE_BRIDGE_MAIN_REQUEST") {
          await handleMainRequest(contents, current, frame)
          return
        }
        routeOutboundFrame(frame, pending, progress)
      })
      .catch(() => rejectPending("WPP dedicated chat frame was lost."))
  })

  await installInRootAndChildTargets(contents, async (sessionId) => {
    await dbg.sendCommand("Runtime.enable", {}, sessionId)
    await dbg.sendCommand("Runtime.addBinding", { name: OUT_BINDING }, sessionId)
    await dbg.sendCommand("Page.enable", {}, sessionId)
    await dbg.sendCommand(
      "Page.addScriptToEvaluateOnNewDocument",
      { source: RELAY_SOURCE, runImmediately: true },
      sessionId,
    )
    await dbg.sendCommand(
      "Page.addScriptToEvaluateOnNewDocument",
      { source: contentSource, runImmediately: true },
      sessionId,
    )
  })

  const send = async (type: string, extra: Record<string, unknown>, timeoutMs = 0) => {
    if (route?.active) throw new Error("WPP controller already has an active request.")
    const current: Route = { frame: agentChatFrame(contents), token: crypto.randomUUID(), active: true }
    route = current
    const requestId = crypto.randomUUID()
    try {
      return await new Promise((resolve, reject) => {
        const timeout =
          timeoutMs > 0
            ? setTimeout(() => {
                current.active = false
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
        const frame = JSON.stringify({ source: CONTROLLER_SOURCE, type, requestId, ...extra })
        current.frame
          .executeJavaScript(
            `window.${ROUTE_KEY} = ${JSON.stringify(current.token)}; window.postMessage(${frame}, "*");`,
          )
          .catch((error) => {
            pending.get(requestId)?.reject(error)
            pending.delete(requestId)
          })
      })
    } finally {
      current.active = false
      pending.delete(requestId)
    }
  }

  return {
    runJob: (job, onProgress, timeoutMs) => {
      if (onProgress && job?.id) progress.set(job.id, onProgress)
      return send("O1_CODE_BRIDGE_RUN_JOB", { job }, timeoutMs).finally(() => {
        if (job?.id) progress.delete(job.id)
      })
    },
    inspectChat: (timeoutMs) => send("O1_CODE_BRIDGE_INSPECT_CHAT", {}, timeoutMs),
  }
}

export async function controllerRouteActive(
  contents: Parameters<typeof agentChatFrame>[0],
  route: { frame: { executeJavaScript(code: string): Promise<unknown> }; token: string; active: boolean },
) {
  if (!route.active || agentChatFrame(contents) !== route.frame) return false
  const active = await route.frame.executeJavaScript(`window.${ROUTE_KEY} === ${JSON.stringify(route.token)}`)
  return route.active && active === true
}

function parseFrame(payload?: string) {
  if (!payload) return null
  try {
    const frame = JSON.parse(payload)
    return frame && typeof frame === "object" ? frame : null
  } catch {
    return null
  }
}

type PasteImage = { name?: string; mimeType?: string; data?: string }
type MainRequestFrame = { requestId?: string; action?: string; payload?: { images?: PasteImage[] } }
const delay = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms))
const clipboardGate = new SpawnGate(1)

async function handleMainRequest(contents: WebContents, route: Route, frame: MainRequestFrame) {
  let result: unknown = null
  let error: string | null = null
  try {
    if (frame.action !== "pasteImages") throw new Error(`Unknown main action: ${frame.action}`)
    result = await pasteImagesIntoComposer(contents, route, frame.payload?.images ?? [])
  } catch (e) {
    error = e instanceof Error ? e.message : String(e)
  }
  if (!(await controllerRouteActive(contents, route))) return
  const json = JSON.stringify({
    source: CONTROLLER_SOURCE,
    type: "O1_CODE_BRIDGE_MAIN_RESPONSE",
    requestId: frame.requestId,
    result,
    error,
  })
  await route.frame.executeJavaScript(
    `if (window.${ROUTE_KEY} === ${JSON.stringify(route.token)}) window.postMessage(${json}, "*");`,
  )
}

async function pasteImagesIntoComposer(contents: WebContents, route: Route, images: PasteImage[]) {
  const { clipboard, ClipboardItem, nativeImage } = await import("electron")
  await clipboardGate.acquire()
  try {
    if (!(await controllerRouteActive(contents, route))) throw new Error("WPP image paste was cancelled.")
    const saved = await snapshotClipboard(await clipboard.read())
    const pasted: { name: string; ok: boolean; reason?: string }[] = []
    try {
      for (const image of images) {
        const name = image.name || "image"
        const buffer = Buffer.from(image.data || "", "base64")
        const native = nativeImage.createFromBuffer(buffer)
        if (native.isEmpty()) {
          pasted.push({ name, ok: false, reason: "decode-failed" })
          continue
        }
        if (!(await controllerRouteActive(contents, route))) throw new Error("WPP image paste was cancelled.")
        await clipboard.write([
          new ClipboardItem({
            "image/png": new Blob([new Uint8Array(native.toPNG())], { type: "image/png" }),
          }),
        ])
        if (!(await controllerRouteActive(contents, route))) throw new Error("WPP image paste was cancelled.")
        if (contents.focusedFrame !== route.frame) throw new Error("WPP image composer lost focus.")
        contents.paste()
        await delay(800)
        pasted.push({ name, ok: true })
      }
    } finally {
      if (saved.length === 0) clipboard.clear()
      if (saved.length > 0) await clipboard.write(saved.map((item) => new ClipboardItem(item)))
    }
    return { requested: images.length, pasted }
  } finally {
    clipboardGate.release()
  }
}

export async function snapshotClipboard(
  items: { types: readonly string[]; getType(type: string): Promise<Blob | Electron.ClipboardBookmark> }[],
) {
  return Promise.all(
    items.map(async (item) =>
      Object.fromEntries(await Promise.all(item.types.map(async (type) => [type, await item.getType(type)] as const))),
    ),
  )
}
