import type { WebContents } from "electron"

// Metadata only. guardUploads remains the sole owner of debugger attachment and event listeners.
export function createFrameSessions(contents: WebContents) {
  const sessions = new Map<string, { readonly parent: string; ready: boolean }>()
  const contexts = new Map<string, { sessionID: string; id: number; uniqueId: string; frameId: string }>()
  let epoch = 0
  let active = true
  let overflow = false
  sessions.set("", { parent: "", ready: false })
  const invalidate = () => {
    epoch++
  }
  return {
    invalidate,
    overflowed: () => overflow,
    attached(id: string, parent: string) {
      invalidate()
      if (!active || !id || sessions.has(id) || !sessions.has(parent) || sessions.size >= 128) {
        // Unsupported metadata must not interfere with lifetime chooser interception.
        overflow ||= sessions.size >= 128
        active = false
        sessions.clear()
        contexts.clear()
        return
      }
      sessions.set(id, { parent, ready: false })
    },
    ready(id: string) {
      const session = sessions.get(id)
      if (active && session) session.ready = true
    },
    detached(id: string) {
      invalidate()
      const remove = new Set([id])
      // ponytail: at most 128 sessions; remove descendants without recursive traversal.
      for (let changed = true; changed; ) {
        changed = false
        for (const [key, session] of sessions) {
          if (!remove.has(key) && remove.has(session.parent)) {
            remove.add(key)
            changed = true
          }
        }
      }
      for (const key of remove) sessions.delete(key)
      for (const [key, context] of contexts) if (remove.has(context.sessionID)) contexts.delete(key)
    },
    message(method: string, params: Record<string, unknown> = {}, sessionID = "") {
      if (active && method === "Runtime.executionContextCreated") {
        const context = params.context as
          | { id?: number; uniqueId?: string; auxData?: { frameId?: string; isDefault?: boolean } }
          | undefined
        if (
          context?.auxData?.isDefault &&
          typeof context.id === "number" &&
          typeof context.uniqueId === "string" &&
          typeof context.auxData.frameId === "string"
        ) {
          if (contexts.size >= 256) {
            invalidate()
            overflow = true
            active = false
            contexts.clear()
            return
          }
          contexts.set(context.auxData.frameId, {
            sessionID,
            id: context.id,
            uniqueId: context.uniqueId,
            frameId: context.auxData.frameId,
          })
        }
      }
      if (method === "Runtime.executionContextsCleared" || method === "Runtime.executionContextDestroyed")
        for (const [key, context] of contexts)
          if (
            context.sessionID === sessionID &&
            (method === "Runtime.executionContextsCleared" || context.id === params.executionContextId)
          )
            contexts.delete(key)
      if (
        method === "DOM.documentUpdated" ||
        method === "Page.documentOpened" ||
        method === "Page.frameAttached" ||
        method === "Page.frameDetached" ||
        method === "Page.frameNavigated" ||
        method === "Page.frameStartedLoading" ||
        method === "Page.navigatedWithinDocument" ||
        method === "Runtime.executionContextDestroyed" ||
        method === "Runtime.executionContextsCleared"
      )
        invalidate()
    },
    close() {
      invalidate()
      active = false
      sessions.clear()
      contexts.clear()
    },
    list() {
      return [...contexts.values()].filter((context) => sessions.get(context.sessionID)?.ready)
    },
    context(frameId: string) {
      const context = contexts.get(frameId)
      if (!active || !context || !sessions.get(context.sessionID)?.ready) throw new Error("Unmapped browser frame")
      return {
        sessionID: context.sessionID,
        check: () => {
          if (!active || contexts.get(frameId) !== context) throw new Error("Browser frame context changed")
        },
      }
    },
    capture(id = "") {
      const session = sessions.get(id)
      const generation = epoch
      if (!active || !session?.ready) throw new Error("Browser frame session unavailable")
      const check = () => {
        if (!active || contents.isDestroyed() || epoch !== generation || sessions.get(id) !== session || !session.ready)
          throw new Error("Browser frame session changed")
      }
      return {
        sessionID: id,
        check,
        async send(method: string, params: Record<string, unknown> = {}) {
          check()
          const result: unknown = await contents.debugger.sendCommand(method, params, id || undefined)
          check()
          return result
        },
        async tree() {
          check()
          const result: unknown = await contents.debugger.sendCommand("Page.getFrameTree", {}, id || undefined)
          check()
          return result
        },
      }
    },
  }
}
