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
const PROJECT_ACCESS_TEXT_PATTERN = /access denied|unauthorized|forbidden|do not have access|don't have access|permission required/i

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
  const error = new Error(`${reason}. Ask a CookieMonster project owner to grant access or configure O1_CODE_TARGET_URL.`) as Error & {
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
// frames (telemetry, silent-SSO renewer iframes on IdP origins) are excluded so their URLs can't
// false-positive the login classifier.
export function isWppFrameUrl(url: string): boolean {
  try {
    const host = new URL(String(url || "")).hostname
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
