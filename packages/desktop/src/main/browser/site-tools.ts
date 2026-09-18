import { createHash, randomUUID } from "node:crypto"
import {
  MAX_SITE_TOOLS,
  MAX_SITE_TOOL_RESULT_BYTES,
  parseSiteToolArguments,
  type SiteTool,
} from "@cookiemonster/cm-browser/protocol"

type DebuggerMessage = (event: unknown, method: string, params: unknown) => void
type DebuggerDetach = () => void

type SiteToolContents = {
  debugger: {
    isAttached(): boolean
    attach(version?: string): void
    sendCommand(method: string, params?: Record<string, unknown>): Promise<unknown>
    on?: {
      (event: "message", listener: DebuggerMessage): void
      (event: "detach", listener: DebuggerDetach): void
    }
  }
  isDestroyed(): boolean
  isLoadingMainFrame(): boolean
  getURL(): string
}

type NativeTool = SiteTool & { readonly frameID: string }
type Pending = {
  readonly resolve: (value: Record<string, unknown>) => void
  readonly reject: (error: unknown) => void
}
type Session = {
  enabled: boolean
  listening: boolean
  revision: number
  mainFrameID?: string
  origin?: string
  tools: Map<string, NativeTool>
  pending: Map<string, Pending>
}

export type PreparedSiteTool = {
  readonly ref: string
  readonly name: string
  readonly frameID: string
  readonly origin: string
  readonly revision: number
  readonly argumentHash: string
  readonly public: SiteTool
}

const sessions = new WeakMap<object, Session>()
const MAX_SITE_TOOL_INVENTORY_BYTES = 48 * 1024

function text(value: unknown, limit: number) {
  if (typeof value !== "string") return ""
  return value.replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, "").slice(0, limit)
}

function schema(value: unknown): string | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return
  try {
    const serialized = JSON.stringify(value)
    return Buffer.byteLength(serialized) <= 4_096 ? serialized : undefined
  } catch {
    return
  }
}

function nativeTool(value: unknown): NativeTool | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return
  const input = value as Record<string, unknown>
  if (
    typeof input.name !== "string" ||
    !/^[A-Za-z0-9_.-]{1,128}$/.test(input.name) ||
    typeof input.description !== "string" ||
    typeof input.frameId !== "string" ||
    !input.frameId ||
    input.frameId.length > 128
  )
    return
  const annotations =
    input.annotations && typeof input.annotations === "object" && !Array.isArray(input.annotations)
      ? (input.annotations as Record<string, unknown>)
      : undefined
  const title = text(input.title, 256)
  const inputSchema = schema(input.inputSchema)
  return {
    ref: randomUUID(),
    name: input.name,
    ...(title ? { title } : {}),
    description: text(input.description, 1_024),
    ...(inputSchema ? { inputSchema } : {}),
    ...(typeof annotations?.readOnly === "boolean" ? { readOnly: annotations.readOnly } : {}),
    ...(typeof annotations?.consequential === "boolean" ? { consequential: annotations.consequential } : {}),
    ...(typeof annotations?.untrustedContent === "boolean" ? { untrustedContent: annotations.untrustedContent } : {}),
    frameID: input.frameId,
  }
}

function removedTool(value: unknown): { name: string; frameID: string } | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return
  const input = value as Record<string, unknown>
  if (
    typeof input.name !== "string" ||
    !/^[A-Za-z0-9_.-]{1,128}$/.test(input.name) ||
    typeof input.frameId !== "string" ||
    !input.frameId ||
    input.frameId.length > 128
  )
    return
  return { name: input.name, frameID: input.frameId }
}

function key(frameID: string, name: string) {
  return `${frameID}\u0000${name}`
}

function message(session: Session, method: string, value: unknown) {
  const params = value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {}
  if (method === "WebMCP.toolsAdded" && Array.isArray(params.tools)) {
    params.tools.forEach((value) => {
      const tool = nativeTool(value)
      if (!tool) return
      session.tools.set(key(tool.frameID, tool.name), tool)
      session.revision++
    })
    return
  }
  if (method === "WebMCP.toolsRemoved" && Array.isArray(params.tools)) {
    params.tools.forEach((value) => {
      const tool = removedTool(value)
      if (!tool) return
      if (session.tools.delete(key(tool.frameID, tool.name))) session.revision++
    })
    return
  }
  if (method !== "WebMCP.toolResponded" || typeof params.invocationId !== "string") return
  const pending = session.pending.get(params.invocationId)
  if (!pending) return
  session.pending.delete(params.invocationId)
  pending.resolve(params)
}

async function enabled(contents: SiteToolContents, check: () => void) {
  check()
  if (contents.isDestroyed() || contents.isLoadingMainFrame()) throw new Error("Browser page is unavailable")
  const existing = sessions.get(contents)
  if (existing?.enabled) return existing
  if (!contents.debugger.on) throw new Error("WebMCP is unavailable in this browser runtime")
  if (!contents.debugger.isAttached()) contents.debugger.attach("1.3")
  const session: Session = existing ?? {
    enabled: false,
    listening: false,
    revision: 0,
    tools: new Map(),
    pending: new Map(),
  }
  sessions.set(contents, session)
  if (!session.listening) {
    contents.debugger.on("message", (_event, method, params) => message(session, method, params))
    contents.debugger.on("detach", () => {
      session.enabled = false
      session.revision++
      session.tools.clear()
      session.pending.forEach((pending) => pending.reject(new Error("WebMCP debugger detached")))
      session.pending.clear()
    })
    session.listening = true
  }
  await contents.debugger.sendCommand("WebMCP.enable")
  session.enabled = true
  check()
  return session
}

async function refresh(contents: SiteToolContents, check: () => void) {
  const session = await enabled(contents, check)
  const result = (await contents.debugger.sendCommand("Page.getFrameTree")) as {
    frameTree?: { frame?: { id?: unknown; url?: unknown; securityOrigin?: unknown } }
  }
  check()
  const frame = result.frameTree?.frame
  if (
    typeof frame?.id !== "string" ||
    !frame.id ||
    typeof frame.url !== "string" ||
    frame.url !== contents.getURL() ||
    typeof frame.securityOrigin !== "string" ||
    new URL(frame.url).origin !== frame.securityOrigin
  )
    throw new Error("WebMCP document identity is unavailable")
  session.mainFrameID = frame.id
  session.origin = frame.securityOrigin
  return session
}

export async function discoverSiteTools(contents: SiteToolContents, check: () => void) {
  const session = await refresh(contents, check)
  const all = [...session.tools.values()].filter((tool) => tool.frameID === session.mainFrameID)
  const tools = all.slice(0, MAX_SITE_TOOLS).reduce<SiteTool[]>((result, { frameID: _frameID, ...tool }) => {
    if (Buffer.byteLength(JSON.stringify([...result, tool])) > MAX_SITE_TOOL_INVENTORY_BYTES) return result
    result.push(tool)
    return result
  }, [])
  return {
    origin: session.origin!,
    revision: session.revision,
    tools,
    truncated: all.length > tools.length,
  }
}

export async function prepareSiteTool(
  contents: SiteToolContents,
  ref: string,
  argumentsJSON: string,
  check: () => void,
): Promise<PreparedSiteTool> {
  if (!parseSiteToolArguments(argumentsJSON)) throw new Error("Invalid site tool arguments")
  const session = await refresh(contents, check)
  const tool = [...session.tools.values()].find((tool) => tool.frameID === session.mainFrameID && tool.ref === ref)
  if (!tool) throw new Error("Site tool changed")
  const { frameID, ...publicTool } = tool
  return {
    ref,
    name: tool.name,
    frameID,
    origin: session.origin!,
    revision: session.revision,
    argumentHash: createHash("sha256").update(argumentsJSON).digest("hex"),
    public: publicTool,
  }
}

export async function invokeSiteTool(
  contents: SiteToolContents,
  prepared: PreparedSiteTool,
  argumentsJSON: string,
  check: () => void,
  signal: AbortSignal,
) {
  const input = parseSiteToolArguments(argumentsJSON)
  if (!input || createHash("sha256").update(argumentsJSON).digest("hex") !== prepared.argumentHash)
    throw new Error("Site tool arguments changed")
  const session = await refresh(contents, check)
  const current = session.tools.get(key(prepared.frameID, prepared.name))
  if (
    !current ||
    current.ref !== prepared.ref ||
    session.revision !== prepared.revision ||
    session.mainFrameID !== prepared.frameID ||
    session.origin !== prepared.origin
  )
    throw new Error("Site tool changed")
  signal.throwIfAborted()
  const response = (await contents.debugger.sendCommand("WebMCP.invokeTool", {
    frameId: prepared.frameID,
    toolName: prepared.name,
    input,
  })) as { invocationId?: unknown }
  if (typeof response.invocationId !== "string" || !response.invocationId)
    throw new Error("WebMCP invocation was not admitted")
  const invocationID = response.invocationId
  const settled = new Promise<Record<string, unknown>>((resolve, reject) =>
    session.pending.set(invocationID, { resolve, reject }),
  )
  const abort = () => {
    session.pending.delete(invocationID)
    void contents.debugger.sendCommand("WebMCP.cancelInvocation", { invocationId: invocationID }).catch(() => {})
  }
  signal.addEventListener("abort", abort, { once: true })
  try {
    if (signal.aborted) {
      abort()
      signal.throwIfAborted()
    }
    const result = await Promise.race([
      settled,
      new Promise<never>((_resolve, reject) =>
        signal.addEventListener(
          "abort",
          () => reject(signal.reason ?? new DOMException("Browser operation cancelled", "AbortError")),
          { once: true },
        ),
      ),
    ])
    check()
    // Chromium 152 reports Success; the current CDP draft renamed that terminal state to Completed.
    if (result.status !== "Success" && result.status !== "Completed")
      throw new Error("Site tool execution failed or was cancelled")
    const content = typeof result.output === "string" ? result.output : JSON.stringify(result.output ?? null)
    if (Buffer.byteLength(content) > MAX_SITE_TOOL_RESULT_BYTES)
      throw new Error("Site tool result exceeds the size limit")
    return { name: prepared.name, origin: prepared.origin, content }
  } finally {
    signal.removeEventListener("abort", abort)
    session.pending.delete(invocationID)
  }
}
