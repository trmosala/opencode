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
export const MIN_NETWORK_OBSERVATION_MS = 250
export const MAX_NETWORK_OBSERVATION_MS = 5_000
export const DEFAULT_NETWORK_OBSERVATION_MS = 3_000
export const MAX_SITE_TOOLS = 32
export const MAX_SITE_TOOL_ARGUMENT_BYTES = 8 * 1024
export const MAX_SITE_TOOL_RESULT_BYTES = 16 * 1024

export type Screenshot = {
  readonly data: string
  readonly width: number
  readonly height: number
  readonly visualRef?: string
  readonly actionUnavailable?: string
  readonly viewportWidth?: number
  readonly viewportHeight?: number
  readonly scaleX?: number
  readonly scaleY?: number
}
export type ConsoleObservation = {
  readonly durationMs: number
  readonly debug: number
  readonly info: number
  readonly warning: number
  readonly error: number
  readonly other: number
  readonly total: number
}

// Terminal events received in the window, not requests started after approval.
// Electron may attribute workers/in-flight requests to the main frame; zero is not a health verdict.
export type NetworkObservation = {
  readonly durationMs: number
  readonly http1xx: number
  readonly http2xx: number
  readonly http3xx: number
  readonly http4xx: number
  readonly http5xx: number
  readonly other: number
  readonly failed: number
  readonly total: number
}

export type SiteTool = {
  readonly ref: string
  readonly name: string
  readonly title?: string
  readonly description: string
  readonly inputSchema?: string
  readonly readOnly?: boolean
  readonly consequential?: boolean
  readonly untrustedContent?: boolean
}

export type SiteToolContext = AccessContext & {
  readonly toolRef: string
  readonly toolRevision: number
  readonly argumentHash: string
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
  | FrameInputRequest
  | { readonly op: "prepare_frame"; readonly tabID: string; readonly frameRef: string }
  | {
      readonly op: "read_state"
      readonly tabID: string
      readonly frameRef: string
      readonly frameContext: FrameContext
      readonly selector?: string
    }
  | {
      readonly op: "wait_for_element"
      readonly tabID: string
      readonly frameRef: string
      readonly frameContext: FrameContext
      readonly selector: string
      readonly condition?: "visible" | "attached" | "ready"
      readonly timeoutMs: number
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

export const MAX_DELEGATED_TABS = 16
export type DelegationRequest =
  | {
      readonly op: "grant_tabs"
      readonly executionID: string
      readonly childSessionID: string
      readonly tabIDs: readonly string[]
    }
  | { readonly op: "revoke_tabs"; readonly executionID: string }
export type DelegationResult = { readonly executionID: string; readonly active: boolean }

export const browserIdentity = (value: unknown): value is string =>
  typeof value === "string" && /^[A-Za-z0-9_-]{1,128}$/.test(value)

export function parseDelegationRequest(value: unknown): DelegationRequest | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return
  const input = value as Record<string, unknown>
  if (!browserIdentity(input.executionID)) return
  if (input.op === "revoke_tabs")
    return Object.keys(input).every((key) => key === "op" || key === "executionID")
      ? { op: input.op, executionID: input.executionID }
      : undefined
  if (
    input.op !== "grant_tabs" ||
    Object.keys(input).some((key) => !["op", "executionID", "childSessionID", "tabIDs"].includes(key)) ||
    !browserIdentity(input.childSessionID) ||
    !Array.isArray(input.tabIDs) ||
    input.tabIDs.length < 1 ||
    input.tabIDs.length > MAX_DELEGATED_TABS ||
    !input.tabIDs.every(browserIdentity) ||
    new Set(input.tabIDs).size !== input.tabIDs.length
  )
    return
  return {
    op: input.op,
    executionID: input.executionID,
    childSessionID: input.childSessionID,
    tabIDs: [...input.tabIDs],
  }
}

export function parseDelegationResult(value: unknown): DelegationResult | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return
  const input = value as Record<string, unknown>
  if (Object.keys(input).length !== 2 || !browserIdentity(input.executionID) || typeof input.active !== "boolean")
    return
  return { executionID: input.executionID, active: input.active }
}

export type BrowserState = {
  readonly actionStatus?: ActionStatus
  readonly actionCause?: ActionFailureCause
  readonly delegation?: DelegationResult
  readonly frames?: readonly { frameRef: string; origin: string }[]
  readonly documents?: readonly {
    frameRef: string
    parentFrameRef?: string
    origin: string
    url: string
    title: string
    status: "read" | "excluded" | "unsupported" | "failed" | "truncated"
    reason?: string
    omissions?: readonly string[]
    visibleText?: string
    elements?: readonly ElementRef[]
  }[]
  readonly frameContext?: FrameContext
  readonly frameSelectContext?: FrameSelectContext
  readonly frameRef?: string
  readonly tabToken?: string
  readonly tabResult?: TabResult
  readonly screenshot?: Screenshot
  readonly diagnostics?: { readonly console?: ConsoleObservation; readonly network?: NetworkObservation }
  readonly siteTools?: readonly SiteTool[]
  readonly siteToolsTruncated?: boolean
  readonly siteToolContext?: SiteToolContext
  readonly siteToolRequest?: {
    readonly name: string
    readonly title?: string
    readonly origin: string
    readonly arguments: string
  }
  readonly siteToolResult?: { readonly name: string; readonly origin: string; readonly content: string }
  readonly context?: AccessContext
  readonly history?: readonly { ref: string; url: string; title: string; time: number }[]
  readonly opened?: boolean
  readonly tabID: string
  readonly tabs?: readonly { tabID: string; url: string; title: string }[]
  readonly url: string
  readonly title: string
  readonly visibleText: string
  readonly truncated?: boolean
  readonly inspection?: { readonly selector: string; readonly matched: boolean }
  readonly observedCondition?: { readonly selector: string; readonly condition: "visible" | "attached" | "ready" }
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
  | {
      readonly op: "visual_action"
      readonly visualRef: string
      readonly action: "click" | "hover"
      readonly x: number
      readonly y: number
    }
  | { readonly op: "observe_console"; readonly durationMs: number }
  | { readonly op: "observe_network"; readonly durationMs: number }
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
  | {
      readonly op: "wait_for_element"
      readonly selector: string
      readonly condition?: "visible" | "attached" | "ready"
    }
  | { readonly op: "wait_for_navigation"; readonly url: string }
)

type FrameWrite = Extract<
  WriteRequest,
  { op: "click" | "hover" | "drag" | "fill" | "press_key" | "select_option" | "scroll" }
>
export type FrameAction = FrameWrite extends infer Action
  ? Action extends FrameWrite
    ? Omit<Action, "tabID">
    : never
  : never
export type FrameInputRequest =
  | {
      readonly op: "prepare_frame_input"
      readonly tabID: string
      readonly frameRef: string
      readonly action: FrameAction
    }
  | {
      readonly op: "frame_input"
      readonly tabID: string
      readonly frameRef: string
      readonly frameContext: FrameContext
      readonly action: FrameAction
    }

export type PageRequest =
  | { readonly op: "read_state"; readonly tabID: string; readonly selector?: string }
  | WriteRequest
  | WaitRequest

export type Request =
  | DelegationRequest
  | FrameRequest
  | { readonly op: "prepare_tab"; readonly request: TabRequest }
  | (TabRequest & { readonly token: string })
  | HistoryRequest
  | { readonly op: "list_site_tools"; readonly tabID: string }
  | {
      readonly op: "prepare_site_tool"
      readonly tabID: string
      readonly toolRef: string
      readonly arguments: string
    }
  | {
      readonly op: "execute_site_tool"
      readonly tabID: string
      readonly toolRef: string
      readonly arguments: string
      readonly siteToolContext: SiteToolContext
    }
  | WaitRequest
  | { readonly op: "list_tabs" }
  | { readonly op: "prepare_write"; readonly request: WriteRequest }
  | { readonly op: "read_state"; readonly tabID: string; readonly selector?: string }
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

export type ActionStatus = "not_dispatched" | "dispatched_observed" | "dispatched_uncertain"
export type ActionFailureCause =
  | "native_action_failed"
  | "observation_failed"
  | "observation_unavailable"
  | "cancelled"
  | "timeout"
  | "transport_unknown"
export type Failure = {
  readonly ok: false
  readonly code: ErrorCode
  readonly error: string
  readonly actionStatus?: ActionStatus
  readonly actionCause?: ActionFailureCause
}
export type Success<T> = {
  readonly ok: true
  readonly result: T
  readonly actionStatus?: ActionStatus
  readonly actionCause?: ActionFailureCause
}
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
  if (input.op === "grant_tabs" || input.op === "revoke_tabs") return parseDelegationRequest(input)
  if (input.op === "prepare_frame_input" || input.op === "frame_input") {
    if (
      typeof input.tabID !== "string" ||
      !input.tabID ||
      input.tabID.length > 128 ||
      typeof input.frameRef !== "string" ||
      !/^[a-f0-9-]{36}$/.test(input.frameRef) ||
      Object.keys(input).some(
        (key) =>
          !["op", "tabID", "frameRef", "action", ...(input.op === "frame_input" ? ["frameContext"] : [])].includes(key),
      )
    )
      return
    const action = parseFrameAction(input.action)
    if (!action) return
    if (input.op === "prepare_frame_input")
      return { op: input.op, tabID: input.tabID, frameRef: input.frameRef, action }
    const frameContext = parseFrameContext(input.frameContext)
    return frameContext && frameContext.frameRef === input.frameRef
      ? { op: input.op, tabID: input.tabID, frameRef: input.frameRef, action, frameContext }
      : undefined
  }
  if (input.op === "list_site_tools") {
    if (
      Object.keys(input).some((key) => !["op", "tabID"].includes(key)) ||
      typeof input.tabID !== "string" ||
      !/^[A-Za-z0-9_-]{1,128}$/.test(input.tabID)
    )
      return
    return { op: input.op, tabID: input.tabID }
  }
  if (input.op === "prepare_site_tool" || input.op === "execute_site_tool") {
    const keys = [
      "op",
      "tabID",
      "toolRef",
      "arguments",
      ...(input.op === "execute_site_tool" ? ["siteToolContext"] : []),
    ]
    if (
      Object.keys(input).some((key) => !keys.includes(key)) ||
      typeof input.tabID !== "string" ||
      !/^[A-Za-z0-9_-]{1,128}$/.test(input.tabID) ||
      typeof input.toolRef !== "string" ||
      !/^[a-f0-9-]{36}$/.test(input.toolRef) ||
      typeof input.arguments !== "string" ||
      !parseSiteToolArguments(input.arguments)
    )
      return
    if (input.op === "prepare_site_tool")
      return { op: input.op, tabID: input.tabID, toolRef: input.toolRef, arguments: input.arguments }
    const siteToolContext = parseSiteToolContext(input.siteToolContext)
    return siteToolContext && siteToolContext.tabID === input.tabID && siteToolContext.toolRef === input.toolRef
      ? { op: input.op, tabID: input.tabID, toolRef: input.toolRef, arguments: input.arguments, siteToolContext }
      : undefined
  }
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
  if (input.op === "wait_for_element" && "frameRef" in input) {
    const frameContext = parseFrameContext(input.frameContext)
    if (
      !frameContext ||
      frameContext.frameRef !== input.frameRef ||
      typeof input.tabID !== "string" ||
      !input.tabID ||
      input.tabID.length > 128 ||
      !browserReadSelector(input.selector) ||
      !validTimeout(input.timeoutMs) ||
      (input.condition !== undefined && !["visible", "attached", "ready"].includes(input.condition as string)) ||
      Object.keys(input).some(
        (key) => !["op", "tabID", "frameRef", "frameContext", "selector", "condition", "timeoutMs"].includes(key),
      )
    )
      return
    return {
      op: input.op,
      tabID: input.tabID,
      frameRef: frameContext.frameRef,
      frameContext,
      selector: input.selector,
      timeoutMs: input.timeoutMs,
      ...(input.condition === undefined ? {} : { condition: input.condition as "visible" | "attached" | "ready" }),
    }
  }
  if (input.op === "prepare_frame" || (input.op === "read_state" && "frameRef" in input)) {
    if (
      Object.keys(input).some(
        (key) =>
          !["op", "tabID", "frameRef", ...(input.op === "read_state" ? ["frameContext", "selector"] : [])].includes(
            key,
          ),
      ) ||
      typeof input.tabID !== "string" ||
      !input.tabID ||
      input.tabID.length > 128 ||
      typeof input.frameRef !== "string" ||
      !/^[a-f0-9-]{36}$/.test(input.frameRef)
    )
      return
    if (input.op === "prepare_frame") return { op: input.op, tabID: input.tabID, frameRef: input.frameRef }
    if (input.selector !== undefined && !browserReadSelector(input.selector)) return
    const frameContext = parseFrameContext(input.frameContext)
    return frameContext && frameContext.frameRef === input.frameRef
      ? {
          op: "read_state",
          tabID: input.tabID,
          frameRef: input.frameRef,
          frameContext,
          ...(input.selector === undefined ? {} : { selector: input.selector }),
        }
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
    return typeof input.tabID === "string" &&
      input.tabID.length > 0 &&
      input.tabID.length <= 128 &&
      (input.selector === undefined || browserReadSelector(input.selector))
      ? { op: "read_state", tabID: input.tabID, ...(input.selector === undefined ? {} : { selector: input.selector }) }
      : undefined
  if (input.op === "wait_for_element" || input.op === "wait_for_navigation") {
    if (typeof input.tabID !== "string" || !input.tabID || input.tabID.length > 128 || !validTimeout(input.timeoutMs))
      return undefined
    if (input.op === "wait_for_element")
      return browserReadSelector(input.selector) &&
        (input.condition === undefined || ["visible", "attached", "ready"].includes(input.condition as string))
        ? {
            op: input.op,
            tabID: input.tabID,
            selector: input.selector,
            timeoutMs: input.timeoutMs,
            ...(input.condition === undefined
              ? {}
              : { condition: input.condition as "visible" | "attached" | "ready" }),
          }
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
      (!(key === "origin" && input[key] === "null") &&
        (!hostOf(input[key]) || new URL(input[key]).origin !== input[key]))
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

export function parseSiteToolContext(value: unknown): SiteToolContext | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return
  const input = value as Record<string, unknown>
  if (Object.keys(input).length !== 9) return
  const context = parseAccessContext(input)
  if (
    !context ||
    typeof input.toolRef !== "string" ||
    !/^[a-f0-9-]{36}$/.test(input.toolRef) ||
    typeof input.toolRevision !== "number" ||
    !Number.isSafeInteger(input.toolRevision) ||
    input.toolRevision < 0 ||
    typeof input.argumentHash !== "string" ||
    !/^[a-f0-9]{64}$/.test(input.argumentHash)
  )
    return
  return {
    ...context,
    toolRef: input.toolRef,
    toolRevision: input.toolRevision,
    argumentHash: input.argumentHash,
  }
}

export function parseSiteToolArguments(value: string): Record<string, unknown> | undefined {
  if (Buffer.byteLength(value) > MAX_SITE_TOOL_ARGUMENT_BYTES) return
  try {
    const parsed: unknown = JSON.parse(value)
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return
    let entries = 0
    const valid = (current: unknown, depth: number): boolean => {
      if (current === null || typeof current === "string" || typeof current === "boolean") return true
      if (typeof current === "number") return Number.isFinite(current)
      if (!current || typeof current !== "object" || depth > 8) return false
      if (Array.isArray(current)) {
        entries += current.length
        return entries <= 128 && current.every((item) => valid(item, depth + 1))
      }
      const keys = Object.keys(current)
      entries += keys.length
      return (
        entries <= 128 &&
        keys.every(
          (key) =>
            !["__proto__", "constructor", "prototype"].includes(key) &&
            valid((current as Record<string, unknown>)[key], depth + 1),
        )
      )
    }
    return valid(parsed, 0) ? (parsed as Record<string, unknown>) : undefined
  } catch {
    return
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
  if (input.op === "visual_action") {
    if (
      Object.keys(input).some((key) => !["op", "tabID", "visualRef", "action", "x", "y", "context"].includes(key)) ||
      typeof input.visualRef !== "string" ||
      !/^[a-f0-9-]{36}$/.test(input.visualRef) ||
      (input.action !== "click" && input.action !== "hover") ||
      typeof input.x !== "number" ||
      !Number.isFinite(input.x) ||
      input.x < 0 ||
      input.x >= MAX_SCREENSHOT_EDGE ||
      typeof input.y !== "number" ||
      !Number.isFinite(input.y) ||
      input.y < 0 ||
      input.y >= MAX_SCREENSHOT_EDGE
    )
      return
    return { op: input.op, tabID, visualRef: input.visualRef, action: input.action, x: input.x, y: input.y }
  }
  if (input.op === "observe_console" || input.op === "observe_network") {
    if (
      Object.keys(input).some((key) => !["op", "tabID", "durationMs", "context"].includes(key)) ||
      typeof input.durationMs !== "number" ||
      !Number.isInteger(input.durationMs) ||
      input.durationMs < (input.op === "observe_network" ? MIN_NETWORK_OBSERVATION_MS : MIN_CONSOLE_OBSERVATION_MS) ||
      input.durationMs > (input.op === "observe_network" ? MAX_NETWORK_OBSERVATION_MS : MAX_CONSOLE_OBSERVATION_MS)
    )
      return
    return { op: input.op, tabID, durationMs: input.durationMs }
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

function parseFrameAction(value: unknown): FrameAction | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return
  const input = value as Record<string, unknown>
  const keys: Record<string, readonly string[]> = {
    click: ["ref", "mode"],
    hover: ["ref"],
    drag: ["sourceRef", "targetRef"],
    fill: ["ref", "text"],
    press_key: ["key", "modifiers"],
    select_option: ["ref", "optionRef"],
    scroll: ["ref", "deltaX", "deltaY", "timeoutMs"],
  }
  if (
    typeof input.op !== "string" ||
    !Object.hasOwn(keys, input.op) ||
    Object.keys(input).some((key) => key !== "op" && !keys[input.op as string].includes(key))
  )
    return
  if (
    ["ref", "sourceRef", "targetRef", "optionRef"].some(
      (key) => input[key] !== undefined && !frameElementRef(input[key]),
    )
  )
    return
  const request = parseWriteRequest({ ...input, tabID: "frame" })
  if (!request || !["click", "hover", "drag", "fill", "press_key", "select_option", "scroll"].includes(request.op))
    return
  const { tabID: _tabID, ...action } = request as FrameWrite
  return action
}

export function parseBrowserIpcRequest(value: unknown): BrowserIpcRequest | undefined {
  if (!value || typeof value !== "object") return
  const input = value as Record<string, unknown>
  if (input.type !== "browser_request" || typeof input.id !== "string" || !input.id || input.id.length > 128) return
  if (typeof input.sessionID !== "string" || !input.sessionID || input.sessionID.length > 128) return
  const request = parseRequest(input.request)
  if (!request) return
  if (
    (request.op === "grant_tabs" || request.op === "revoke_tabs") &&
    (!browserIdentity(input.sessionID) ||
      Object.keys(input).some((key) => !["type", "id", "sessionID", "request"].includes(key)) ||
      (request.op === "grant_tabs" && request.childSessionID === input.sessionID))
  )
    return
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
  const response = input.response as Record<string, unknown>
  if (
    "actionStatus" in response &&
    !["not_dispatched", "dispatched_observed", "dispatched_uncertain"].includes(response.actionStatus as string)
  )
    return
  if (
    "actionCause" in response &&
    ![
      "native_action_failed",
      "observation_failed",
      "observation_unavailable",
      "cancelled",
      "timeout",
      "transport_unknown",
    ].includes(response.actionCause as string)
  )
    return
  if (response.ok && response.result && typeof response.result === "object" && "delegation" in response.result) {
    if (!parseDelegationResult(response.result.delegation)) return
  }
  return input as BrowserIpcResult
}

export function browserReadSelector(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.length > 0 &&
    value.length <= 512 &&
    /^(?:[A-Za-z][A-Za-z0-9-]*)?(?:[.#][A-Za-z_][A-Za-z0-9_-]*)*(?![\s\S])/.test(value)
  )
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
