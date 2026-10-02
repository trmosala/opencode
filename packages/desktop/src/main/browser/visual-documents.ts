import type { BrowserRegistration } from "./registry"
import { visualGuardScript } from "./visual"

// Native default-context identities enumerate documents; reads run in separate isolated worlds.
export async function visualDocumentSignature(tab: BrowserRegistration, check: () => void) {
  check()
  const sessions = tab.frameSessions
  if (!sessions || sessions.overflowed()) throw new Error("Visual document tracking unavailable")
  const documents = sessions.list().sort((a, b) => a.frameId.localeCompare(b.frameId))
  if (!documents.length || documents.length > 32) throw new Error("Visual document tracking limit exceeded")
  const signatures = []
  for (const document of documents) {
    check()
    const identity = sessions.context(document.frameId)
    const native = sessions.capture(document.sessionID)
    const world = (await native.send("Page.createIsolatedWorld", {
      frameId: document.frameId,
      worldName: "cm-browser-visual-documents",
    })) as { executionContextId?: number }
    check()
    identity.check()
    if (!Number.isInteger(world.executionContextId)) throw new Error("Visual document world unavailable")
    const snapshot = (await native.send("Runtime.evaluate", {
      contextId: world.executionContextId,
      expression: visualGuardScript,
      returnByValue: true,
      awaitPromise: true,
      timeout: 1000,
    })) as {
      result?: { value?: { documentToken?: unknown; layoutToken?: unknown; animated?: unknown } }
      exceptionDetails?: unknown
    }
    check()
    identity.check()
    if (
      snapshot.exceptionDetails ||
      !snapshot.result?.value ||
      typeof snapshot.result.value.documentToken !== "string" ||
      typeof snapshot.result.value.layoutToken !== "string" ||
      typeof snapshot.result.value.animated !== "boolean"
    )
      throw new Error("Visual document layout unavailable")
    signatures.push([document.frameId, document.sessionID, document.uniqueId, snapshot.result.value])
  }
  check()
  const current = sessions.list().sort((a, b) => a.frameId.localeCompare(b.frameId))
  if (
    current.length !== documents.length ||
    current.some((document, index) => document.uniqueId !== documents[index].uniqueId)
  )
    throw new Error("Visual document set changed")
  return JSON.stringify(signatures)
}
