import type { WppAuthState, WppAuthStatus } from "@opencode-ai/app/wpp-auth"

export function createWppAuthState(probe: () => Promise<WppAuthStatus>) {
  let state: WppAuthState = { status: "unknown", checkedAt: null, loginVisible: false }
  let revision = 0
  let pending: Promise<WppAuthState> | undefined
  let invalidated = false
  const listeners = new Set<(state: WppAuthState) => void>()
  const publish = (next: WppAuthState) => {
    state = next
    listeners.forEach((listener) => listener({ ...state }))
  }
  const check = (): Promise<WppAuthState> => {
    if (pending) return pending
    const current = ++revision
    if (state.status !== "signed-in" && state.status !== "signed-out") publish({ ...state, status: "checking" })
    pending = Promise.resolve()
      .then(probe)
      .catch(() => "unknown" as const)
      .then((status) => {
        if (current === revision) publish({ ...state, status, checkedAt: Date.now() })
        return { ...state }
      })
      .finally(() => {
        pending = undefined
        if (!invalidated) return
        invalidated = false
        void check()
      })
    return pending
  }
  return {
    check,
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
      publish({ ...state, status, checkedAt: Date.now() })
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
  if (response.status === 401) return "signed-out"
  if (response.status !== 200 || !response.headers.get("content-type")?.includes("application/json")) return "unknown"
  const value: unknown = await response.json().catch(() => undefined)
  if (hasWppIdentity(value)) return "signed-in"
  if (!value || typeof value !== "object") return "unknown"
  if ("user" in value && hasWppIdentity(value.user)) return "signed-in"
  if ("data" in value && hasWppIdentity(value.data)) return "signed-in"
  return "unknown"
}

function hasWppIdentity(value: unknown) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false
  return (
    ("id" in value && typeof value.id === "string" && !!value.id.trim()) ||
    ("email" in value && typeof value.email === "string" && !!value.email.trim())
  )
}
