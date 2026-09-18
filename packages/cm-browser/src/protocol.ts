import { isAbsolute, join } from "node:path"

export const ALLOWLIST_FILENAME = "cm-browser-allowlist.json"
export const STATE_DIRECTORY_NAME = "CookieMonster"
export const MAX_URL_LENGTH = 2_048
export const MAX_TYPED_TEXT = 10_000
export const MAX_SNAPSHOT_BYTES = 64 * 1024
export const OPERATION_TIMEOUT_MS = 15_000
export const MAX_SCREENSHOT_EDGE = 4096
export const MAX_SCREENSHOT_PIXELS = 4_194_304
export const MAX_SCREENSHOT_BYTES = 46_080
export const MAX_SCREENSHOT_BASE64 = 61_440
export const MIN_CONSOLE_OBSERVATION_MS = 250
export const MAX_CONSOLE_OBSERVATION_MS = 5_000

export type Screenshot = { readonly data: string; readonly width: number; readonly height: number }
export type ConsoleObservation = {
  readonly durationMs: number
  readonly debug: number
  readonly info: number
  readonly warning: number
  readonly error: number
  readonly other: number
  readonly total: number
}

export function screenshotDimensions(width: unknown, height: unknown): boolean {
  return (
    typeof width === "number" &&
    typeof height === "number" &&
    Number.isInteger(width) &&
    Number.isInteger(height) &&
    width > 0 &&
    height > 0 &&
    width <= MAX_SCREENSHOT_EDGE &&
    height <= MAX_SCREENSHOT_EDGE &&
    width * height <= MAX_SCREENSHOT_PIXELS
  )
}

export function screenshotBytes(data: unknown): Buffer | undefined {
  if (
    typeof data !== "string" ||
    !data ||
    data.length > MAX_SCREENSHOT_BASE64 ||
    !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(data)
  )
    return
  const bytes = Buffer.from(data, "base64")
  if (
    bytes.length < 4 ||
    bytes.length > MAX_SCREENSHOT_BYTES ||
    bytes.toString("base64") !== data ||
    bytes[0] !== 255 ||
    bytes[1] !== 216 ||
    bytes[2] !== 255 ||
    bytes[bytes.length - 2] !== 255 ||
    bytes[bytes.length - 1] !== 217
  )
    return
  return bytes
}

export const DEFAULT_ALLOWLIST: readonly string[] = ["localhost", "127.0.0.1", "teams.microsoft.com"]
export const MODIFIERS = ["Ctrl", "Alt", "Shift", "Meta"] as const

export type Modifier = (typeof MODIFIERS)[number]

export type ElementRef = {
  readonly ref: string
  readonly tag: string
  readonly role: string
  readonly label: string
  readonly text: string
  readonly checked?: boolean | "mixed"
  readonly selected?: boolean
  readonly expanded?: boolean
  readonly disabled?: boolean
  readonly options?: readonly { ref: string; label: string; selected: boolean; disabled: boolean }[]
  readonly optionsTruncated?: boolean
}

export type TabRequest =
  | { readonly op: "create_tab" }
  | { readonly op: "select_tab" | "close_tab"; readonly tabID: string }

export type TabResult = { readonly op: TabRequest["op"]; readonly tabID: string }

export type FrameContext = {
  readonly frameRef: string
  readonly approval: string
  readonly topOrigin: string
  readonly origin: string
}
export type FrameSelectContext = FrameContext & {
  readonly op: "select_option"
  readonly ref: string
  readonly optionRef: string
}
export type FrameRequest =
  | { readonly op: "prepare_frame"; readonly tabID: string; readonly frameRef: string }
  | {
      readonly op: "read_state"
      readonly tabID: string
      readonly frameRef: string
      readonly frameContext: FrameContext
    }
  | {
      readonly op: "prepare_frame_select"
      readonly tabID: string
      readonly frameRef: string
      readonly ref: string
      readonly optionRef: string
    }
  | {
      readonly op: "select_option"
      readonly tabID: string
      readonly frameRef: string
      readonly ref: string
      readonly optionRef: string
      readonly frameSelectContext: FrameSelectContext
    }

export type BrowserState = {
  readonly frames?: readonly { frameRef: string; origin: string }[]
  readonly frameContext?: FrameContext
  readonly frameSelectContext?: FrameSelectContext
  readonly frameRef?: string
  readonly tabToken?: string
  readonly tabResult?: TabResult
  readonly screenshot?: Screenshot
  readonly diagnostics?: { readonly console: ConsoleObservation }
  readonly context?: AccessContext
  readonly history?: readonly { ref: string; url: string; title: string; time: number }[]
  readonly opened?: boolean
  readonly tabID: string
  readonly tabs?: readonly { tabID: string; url: string; title: string }[]
  readonly url: string
  readonly title: string
  readonly visibleText: string
  readonly truncated?: boolean
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
  readonly ownerContext: string
}

export type WriteRequest = { readonly tabID: string } & (
  | { readonly op: "screenshot" }
  | { readonly op: "observe_console"; readonly durationMs: number }
  | { readonly op: "navigate"; readonly url: string }
  | { readonly op: "click"; readonly ref: string; readonly mode?: "left" | "double" | "right" }
  | { readonly op: "hover"; readonly ref: string }
  | { readonly op: "drag"; readonly sourceRef: string; readonly targetRef: string }
  | { readonly op: "select_option"; readonly ref: string; readonly optionRef: string }
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
  | FrameRequest
  | { readonly op: "prepare_tab"; readonly request: TabRequest }
  | (TabRequest & { readonly token: string })
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

export function parseTabRequest(value: unknown): TabRequest | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return
  const input = value as Record<string, unknown>
  if (input.op === "create_tab")
    return Object.keys(input).every((key) => key === "op") ? { op: "create_tab" } : undefined
  if (
    (input.op !== "select_tab" && input.op !== "close_tab") ||
    Object.keys(input).some((key) => key !== "op" && key !== "tabID") ||
    typeof input.tabID !== "string" ||
    !/^[A-Za-z0-9_-]{1,128}$/.test(input.tabID)
  )
    return
  return { op: input.op, tabID: input.tabID }
}

export function parseRequest(value: unknown): Request | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return
  const input = value as Record<string, unknown>
  if (input.op === "prepare_frame_select" || (input.op === "select_option" && "frameRef" in input)) {
    if (
      Object.keys(input).some(
        (key) =>
          ![
            "op",
            "tabID",
            "frameRef",
            "ref",
            "optionRef",
            ...(input.op === "select_option" ? ["frameSelectContext"] : []),
          ].includes(key),
      ) ||
      typeof input.tabID !== "string" ||
      !input.tabID ||
      input.tabID.length > 128 ||
      typeof input.frameRef !== "string" ||
      !/^[a-f0-9-]{36}$/.test(input.frameRef) ||
      !frameElementRef(input.ref) ||
      !frameElementRef(input.optionRef)
    )
      return
    const target = { tabID: input.tabID, frameRef: input.frameRef, ref: input.ref, optionRef: input.optionRef }
    if (input.op === "prepare_frame_select") return { op: input.op, ...target }
    const frameSelectContext = parseFrameSelectContext(input.frameSelectContext)
    return frameSelectContext &&
      frameSelectContext.frameRef === target.frameRef &&
      frameSelectContext.ref === target.ref &&
      frameSelectContext.optionRef === target.optionRef
      ? { op: input.op, ...target, frameSelectContext }
      : undefined
  }
  if (input.op === "prepare_frame" || (input.op === "read_state" && "frameRef" in input)) {
    if (
      Object.keys(input).some(
        (key) => !["op", "tabID", "frameRef", ...(input.op === "read_state" ? ["frameContext"] : [])].includes(key),
      ) ||
      typeof input.tabID !== "string" ||
      !input.tabID ||
      input.tabID.length > 128 ||
      typeof input.frameRef !== "string" ||
      !/^[a-f0-9-]{36}$/.test(input.frameRef)
    )
      return
    if (input.op === "prepare_frame") return { op: input.op, tabID: input.tabID, frameRef: input.frameRef }
    const frameContext = parseFrameContext(input.frameContext)
    return frameContext && frameContext.frameRef === input.frameRef
      ? { op: "read_state", tabID: input.tabID, frameRef: input.frameRef, frameContext }
      : undefined
  }
  if (hasFrameTarget(input) || "frameContext" in input) return
  if (input.op === "prepare_tab") {
    if (Object.keys(input).some((key) => key !== "op" && key !== "request")) return
    const request = parseTabRequest(input.request)
    return request ? { op: "prepare_tab", request } : undefined
  }
  if (input.op === "create_tab" || input.op === "select_tab" || input.op === "close_tab") {
    const { token, ...action } = input
    const request = parseTabRequest(action)
    return request && typeof token === "string" && /^[A-Za-z0-9_-]{1,128}$/.test(token)
      ? { ...request, token }
      : undefined
  }
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

const frameElementRef = (value: unknown): value is string =>
  typeof value === "string" && /^frame\.[a-f0-9-]{36}:[a-zA-Z0-9-]{1,64}$/.test(value)

export function parseFrameSelectContext(value: unknown): FrameSelectContext | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return
  const { op, ref, optionRef, ...rest } = value as Record<string, unknown>
  const binding = parseFrameContext(rest)
  if (!binding || op !== "select_option" || !frameElementRef(ref) || !frameElementRef(optionRef)) return
  return { ...binding, op, ref, optionRef }
}

export function parseFrameContext(value: unknown): FrameContext | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return
  const input = value as Record<string, unknown>
  if (
    Object.keys(input).length !== 4 ||
    typeof input.frameRef !== "string" ||
    !/^[a-f0-9-]{36}$/.test(input.frameRef) ||
    typeof input.approval !== "string" ||
    !/^[a-f0-9-]{36}$/.test(input.approval)
  )
    return
  for (const key of ["origin", "topOrigin"])
    if (
      typeof input[key] !== "string" ||
      input[key].length > MAX_URL_LENGTH ||
      !hostOf(input[key]) ||
      new URL(input[key]).origin !== input[key]
    )
      return
  return {
    frameRef: input.frameRef,
    approval: input.approval,
    topOrigin: input.topOrigin as string,
    origin: input.origin as string,
  }
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
  if (typeof input.ownerContext !== "string" || !/^[A-Za-z0-9_-]{1,128}$/.test(input.ownerContext)) return
  return {
    tabID: input.tabID,
    origin: input.origin,
    urlHash: input.urlHash,
    revision: input.revision,
    accessRevision: input.accessRevision,
    ownerContext: input.ownerContext,
  }
}

function validTimeout(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value) && value > 0 && value <= OPERATION_TIMEOUT_MS
}

// Frame targeting must be admitted explicitly, never stripped into a top-document operation.
export function hasFrameTarget(input: Record<string, unknown>) {
  return [
    "frameRef",
    "frameContext",
    "frameSelectContext",
    "frameId",
    "frameID",
    "executionContextId",
    "contextId",
    "sessionId",
    "sessionID",
  ].some((key) => key in input)
}

function parseWriteRequest(value: unknown): WriteRequest | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return
  const input = value as Record<string, unknown>
  if (hasFrameTarget(input)) return
  if (typeof input.tabID !== "string" || !input.tabID || input.tabID.length > 128) return
  const tabID = input.tabID
  if (input.op === "screenshot") return { op: "screenshot", tabID }
  if (input.op === "observe_console") {
    if (
      Object.keys(input).some((key) => !["op", "tabID", "durationMs", "context"].includes(key)) ||
      typeof input.durationMs !== "number" ||
      !Number.isInteger(input.durationMs) ||
      input.durationMs < MIN_CONSOLE_OBSERVATION_MS ||
      input.durationMs > MAX_CONSOLE_OBSERVATION_MS
    )
      return
    return { op: "observe_console", tabID, durationMs: input.durationMs }
  }
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
  if (input.op === "drag") {
    if (
      typeof input.sourceRef !== "string" ||
      !input.sourceRef ||
      input.sourceRef.length > 256 ||
      typeof input.targetRef !== "string" ||
      !input.targetRef ||
      input.targetRef.length > 256
    )
      return
    return { op: "drag", tabID, sourceRef: input.sourceRef, targetRef: input.targetRef }
  }
  if (input.op === "select_option") {
    if (
      typeof input.ref !== "string" ||
      !input.ref ||
      input.ref.length > 256 ||
      typeof input.optionRef !== "string" ||
      !input.optionRef ||
      input.optionRef.length > 256
    )
      return
    return { op: "select_option", tabID, ref: input.ref, optionRef: input.optionRef }
  }
  if (input.op === "click" || input.op === "hover" || input.op === "fill") {
    if (typeof input.ref !== "string" || !input.ref || input.ref.length > 256) return
    if (input.op === "hover") return { op: "hover", tabID, ref: input.ref }
    if (input.op === "click") {
      if (input.mode !== undefined && input.mode !== "left" && input.mode !== "double" && input.mode !== "right") return
      return { op: "click", tabID, ref: input.ref, ...(input.mode === undefined ? {} : { mode: input.mode }) }
    }
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
