export const BROWSER_PARTITION = "persist:cm-browser"

export function browserURL(value: unknown): value is string {
  return typeof value === "string" && value.length <= 2048 && browserPageURL(value)
}

// Source identity is not a navigation destination and may contain a long history URL.
export function browserPageURL(value: unknown): value is string {
  if (typeof value !== "string") return false
  if (value === "about:blank") return true
  try {
    const url = new URL(value)
    return (
      (url.protocol === "http:" || url.protocol === "https:") &&
      !url.username &&
      !url.password &&
      url.origin.length <= 2048
    )
  } catch {
    return false
  }
}

export const browserPreferences = {
  partition: BROWSER_PARTITION,
  sandbox: true,
  contextIsolation: true,
  nodeIntegration: false,
  nodeIntegrationInWorker: false,
  nodeIntegrationInSubFrames: false,
  webviewTag: false,
  webSecurity: true,
  allowRunningInsecureContent: false,
  navigateOnDragDrop: false,
  safeDialogs: true,
} as const
