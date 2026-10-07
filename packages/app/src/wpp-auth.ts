import type { Accessor } from "solid-js"

export type WppAuthStatus = "unknown" | "checking" | "signed-in" | "signed-out"

export type WppAuthState = {
  status: WppAuthStatus
  checkedAt: number | null
  loginVisible: boolean
}

export type WppAuthPlatform = {
  state: Accessor<WppAuthState>
  check: () => Promise<WppAuthState>
  toggleLogin: () => Promise<void>
}
