import type { WppAuthState, WppAuthStatus } from "@opencode-ai/app/wpp-auth"

export function createWppAuthState(probe: () => Promise<WppAuthStatus>) {
  let state: WppAuthState = { status: "unknown", checkedAt: null, loginVisible: false }
  let revision = 0
  let pending: Promise<WppAuthState> | undefined
  let invalidated = false
  let refreshed = false
  const listeners = new Set<(state: WppAuthState) => void>()
  const publish = (next: WppAuthState) => {
    state = next
    listeners.forEach((listener) => listener({ ...state }))
  }
  const check = (cookieRetry = false): Promise<WppAuthState> => {
    if (pending) return pending
    refreshed = false
    const current = ++revision
    if (state.status !== "signed-in" && state.status !== "signed-out") publish({ ...state, status: "checking" })
    pending = Promise.resolve()
      .then(probe)
      .catch(() => "unknown" as const)
      .then((status) => {
        if (current === revision)
          publish({ ...state, status: refreshed && status !== "signed-in" ? "unknown" : status, checkedAt: Date.now() })
        return { ...state }
      })
      .finally(() => {
        pending = undefined
        if (invalidated) {
          invalidated = false
          void check()
          return
        }
        // Successful probes may set cookies themselves and already prove sign-in.
        // ponytail: one cookie retry; add response-cookie provenance if inconclusive probes need more.
        if (refreshed && state.status !== "signed-in" && !cookieRetry) void check(true)
      })
    return pending
  }
  return {
    check: () => check(),
    get: () => ({ ...state }),
    subscribe(listener: (state: WppAuthState) => void) {
      listeners.add(listener)
      listener({ ...state })
      return () => {
        listeners.delete(listener)
      }
    },
    observe(status: "signed-in" | "signed-out") {
      revision++
      invalidated = false
      refreshed = false
      publish({ ...state, status, checkedAt: Date.now() })
    },
    refresh() {
      if (pending) {
        refreshed = true
        return
      }
      void check()
    },
    invalidate() {
      revision++
      publish({ ...state, status: "unknown" })
      if (pending) {
        invalidated = true
        return
      }
      void check()
    },
    setLoginVisible(loginVisible: boolean) {
      if (state.loginVisible === loginVisible) return
      publish({ ...state, loginVisible })
    },
  }
}

export async function readWppAuthResponse(response: Response): Promise<WppAuthStatus> {
  function hasWppIdentity(value: unknown) {
    if (!value || typeof value !== "object" || Array.isArray(value)) return false
    return (
      ("id" in value && typeof value.id === "string" && !!value.id.trim()) ||
      ("email" in value && typeof value.email === "string" && !!value.email.trim())
    )
  }

  if (response.status === 401) return "signed-out"
  if (response.status !== 200 || !response.headers.get("content-type")?.includes("application/json")) return "unknown"
  const value: unknown = await response.json().catch(() => undefined)
  if (hasWppIdentity(value)) return "signed-in"
  if (!value || typeof value !== "object") return "unknown"
  if ("user" in value && hasWppIdentity(value.user)) return "signed-in"
  if ("data" in value && hasWppIdentity(value.data)) return "signed-in"
  return "unknown"
}

// Only the status crosses back to main; the OIDC token stays in its WPP page.
export function wppAuthProbeScript() {
  return `(${readWppPageAuth.toString()})(${readWppAuthResponse.toString()})`
}

async function readWppPageAuth(readResponse: typeof readWppAuthResponse) {
  const users = Object.keys(localStorage)
    .filter((key) => key.startsWith("oidc.user:https://authenticate.os.wpp.com/"))
    .flatMap((key) => {
      try {
        const value: unknown = JSON.parse(localStorage.getItem(key) ?? "null")
        if (
          value &&
          typeof value === "object" &&
          "access_token" in value &&
          typeof value.access_token === "string" &&
          value.access_token.trim() &&
          "expires_at" in value &&
          typeof value.expires_at === "number" &&
          value.expires_at > Date.now() / 1000
        )
          return [value.access_token]
        return []
      } catch {
        return []
      }
    })
  if (!users[0]) return "unknown"
  return readResponse(
    await fetch("/api/users/me", {
      credentials: "include",
      cache: "no-store",
      redirect: "manual",
      headers: { Authorization: `Bearer ${users[0]}` },
      signal: AbortSignal.timeout(10_000),
    }),
  )
}
