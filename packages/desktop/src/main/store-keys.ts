export const SETTINGS_STORE = "opencode.settings"
export const DEFAULT_SERVER_URL_KEY = "defaultServerUrl"
export const FIRST_LAUNCH_ONBOARDING_COMPLETE_KEY = "firstLaunchOnboardingComplete"
export const OLD_LAYOUT_ELIGIBLE_KEY = "oldLayoutEligible"
export const WSL_SERVERS_KEY = "wslServers"
export const PINCH_ZOOM_ENABLED_KEY = "pinchZoomEnabled"
export const WINDOW_IDS_KEY = "windowIds"

export function requireStoreName(name: string) {
  if (typeof name === "string" && /^[a-zA-Z0-9][a-zA-Z0-9._-]*$/.test(name)) return
  throw new Error("Invalid store name")
}

export function requireRendererStoreName(name: string) {
  requireStoreName(name)
  // Windows ignores case and trailing periods in filenames. Reserve the browser
  // namespace in every generic IPC operation, including deletion and enumeration.
  if (name.toLowerCase().replace(/\.+$/, "").startsWith("cm-browser")) throw new Error("Private browser store")
}
