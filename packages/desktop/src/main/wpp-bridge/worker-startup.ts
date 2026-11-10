import type { EventEmitter } from "node:events"
import { projectPageStateExpression, navigationWait } from "./assistant-panel"
import { agentRosterStateExpression } from "./agent-chat"

export async function loadWorkerProject(
  contents: EventEmitter & {
    loadURL(url: string): Promise<void>
    getURL(): string
    executeJavaScript?(code: string, userGesture?: boolean): Promise<unknown>
    debugger: EventEmitter
    mainFrame: { framesInSubtree: { url: string; executeJavaScript(code: string): Promise<unknown> }[] }
  },
  url: string,
  timeoutMs: number,
  signal?: AbortSignal,
  chatMode: "assistant" | "agent" = "assistant",
) {
  const failure = (type: string, statusCode: number) => Object.assign(new Error(type), { type, statusCode })
  if (signal?.aborted) throw failure("o1_code_client_aborted", 499)
  const deadline = Date.now() + timeoutMs
  const pending = new Set<string>()
  let lastActivity = Date.now()
  let pageSignature = ""
  let pageReady = false
  const network = (_event: unknown, method: string, params: unknown, sessionId = "") => {
    if (!params || typeof params !== "object") return
    if (method === "Target.detachedFromTarget") {
      const detached = Reflect.get(params, "sessionId")
      if (typeof detached !== "string") return
      pending.forEach((key) => {
        if (key.startsWith(`${detached}:`)) pending.delete(key)
      })
      lastActivity = Date.now()
      return
    }
    const requestId = Reflect.get(params, "requestId")
    if (typeof requestId !== "string") return
    const key = `${sessionId}:${requestId}`
    if (method === "Network.requestWillBeSent") {
      const request = Reflect.get(params, "request")
      // Blob worker bootstrap scripts do not emit a matching network completion.
      if (
        Reflect.get(params, "type") === "Script" &&
        request &&
        typeof request === "object" &&
        URL.parse(Reflect.get(request, "url") ?? "")?.protocol === "blob:"
      )
        return
      // Background streams (including LaunchDarkly) outlive page loading; beacons don't gate the UI.
      if (["EventSource", "WebSocket", "Ping"].includes(Reflect.get(params, "type"))) return
      const isDocument = Reflect.get(params, "type") === "Document"
      // Once the project UI reports ready, only Document navigations keep us waiting — background
      // XHR/Fetch otherwise starve the 5s quiet gate for minutes.
      if (pageReady && !isDocument) return
      // A cross-process iframe document can start in the parent target and finish in its child target.
      pending.add(isDocument ? `document:${requestId}` : key)
      lastActivity = Date.now()
    }
    if (method === "Network.responseReceived") {
      const response = Reflect.get(params, "response")
      // Fetch can also open an SSE stream, with no loadingFinished until the connection closes.
      if (response && typeof response === "object" && Reflect.get(response, "mimeType") === "text/event-stream") {
        if (pending.delete(key)) lastActivity = Date.now()
      }
    }
    if (method === "Network.loadingFinished" || method === "Network.loadingFailed") {
      const request = pending.delete(key)
      const document = pending.delete(`document:${requestId}`)
      if (request || document) lastActivity = Date.now()
    }
  }
  const observe = <T>(operation: () => Promise<T>) =>
    navigationWait(operation, deadline - Date.now(), signal, () => failure("o1_code_project_load_timeout", 502))
  contents.debugger.on("message", network)
  try {
    await observe(() => contents.loadURL(url))
    lastActivity = Date.now()
    while (true) {
      // Let the caller classify sign-in redirects before requiring the project UI.
      if (URL.parse(contents.getURL())?.origin !== URL.parse(url)?.origin) return
      const frames = contents.mainFrame.framesInSubtree.filter(
        (frame) => frame.url === contents.getURL() || isWppFrameUrl(frame.url),
      )
      // The project shell (and assistant popover button) live on the top-level page. framesInSubtree
      // only has child iframes, so without this the host control was never observed and load waited
      // on agent-builder spinner noise for minutes.
      const top =
        typeof contents.executeJavaScript === "function"
          ? await observe(() =>
              contents.executeJavaScript!(projectPageStateExpression(chatMode === "assistant")),
            )
          : undefined
      const childPages = await observe(() =>
        Promise.all(
          frames.map((frame) =>
            frame.executeJavaScript(
              projectPageStateExpression(chatMode === "assistant" && frame.url === contents.getURL()),
            ),
          ),
        ),
      )
      const pages = top === undefined ? childPages : [top, ...childPages]
      const builders = frames.filter(
        (frame) => URL.parse(frame.url)?.origin === "https://open-web-agent-builder-cs.wpp.ai",
      )
      if (chatMode === "agent")
        pages.push(
          builders.length === 1
            ? await observe(() => builders[0].executeJavaScript(agentRosterStateExpression()))
            : undefined,
        )
      const signature = JSON.stringify(
        pages.map((page) => (page && typeof page === "object" ? Reflect.get(page, "signature") : null)),
      )
      // Assistant mode: host control-ready is enough; child agent-builder iframes often stay "busy"
      // with analytics spinners and must not gate the popover click path.
      const ready =
        chatMode === "assistant" && top && typeof top === "object"
          ? Reflect.get(top, "ready") === true
          : pages.length > 0 &&
            pages.every((page) => page && typeof page === "object" && Reflect.get(page, "ready") === true)
      if (!ready || ready !== pageReady || typeof signature !== "string" || signature !== pageSignature) {
        pageSignature = typeof signature === "string" ? signature : ""
        pageReady = ready
        lastActivity = Date.now()
      }
      // shortcut: five quiet seconds approximate lazy-load completion; use a WPP completion signal when exposed.
      if (ready && pending.size === 0 && Date.now() - lastActivity >= 5000) return
      await observe(() => new Promise<void>((resolve) => setTimeout(resolve, 250)))
    }
  } finally {
    contents.debugger.removeListener("message", network)
  }
}

type DestroyableWindow = {
  isDestroyed: () => boolean
  destroy: () => void
}

export type StartupAuthState = {
  url?: string | null
  text?: string | null
}

const LOGIN_URL_PATTERN = /login|signin|sign-in|sso|oauth|authorize|auth|identity|idp/i
const LOGIN_TEXT_PATTERN = /sign in|log in|login|session expired|authenticate|single sign-on/i
const PROJECT_URL_PATTERN = /\/orchestration\/project\//i
const PROJECT_ACCESS_TEXT_PATTERN =
  /access denied|unauthorized|forbidden|do not have access|don't have access|permission required/i

export function wppAuthRequiredError(reason: string, diagnostics: StartupAuthState = {}) {
  const error = new Error(`WPP login required: ${reason}.`) as Error & {
    statusCode: number
    type: string
    diagnostics: unknown
  }
  error.statusCode = 401
  error.type = "wpp_auth_required"
  error.diagnostics = {
    phase: "auth_required",
    assistantUi: { error: reason },
    target: { tabUrl: diagnostics.url || null },
  }
  return error
}

export function classifyWppAuthState(state: StartupAuthState) {
  const url = String(state.url || "")
  if (LOGIN_URL_PATTERN.test(url)) return "WPP page is on a login or identity-provider URL"

  const text = String(state.text || "").slice(0, 4000)
  if (LOGIN_TEXT_PATTERN.test(text)) return "WPP page is asking for sign-in"

  return null
}

export function classifyWppProjectAccessState(state: StartupAuthState) {
  const url = String(state.url || "")
  const text = String(state.text || "").slice(0, 4000)
  if (!PROJECT_URL_PATTERN.test(url) || !PROJECT_ACCESS_TEXT_PATTERN.test(text)) return null
  return "The signed-in WPP account does not have access to the configured CookieMonster project"
}

export function wppProjectAccessError(reason: string, diagnostics: StartupAuthState = {}) {
  const error = new Error(
    `${reason}. Ask a CookieMonster project owner to grant access or configure O1_CODE_TARGET_URL.`,
  ) as Error & {
    statusCode: number
    type: string
    diagnostics: unknown
  }
  error.statusCode = 403
  error.type = "wpp_project_access_denied"
  error.diagnostics = {
    phase: "project_authorization",
    assistantUi: { error: reason },
    target: { tabUrl: diagnostics.url || null },
  }
  return error
}

// Frames the WPP session actually lives in (workspace shell + assistant iframes). Third-party
// frames and Keycloak's hidden login-status iframe are excluded so their URLs can't false-positive
// the login classifier.
export function isWppFrameUrl(url: string): boolean {
  try {
    const parsed = new URL(url)
    const host = parsed.hostname
    if (host === "authenticate.os.wpp.com" && parsed.pathname.endsWith("/login-status-iframe.html")) return false
    return host === "wpp.com" || host === "wpp.ai" || host.endsWith(".wpp.com") || host.endsWith(".wpp.ai")
  } catch {
    return false
  }
}

// Classify a same-frame re-fetch of a WPP frame's own document (the soft-logout probe). The frame's
// location.href is already post-redirect, so a live session answers 2xx; 401 or any redirect
// (including an opaque one to a cross-origin IdP) means the SSO session expired out from under a
// long-lived worker whose cached SPA shell still renders normally.
export function classifyWppSessionProbe(probe: unknown): string | null {
  if (!probe || typeof probe !== "object") return null
  const { status: rawStatus, type } = probe as { status?: unknown; type?: unknown }
  const status = Number(rawStatus) || 0
  if (status === 401) return `WPP session re-fetch was rejected with HTTP ${status}`
  // A 403 can mean valid SSO without access to the configured private project. Do not turn that
  // into a futile login loop; startup's visible-page classifier reports the typed project error.
  if (status === 403) return null
  if (type === "opaqueredirect" || (status >= 300 && status < 400)) {
    return "WPP session re-fetch was redirected to sign-in (SSO session expired)"
  }
  return null
}

export async function cleanupWindowOnFailure<T>(window: DestroyableWindow, task: () => Promise<T>) {
  try {
    return await task()
  } catch (error) {
    if (!window.isDestroyed()) window.destroy()
    throw error
  }
}
