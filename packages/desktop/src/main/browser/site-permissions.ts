import type { BrowserPermission } from "@opencode-ai/app/browser-panel"
import { release } from "node:os"

export const displayCaptureSupported = () =>
  // Darwin 24 is macOS 15, the first release supported by Electron's native system picker.
  process.platform === "darwin" && Number.parseInt(release().split(".")[0] ?? "0", 10) >= 24

export function siteOrigin(value: unknown) {
  if (typeof value !== "string" || value.length > 2048 || !URL.canParse(value)) return
  const url = new URL(value)
  if (url.username || url.password) return
  if (
    url.protocol !== "https:" &&
    !(url.protocol === "http:" && ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname))
  )
    return
  return url.origin
}

export function permissionValue(value: unknown): value is BrowserPermission {
  return value === "block" || value === "ask" || value === "allow"
}

export function sitePermissionRows(value: unknown) {
  if (!Array.isArray(value) || value.length > 200) throw new Error("Invalid site permissions")
  const seen = new Set<string>()
  return value.map((row: unknown) => {
    if (!row || typeof row !== "object" || Array.isArray(row)) throw new Error("Invalid site permissions")
    const entry = row as Record<string, unknown>
    const origin = siteOrigin(entry.origin)
    if (
      !origin ||
      origin !== entry.origin ||
      seen.has(origin) ||
      !permissionValue(entry.camera) ||
      !permissionValue(entry.microphone) ||
      (entry.notifications !== undefined && !permissionValue(entry.notifications)) ||
      (entry.displayCapture !== undefined && !permissionValue(entry.displayCapture)) ||
      (entry.clipboard !== undefined && !permissionValue(entry.clipboard))
    )
      throw new Error("Invalid site permissions")
    seen.add(origin)
    return {
      origin,
      camera: entry.camera,
      microphone: entry.microphone,
      notifications: entry.notifications ?? ("block" as const),
      displayCapture: entry.displayCapture ?? ("block" as const),
      clipboard: entry.clipboard ?? ("block" as const),
    }
  })
}
