type DestroyableWindow = {
  isDestroyed: () => boolean
  destroy: () => void
}

export type StartupAuthState = {
  url?: string | null
  text?: string | null
}

const LOGIN_URL_PATTERN = /login|signin|sign-in|sso|oauth|authorize|auth|identity|idp/i
const LOGIN_TEXT_PATTERN = /sign in|log in|login|session expired|authenticate|single sign-on|access denied|unauthorized/i

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

export async function cleanupWindowOnFailure<T>(window: DestroyableWindow, task: () => Promise<T>) {
  try {
    return await task()
  } catch (error) {
    if (!window.isDestroyed()) window.destroy()
    throw error
  }
}
