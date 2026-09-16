import { isAbsolute, join } from "node:path"

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
  readonly context?: AccessContext
  readonly history?: readonly { ref: string; url: string; title: string; time: number }[]
  readonly opened?: boolean
  readonly tabID: string
  readonly tabs?: readonly { tabID: string; url: string; title: string }[]
  readonly url: string
  readonly title: string
  readonly visibleText: string
  readonly elements: readonly ElementRef[]
}

export type HistoryRequest =
  | {
      readonly op: "search_history"
      readonly query: string
      readonly from?: number
      readonly to?: number
      readonly limit: number
    }
  | { readonly op: "open_history"; readonly ref: string }

export type AccessContext = {
  readonly tabID: string
  readonly origin: string
  readonly urlHash: string
  readonly revision: number
  readonly accessRevision: number
}

export type WriteRequest = { readonly tabID: string } & (
  | { readonly op: "navigate"; readonly url: string }
  | { readonly op: "click"; readonly ref: string }
  | { readonly op: "fill"; readonly ref: string; readonly text: string }
  | { readonly op: "press_key"; readonly key: string; readonly modifiers: readonly Modifier[] }
  | {
      readonly op: "scroll"
      readonly ref?: string
      readonly deltaX: number
      readonly deltaY: number
      readonly timeoutMs?: number
    }
)

export type WaitRequest = { readonly tabID: string; readonly timeoutMs: number } & (
  | { readonly op: "wait_for_element"; readonly selector: string }
  | { readonly op: "wait_for_navigation"; readonly url: string }
)

export type PageRequest = { readonly op: "read_state"; readonly tabID: string } | WriteRequest | WaitRequest

export type Request =
  | HistoryRequest
  | WaitRequest
  | { readonly op: "list_tabs" }
  | { readonly op: "prepare_write"; readonly request: WriteRequest }
  | { readonly op: "read_state"; readonly tabID: string }
  | (WriteRequest & { readonly context: AccessContext })

export type ErrorCode =
  | "no_target"
  | "access_denied"
  | "blocked_host"
  | "stale_ref"
  | "detached"
  | "bad_request"
  | "unavailable"
  | "timeout"
  | "cancelled"

export type Failure = { readonly ok: false; readonly code: ErrorCode; readonly error: string }
export type Success<T> = { readonly ok: true; readonly result: T }
export type Response<T> = Success<T> | Failure

export type BrowserIpcRequest = {
  readonly type: "browser_request"
  readonly id: string
  readonly sessionID: string
  readonly request: Request
}

export type BrowserIpcCancel = {
  readonly type: "browser_cancel"
  readonly id: string
  readonly sessionID: string
}

export function parseBrowserIpcCancel(value: unknown): BrowserIpcCancel | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined
  if (!("type" in value) || value.type !== "browser_cancel") return undefined
  if (!("id" in value) || typeof value.id !== "string" || !value.id || value.id.length > 128) return undefined
  if (
    !("sessionID" in value) ||
    typeof value.sessionID !== "string" ||
    !value.sessionID ||
    value.sessionID.length > 128
  )
    return undefined
  return { type: "browser_cancel", id: value.id, sessionID: value.sessionID }
}

export type BrowserIpcResult = {
  readonly type: "browser_result"
  readonly id: string
  readonly response: Response<BrowserState>
}

export const failure = (code: ErrorCode, error: string): Failure => ({ ok: false, code, error })
export function success<T>(result: T): Response<T> {
  const response: Success<T> = { ok: true, result }
  // ponytail: reject oversized responses rather than truncate URLs used as identities.
  return Buffer.byteLength(JSON.stringify(response)) <= MAX_SNAPSHOT_BYTES
    ? response
    : failure("unavailable", "Browser response exceeds the size limit.")
}

export function stateDirectory(env: Record<string, string | undefined> = process.env, platform = process.platform) {
  if (env.CM_BROWSER_STATE_DIR && isAbsolute(env.CM_BROWSER_STATE_DIR)) return env.CM_BROWSER_STATE_DIR
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
  if (input.op === "search_history") {
    if (
      typeof input.query !== "string" ||
      input.query.length > 256 ||
      !Number.isInteger(input.limit) ||
      Number(input.limit) < 1 ||
      Number(input.limit) > 20
    )
      return
    for (const key of ["from", "to"] as const)
      if (
        input[key] !== undefined &&
        (typeof input[key] !== "number" ||
          !Number.isSafeInteger(input[key]) ||
          input[key] < 0 ||
          input[key] > 8_640_000_000_000_000)
      )
        return
    if (typeof input.from === "number" && typeof input.to === "number" && input.from > input.to) return
    return {
      op: "search_history",
      query: input.query,
      limit: Number(input.limit),
      from: typeof input.from === "number" ? input.from : undefined,
      to: typeof input.to === "number" ? input.to : undefined,
    }
  }
  if (input.op === "open_history")
    return typeof input.ref === "string" && input.ref.length > 0 && input.ref.length <= 128
      ? { op: "open_history", ref: input.ref }
      : undefined
  if (input.op === "list_tabs") return { op: "list_tabs" }
  if (input.op === "prepare_write") {
    const request = parseWriteRequest(input.request)
    return request ? { op: "prepare_write", request } : undefined
  }
  if (input.op === "read_state")
    return typeof input.tabID === "string" && input.tabID.length > 0 && input.tabID.length <= 128
      ? { op: "read_state", tabID: input.tabID }
      : undefined
  if (input.op === "wait_for_element" || input.op === "wait_for_navigation") {
    if (typeof input.tabID !== "string" || !input.tabID || input.tabID.length > 128 || !validTimeout(input.timeoutMs))
      return undefined
    if (input.op === "wait_for_element")
      return typeof input.selector === "string" && input.selector.trim().length > 0 && input.selector.length <= 512
        ? { op: input.op, tabID: input.tabID, selector: input.selector, timeoutMs: input.timeoutMs }
        : undefined
    return typeof input.url === "string" && input.url.length <= MAX_URL_LENGTH && hostOf(input.url)
      ? { op: input.op, tabID: input.tabID, url: input.url, timeoutMs: input.timeoutMs }
      : undefined
  }
  const request = parseWriteRequest(input)
  const context = parseAccessContext(input.context)
  return request && context ? { ...request, context } : undefined
}

export function parseAccessContext(value: unknown): AccessContext | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return
  const input = value as Record<string, unknown>
  if (typeof input.tabID !== "string" || !input.tabID || input.tabID.length > 128) return
  if (typeof input.origin !== "string" || !input.origin || input.origin.length > MAX_URL_LENGTH) return
  if (input.origin !== "about:blank") {
    if (!hostOf(input.origin) || new URL(input.origin).origin !== input.origin) return
  }
  if (typeof input.urlHash !== "string" || !/^[a-f0-9]{64}$/.test(input.urlHash)) return
  if (typeof input.revision !== "number" || !Number.isSafeInteger(input.revision) || input.revision < 0) return
  if (
    typeof input.accessRevision !== "number" ||
    !Number.isSafeInteger(input.accessRevision) ||
    input.accessRevision < 0
  )
    return
  return {
    tabID: input.tabID,
    origin: input.origin,
    urlHash: input.urlHash,
    revision: input.revision,
    accessRevision: input.accessRevision,
  }
}

function validTimeout(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value) && value > 0 && value <= OPERATION_TIMEOUT_MS
}

function parseWriteRequest(value: unknown): WriteRequest | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return
  const input = value as Record<string, unknown>
  if (typeof input.tabID !== "string" || !input.tabID || input.tabID.length > 128) return
  const tabID = input.tabID
  if (input.op === "navigate")
    return typeof input.url === "string" && input.url.length <= MAX_URL_LENGTH
      ? { op: "navigate", tabID, url: input.url }
      : undefined
  if (input.op === "scroll") {
    if (
      typeof input.deltaX !== "number" ||
      !Number.isInteger(input.deltaX) ||
      Math.abs(input.deltaX) > 2000 ||
      typeof input.deltaY !== "number" ||
      !Number.isInteger(input.deltaY) ||
      Math.abs(input.deltaY) > 2000 ||
      (input.deltaX === 0 && input.deltaY === 0) ||
      (input.ref !== undefined && (typeof input.ref !== "string" || !input.ref || input.ref.length > 256)) ||
      (input.timeoutMs !== undefined && !validTimeout(input.timeoutMs))
    )
      return undefined
    return {
      op: "scroll",
      tabID,
      deltaX: input.deltaX,
      deltaY: input.deltaY,
      ...(typeof input.ref === "string" ? { ref: input.ref } : {}),
      ...(validTimeout(input.timeoutMs) ? { timeoutMs: input.timeoutMs } : {}),
    }
  }
  if (input.op === "click" || input.op === "fill") {
    if (typeof input.ref !== "string" || !input.ref || input.ref.length > 256) return
    if (input.op === "click") return { op: "click", tabID, ref: input.ref }
    if (typeof input.text !== "string" || input.text.length > MAX_TYPED_TEXT) return
    return { op: "fill", tabID, ref: input.ref, text: input.text }
  }
  if (input.op !== "press_key" || typeof input.key !== "string" || !input.key || input.key.length > 32) return
  if (!Array.isArray(input.modifiers) || input.modifiers.length > 4) return
  const modifiers = input.modifiers.filter(
    (modifier): modifier is Modifier => typeof modifier === "string" && MODIFIERS.includes(modifier as Modifier),
  )
  if (modifiers.length !== input.modifiers.length) return
  return { op: "press_key", tabID, key: input.key, modifiers }
}

export function parseBrowserIpcRequest(value: unknown): BrowserIpcRequest | undefined {
  if (!value || typeof value !== "object") return
  const input = value as Record<string, unknown>
  if (input.type !== "browser_request" || typeof input.id !== "string" || !input.id || input.id.length > 128) return
  if (typeof input.sessionID !== "string" || !input.sessionID || input.sessionID.length > 128) return
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
