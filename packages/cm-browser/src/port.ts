import { randomUUID } from "node:crypto"
import {
  OPERATION_TIMEOUT_MS,
  failure,
  parseBrowserIpcResult,
  type BrowserIpcRequest,
  type BrowserState,
  type Request,
  type Response,
} from "./protocol"

type ParentPort = {
  postMessage(message: BrowserIpcRequest): void
  on(event: "message", listener: (event: { data: unknown }) => void): void
}

export type BrowserPort = {
  readonly send: (sessionID: string, request: Request) => Promise<Response<BrowserState>>
}

export function ipcPort(parent = (process as NodeJS.Process & { parentPort?: ParentPort }).parentPort): BrowserPort {
  const pending = new Map<string, (response: Response<BrowserState>) => void>()
  parent?.on("message", (event) => {
    const result = parseBrowserIpcResult(event.data)
    if (!result) return
    pending.get(result.id)?.(result.response)
    pending.delete(result.id)
  })

  return {
    send(sessionID, request) {
      if (!parent) return Promise.resolve(failure("unavailable", "CookieMonster parent IPC is unavailable."))
      const id = randomUUID()
      return new Promise((resolve) => {
        const timeout = setTimeout(
          () => {
            pending.delete(id)
            resolve(failure("timeout", "Browser operation timed out."))
          },
          (request.op === "search_history" || request.op === "open_history" ? 60_000 : OPERATION_TIMEOUT_MS) + 1_000,
        )
        pending.set(id, (response) => {
          clearTimeout(timeout)
          resolve(response)
        })
        parent.postMessage({ type: "browser_request", id, sessionID, request })
      })
    },
  }
}
