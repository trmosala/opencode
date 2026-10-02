import { realpath } from "node:fs/promises"
import { isAbsolute } from "node:path"
import { browserIdentity } from "@cookiemonster/cm-browser/protocol"

export type BrowserOwnerScope = {
  projectID: string
  directory: string
  workspaceID?: string
  serverURL: string
  generation: number
}
export type BrowserSession = {
  id: string
  parentID?: string
  projectID: string
  workspaceID?: string
  directory: string
}
export type BrowserSessionResolver = ((
  sessionID: string,
  scope: BrowserOwnerScope,
  signal: AbortSignal,
) => Promise<BrowserSession>) & {
  resolveOwnerScope?: BrowserOwnerScopeSource
}

export type BrowserOwnerScopeResolver = (sessionID: string, signal: AbortSignal) => Promise<BrowserOwnerScope>
type BrowserOwnerScopeSource = (
  sessionID: string,
  signal: AbortSignal,
) => Promise<Omit<BrowserOwnerScope, "generation">>

let ownerScopeResolver: { generation: number; resolve: BrowserOwnerScopeResolver } | undefined
let ownerScopeGeneration = 0
const ownerScopeWaiters = new Set<() => void>()

export function setBrowserOwnerScopeResolver(resolve: BrowserOwnerScopeSource) {
  const current = { generation: ++ownerScopeGeneration, resolve: undefined as unknown as BrowserOwnerScopeResolver }
  current.resolve = async (sessionID, signal) => ({
    ...(await resolve(sessionID, signal)),
    generation: current.generation,
  })
  ownerScopeResolver = current
  ownerScopeWaiters.forEach((wake) => wake())
  return () => {
    if (ownerScopeResolver !== current) return
    ownerScopeResolver = undefined
    ownerScopeWaiters.forEach((wake) => wake())
  }
}

export async function resolveBrowserOwnerScope(sessionID: string, signal: AbortSignal) {
  while (!ownerScopeResolver) {
    signal.throwIfAborted()
    await new Promise<void>((resolve, reject) => {
      const wake = () => {
        ownerScopeWaiters.delete(wake)
        signal.removeEventListener("abort", abort)
        resolve()
      }
      const abort = () => {
        ownerScopeWaiters.delete(wake)
        reject(signal.reason ?? new Error("Owner scope lookup cancelled"))
      }
      ownerScopeWaiters.add(wake)
      signal.addEventListener("abort", abort, { once: true })
      if (ownerScopeResolver) wake()
    })
  }
  const resolver = ownerScopeResolver
  const scope = await resolver.resolve(sessionID, signal)
  signal.throwIfAborted()
  if (resolver !== ownerScopeResolver) throw new Error("Sidecar owner changed")
  return scope
}

export function browserOwnerScopeCurrent(generation: number) {
  return ownerScopeResolver?.generation === generation
}

export function parseBrowserSession(value: unknown, sessionID: string): BrowserSession {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Invalid session")
  const input = value as Record<string, unknown>
  if (
    !browserIdentity(sessionID) ||
    input.id !== sessionID ||
    !browserIdentity(input.projectID) ||
    (input.parentID !== undefined && !browserIdentity(input.parentID))
  )
    throw new Error("Invalid session identity")
  const location = input.location
  if (!location || typeof location !== "object" || Array.isArray(location)) throw new Error("Invalid session location")
  const directory = (location as Record<string, unknown>).directory
  const workspaceID = (location as Record<string, unknown>).workspaceID
  if (
    typeof directory !== "string" ||
    !directory ||
    directory.length > 32767 ||
    directory.includes("\0") ||
    !isAbsolute(directory) ||
    (workspaceID !== undefined && !browserIdentity(workspaceID))
  )
    throw new Error("Invalid session location")
  return {
    id: sessionID,
    projectID: input.projectID,
    directory,
    ...(typeof input.parentID === "string" ? { parentID: input.parentID } : {}),
    ...(typeof workspaceID === "string" ? { workspaceID } : {}),
  }
}

// The URL/password come only from spawnLocalServer, never IPC or renderer routing hints.
export function createBrowserSessionResolver(serverURL: string, password: string): BrowserSessionResolver {
  const server = new URL(serverURL)
  if (
    server.protocol !== "http:" ||
    !["127.0.0.1", "localhost", "[::1]"].includes(server.hostname) ||
    server.username ||
    server.password ||
    server.pathname !== "/" ||
    server.search ||
    server.hash ||
    !password
  )
    throw new Error("Invalid local sidecar server")
  const authorization = `Basic ${Buffer.from(`opencode:${password}`).toString("base64")}`
  const requestSession = async (
    sessionID: string,
    scope: BrowserOwnerScope | Omit<BrowserOwnerScope, "generation"> | undefined,
    signal: AbortSignal,
  ) => {
    signal.throwIfAborted()
    if (
      !browserIdentity(sessionID) ||
      (scope && new URL(scope.serverURL).href !== server.href) ||
      (scope &&
        (!isAbsolute(scope.directory) ||
          scope.directory.length > 32767 ||
          (scope.workspaceID !== undefined && !browserIdentity(scope.workspaceID))))
    )
      throw new Error("Browser owner does not belong to this sidecar")
    const bounded = AbortSignal.any([signal, AbortSignal.timeout(3000)])
    const url = new URL(`/api/session/${encodeURIComponent(sessionID)}`, server)
    if (scope) {
      url.searchParams.set("directory", scope.directory)
      if (scope.workspaceID !== undefined) url.searchParams.set("workspace", scope.workspaceID)
    }
    const response = await fetch(url, {
      headers: { authorization, accept: "application/json" },
      signal: bounded,
      redirect: "error",
    })
    if (!response.ok || !response.body) {
      await response.body?.cancel()
      throw new Error("Session lookup failed")
    }
    const reader = response.body.getReader()
    const chunks: Uint8Array[] = []
    let size = 0
    try {
      while (true) {
        bounded.throwIfAborted()
        const chunk = await reader.read()
        if (chunk.done) break
        size += chunk.value.byteLength
        if (size > 64 * 1024) throw new Error("Session response too large")
        chunks.push(chunk.value)
      }
    } finally {
      await reader.cancel().catch(() => {})
      reader.releaseLock()
    }
    const envelope: unknown = JSON.parse(Buffer.concat(chunks).toString("utf8"))
    if (!envelope || typeof envelope !== "object" || Array.isArray(envelope) || !("data" in envelope))
      throw new Error("Invalid session response")
    const session = parseBrowserSession(envelope.data, sessionID)
    const directory = await realpath(scope?.directory ?? session.directory)
    const actual = await realpath(session.directory)
    bounded.throwIfAborted()
    if (
      directory !== actual ||
      (scope && (session.workspaceID !== scope.workspaceID || session.projectID !== scope.projectID))
    )
      throw new Error("Session scope mismatch")
    return { ...session, directory: actual }
  }
  const resolveOwnerScope = async (
    sessionID: string,
    signal: AbortSignal,
  ): Promise<Omit<BrowserOwnerScope, "generation">> => {
    const session = await requestSession(sessionID, undefined, signal)
    return {
      projectID: session.projectID,
      directory: session.directory,
      ...(session.workspaceID ? { workspaceID: session.workspaceID } : {}),
      serverURL: server.href,
    }
  }
  const resolver: BrowserSessionResolver = async (sessionID, scope, signal) => {
    const session = await requestSession(sessionID, scope, signal)
    if (session.directory !== (await realpath(scope.directory))) throw new Error("Session scope mismatch")
    return session
  }
  resolver.resolveOwnerScope = resolveOwnerScope
  return resolver
}
