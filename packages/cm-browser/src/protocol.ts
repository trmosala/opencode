import { join } from "node:path"

export const ALLOWLIST_FILENAME = "cm-browser-allowlist.json"
export const STATE_DIRECTORY_NAME = "CookieMonster"
export const MAX_URL_LENGTH = 2_048
export const MAX_TYPED_TEXT = 10_000
export const MAX_SNAPSHOT_BYTES = 64 * 1024
export const OPERATION_TIMEOUT_MS = 15_000

export const DEFAULT_ALLOWLIST: readonly string[] = ["localhost", "127.0.0.1", "teams.microsoft.com"]
export const MODIFIERS = ["Ctrl", "Alt", "Shift", "Meta"] as const

export type Modifier = (typeof MODIFIERS)[number]

export type ElementRef = {
  readonly ref: string
  readonly tag: string
  readonly role: string
  readonly label: string
  readonly text: string
}

export type BrowserState = {
  readonly url: string
  readonly title: string
  readonly visibleText: string
  readonly elements: readonly ElementRef[]
}

export type Request =
  | { readonly op: "read_state" }
  | { readonly op: "navigate"; readonly url: string }
  | { readonly op: "click"; readonly ref: string }
  | { readonly op: "fill"; readonly ref: string; readonly text: string }
  | { readonly op: "press_key"; readonly key: string; readonly modifiers: readonly Modifier[] }

export type ErrorCode =
  | "no_target"
  | "blocked_host"
  | "stale_ref"
  | "detached"
  | "bad_request"
  | "unavailable"
  | "timeout"

export type Failure = { readonly ok: false; readonly code: ErrorCode; readonly error: string }
export type Success<T> = { readonly ok: true; readonly result: T }
export type Response<T> = Success<T> | Failure

export type BrowserIpcRequest = {
  readonly type: "browser_request"
  readonly id: string
  readonly sessionID: string
  readonly request: Request
}

export type BrowserIpcResult = {
  readonly type: "browser_result"
  readonly id: string
  readonly response: Response<BrowserState>
}

export const failure = (code: ErrorCode, error: string): Failure => ({ ok: false, code, error })
export const success = <T>(result: T): Success<T> => ({ ok: true, result })

export function stateDirectory(env: Record<string, string | undefined> = process.env, platform = process.platform) {
  if (platform === "win32") {
    const roaming = env.APPDATA ?? join(env.USERPROFILE ?? ".", "AppData", "Roaming")
    return join(roaming, STATE_DIRECTORY_NAME)
  }
  if (platform === "darwin") return join(env.HOME ?? ".", "Library", "Application Support", STATE_DIRECTORY_NAME)
  return join(env.XDG_CONFIG_HOME ?? join(env.HOME ?? ".", ".config"), STATE_DIRECTORY_NAME)
}

export function allowlistPath(env: Record<string, string | undefined> = process.env, platform = process.platform) {
  return join(stateDirectory(env, platform), ALLOWLIST_FILENAME)
}

export function parseAllowlist(value: unknown): readonly string[] | undefined {
  if (!Array.isArray(value)) return
  return value
    .filter((host): host is string => typeof host === "string" && host.trim().length > 0)
    .map((host) => host.trim().toLowerCase())
}

export function parseRequest(value: unknown): Request | undefined {
  if (!value || typeof value !== "object") return
  const input = value as Record<string, unknown>
  if (input.op === "read_state") return { op: "read_state" }
  if (input.op === "navigate")
    return typeof input.url === "string" && input.url.length <= MAX_URL_LENGTH
      ? { op: "navigate", url: input.url }
      : undefined
  if (input.op === "click")
    return typeof input.ref === "string" && input.ref ? { op: "click", ref: input.ref } : undefined
  if (input.op === "fill")
    return typeof input.ref === "string" &&
      input.ref &&
      typeof input.text === "string" &&
      input.text.length <= MAX_TYPED_TEXT
      ? { op: "fill", ref: input.ref, text: input.text }
      : undefined
  if (input.op !== "press_key" || typeof input.key !== "string" || !input.key) return
  if (!Array.isArray(input.modifiers)) return
  const modifiers = input.modifiers.filter(
    (modifier): modifier is Modifier => typeof modifier === "string" && MODIFIERS.includes(modifier as Modifier),
  )
  if (modifiers.length !== input.modifiers.length) return
  return { op: "press_key", key: input.key, modifiers }
}

export function parseBrowserIpcRequest(value: unknown): BrowserIpcRequest | undefined {
  if (!value || typeof value !== "object") return
  const input = value as Record<string, unknown>
  if (input.type !== "browser_request" || typeof input.id !== "string" || !input.id) return
  if (typeof input.sessionID !== "string" || !input.sessionID) return
  const request = parseRequest(input.request)
  if (!request) return
  return { type: "browser_request", id: input.id, sessionID: input.sessionID, request }
}

export function parseBrowserIpcResult(value: unknown): BrowserIpcResult | undefined {
  if (!value || typeof value !== "object") return
  const input = value as Record<string, unknown>
  if (input.type !== "browser_result" || typeof input.id !== "string" || !input.id) return
  if (
    !input.response ||
    typeof input.response !== "object" ||
    typeof (input.response as { ok?: unknown }).ok !== "boolean"
  )
    return
  return input as BrowserIpcResult
}

export function hostOf(url: string): string | undefined {
  try {
    const parsed = new URL(url)
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return
    return parsed.hostname.toLowerCase()
  } catch {
    return
  }
}

export function hostAllowed(url: string, allowlist: readonly string[]): boolean {
  const host = hostOf(url)
  if (!host) return false
  return allowlist.some((entry) => {
    const allowed = entry.trim().toLowerCase()
    return Boolean(allowed) && (host === allowed || host.endsWith(`.${allowed}`))
  })
}
