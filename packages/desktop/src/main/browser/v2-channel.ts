import { randomUUID } from "node:crypto"
import { EventEmitter } from "node:events"
import { OpenCode } from "@opencode/client"
import { BrowserRpc } from "@cookiemonster/cm-browser/rpc"
import { SidecarCredentials } from "../service/sidecar-credentials"
import { attachBrowserBridge } from "./bridge"
import { createBrowserSessionResolver } from "./session-resolver"
import { parseBrowserWireRequest, type BrowserIpcResult } from "@cookiemonster/cm-browser/protocol"

let current: ReturnType<typeof createChannel> | undefined

export async function connectBrowser(sessionID: string) {
  const endpoint = SidecarCredentials.get()

  if (!endpoint?.password) throw new Error("CookieMonster backend is unavailable")

  if (!current || current.closed || current.endpoint !== endpoint) {
    current?.close()
    current = createChannel(endpoint, endpoint.password)
  }

  const resolver = createBrowserSessionResolver(endpoint.url, endpoint.password)
  const scope = await resolver.resolveOwnerScope!(sessionID, AbortSignal.timeout(3000))
  await current.connect(scope.directory)
}

function createChannel(endpoint: SidecarCredentials.Data, password: string) {
  const client = OpenCode.make({
    baseUrl: endpoint.url,
    headers: { authorization: `Basic ${Buffer.from(`opencode:${password}`).toString("base64")}` },
  })

  const rpc = client.rpc(BrowserRpc)
  const locations = new Map<string, { controller: AbortController; ready: Promise<void> }>()
  const requests = new Map<string, { directory: string; connectionID: string; signal: AbortSignal }>()

  const child = Object.assign(new EventEmitter(), {
    postMessage(message: BrowserIpcResult) {
      const request = requests.get(message.id)

      if (!request) return
      requests.delete(message.id)
      void rpc
        .result(
          { connectionID: request.connectionID, message: JSON.stringify(message) },
          {
            location: { directory: request.directory },
            signal: request.signal,
          },
        )
        .catch(() => undefined)
    },
  })

  let closed = false
  const stop = attachBrowserBridge(child, undefined, createBrowserSessionResolver(endpoint.url, password))

  return {
    endpoint,
    get closed() {
      return closed
    },
    async connect(directory: string) {
      const existing = locations.get(directory)

      if (existing) return existing.ready
      const connectionID = randomUUID()
      const controller = new AbortController()
      const ready = Promise.withResolvers<void>()
      locations.set(directory, { controller, ready: ready.promise })
      const timeout = setTimeout(() => controller.abort(), 10_000)

      const attached = rpc.events.on(
        "attached",
        (event) => {
          if (event.data.connectionID === connectionID) {
            clearTimeout(timeout)
            ready.resolve()
          }
        },
        { signal: controller.signal },
      )

      const request = rpc.events.on(
        "request",
        (event) => {
          if (event.data.connectionID !== connectionID) return
          const parsed = parseBrowserWireRequest(event.data.message)

          if (!parsed) {
            controller.abort(new Error("Invalid or oversized browser request."))

            return
          }

          if (parsed.type === "browser_request") {
            if (requests.has(parsed.id)) return
            requests.set(parsed.id, { directory, connectionID, signal: controller.signal })
          }

          child.emit("message", parsed)
        },
        { signal: controller.signal },
      )

      let heartbeat: ReturnType<typeof setInterval> | undefined
      void (async () => {
        try {
          for await (const event of client.event.subscribe({ signal: controller.signal })) {
            if (event.type !== "server.connected" || heartbeat) continue
            await rpc.attach({ connectionID }, { location: { directory }, signal: controller.signal })
            heartbeat = setInterval(() => {
              void rpc
                .attach({ connectionID }, { location: { directory }, signal: controller.signal })
                .catch(() => controller.abort())
            }, 10_000)
          }
        } catch (error) {
          ready.reject(error)
        } finally {
          clearTimeout(timeout)
          ready.reject(new Error("CM Browser connection closed"))
          clearInterval(heartbeat)
          controller.abort()
          void rpc
            .detach({ connectionID }, { location: { directory }, signal: AbortSignal.timeout(3000) })
            .catch(() => undefined)
          attached()
          request()

          if (locations.get(directory)?.controller === controller) locations.delete(directory)
          closed = true
          locations.forEach((location) => location.controller.abort())
          stop()
          requests.clear()
        }
      })()

      return ready.promise
    },
    close() {
      closed = true
      locations.forEach((location) => location.controller.abort())
      stop()
      requests.clear()
    },
  }
}
