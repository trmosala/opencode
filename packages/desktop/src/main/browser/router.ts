import { createHash } from "node:crypto"
import type { EventEmitter } from "node:events"
import {
  OPERATION_TIMEOUT_MS,
  MAX_SNAPSHOT_BYTES,
  failure,
  success,
  parseRequest,
  type BrowserIpcRequest,
  type FrameRequest,
  type BrowserState,
  type ActionStatus,
  type ActionFailureCause,
  type Response,
} from "@cookiemonster/cm-browser/protocol"
import { browserInputFailure, execute } from "./driver"
import {
  browserTabs,
  browserAccessAllowed,
  browserRegistration,
  browserAgentEnabled,
  routeBrowserHistory,
  routeBrowserTab,
  browserOperationBusy,
  browserTabReserved,
  watchBrowserAccess,
} from "./registry"
import type { BrowserAuthority } from "./delegation"
import { browserURL, browserNavigationURL, browserPageURL } from "./policy"
import { keepBrowserRendering } from "./rendering"
import { nativeT } from "../native-translations"
import { discoverDocuments, executeFrame } from "./frames"
import { observeConsole } from "./console-diagnostics"
import { discoverSiteTools, invokeSiteTool, prepareSiteTool } from "./site-tools"
import { startBrowserOperation } from "./operation-state"
import { visualDocumentSignature } from "./visual-documents"

const busy = browserOperationBusy

export type BrowserOperation = {
  authority?: BrowserAuthority
  signal?: AbortSignal
  deadline?: number
  onSettled?: (operation: Promise<unknown>) => void
  onScreenshotDelivery?: (check: () => void) => void
  onActionDispatch?: () => void
  onActionObservation?: () => void
}

const PAGE_STATE_OPERATIONS = new Set<BrowserIpcRequest["request"]["op"]>([
  "read_state",
  "navigate",
  "click",
  "hover",
  "drag",
  "select_option",
  "fill",
  "press_key",
  "scroll",
  "visual_action",
  "wait_for_element",
  "wait_for_navigation",
])

export function browserOperationReturnsPageState(op: BrowserIpcRequest["request"]["op"], result: BrowserState) {
  return (
    PAGE_STATE_OPERATIONS.has(op) &&
    result.frameRef === undefined &&
    result.frameContext === undefined &&
    result.frameSelectContext === undefined
  )
}

export function browserResponseNeedsDeliveryCheck(op: BrowserIpcRequest["request"]["op"], result: BrowserState) {
  return (
    browserOperationReturnsPageState(op, result) ||
    op === "list_tabs" ||
    result.context !== undefined ||
    result.delegation?.active === true ||
    op === "screenshot" ||
    op === "observe_console" ||
    op === "observe_network" ||
    result.screenshot !== undefined ||
    result.diagnostics !== undefined ||
    result.frames !== undefined ||
    result.documents !== undefined ||
    result.frameRef !== undefined ||
    result.frameContext !== undefined ||
    result.frameSelectContext !== undefined ||
    result.siteTools !== undefined ||
    result.siteToolContext !== undefined ||
    result.siteToolResult !== undefined
  )
}

export function browserDeliveryError(
  op: BrowserIpcRequest["request"]["op"],
  result: BrowserState,
):
  | "desktop.browser.operationUnavailable"
  | "desktop.browser.diagnosticsDeliveryUnavailable"
  | "desktop.browser.siteToolDeliveryUnavailable"
  | "desktop.browser.screenshotDeliveryUnavailable" {
  if (result.diagnostics !== undefined || op === "observe_console" || op === "observe_network")
    return "desktop.browser.diagnosticsDeliveryUnavailable"
  if (
    result.siteTools !== undefined ||
    result.siteToolContext !== undefined ||
    result.siteToolResult !== undefined ||
    op === "list_site_tools" ||
    op === "prepare_site_tool" ||
    op === "execute_site_tool"
  )
    return "desktop.browser.siteToolDeliveryUnavailable"
  if (result.screenshot !== undefined || op === "screenshot") return "desktop.browser.screenshotDeliveryUnavailable"
  return "desktop.browser.operationUnavailable"
}

export async function routeBrowserRequest(
  message: BrowserIpcRequest,
  policy?: (url: string) => boolean,
  control: BrowserOperation = {},
): Promise<Response<BrowserState>> {
  const validated = parseRequest(message.request)
  if (!validated) return failure("bad_request", "Invalid browser request.")
  const request = validated.op === "prepare_write" ? validated.request : validated
  const tracksAction = [
    "navigate",
    "click",
    "hover",
    "drag",
    "select_option",
    "fill",
    "press_key",
    "scroll",
    "execute_site_tool",
    "frame_input",
    "visual_action",
  ].includes(request.op)
  let dispatchAttempted = false
  let observationStarted = false
  const markDispatched = () => {
    dispatchAttempted = true
    control.onActionDispatch?.()
  }
  const markObservation = () => {
    observationStarted = true
    control.onActionObservation?.()
  }
  const withActionStatus = (response: Response<BrowserState>): Response<BrowserState> => {
    if (!tracksAction) return response
    const actionStatus: ActionStatus = !dispatchAttempted
      ? "not_dispatched"
      : response.ok &&
          (browserOperationReturnsPageState(request.op, response.result) ||
            request.op === "execute_site_tool" ||
            (request.op === "frame_input" &&
              response.result.frameRef === request.frameRef &&
              !response.result.frameContext))
        ? "dispatched_observed"
        : "dispatched_uncertain"
    const actionCause: ActionFailureCause | undefined =
      actionStatus !== "dispatched_uncertain"
        ? undefined
        : response.ok
          ? "observation_unavailable"
          : response.code === "cancelled"
            ? "cancelled"
            : response.code === "timeout"
              ? "timeout"
              : observationStarted
                ? "observation_failed"
                : "native_action_failed"
    const error = !response.ok
      ? actionCause === "native_action_failed"
        ? nativeT("desktop.browser.actionDispatchFailed")
        : actionCause === "observation_failed" || actionCause === "observation_unavailable"
          ? nativeT("desktop.browser.actionObservationFailed")
          : response.error
      : undefined
    const bounded = { ...response, actionStatus, ...(actionCause ? { actionCause } : {}), ...(error ? { error } : {}) }
    return Buffer.byteLength(JSON.stringify(bounded)) <= MAX_SNAPSHOT_BYTES
      ? bounded
      : {
          ...failure(
            "unavailable",
            dispatchAttempted
              ? nativeT("desktop.browser.actionObservationFailed")
              : "Browser response exceeds the size limit.",
          ),
          actionStatus: dispatchAttempted ? "dispatched_uncertain" : "not_dispatched",
          ...(dispatchAttempted ? { actionCause: "observation_failed" as const } : {}),
        }
  }
  if (validated.op === "grant_tabs" || validated.op === "revoke_tabs")
    return failure("access_denied", nativeT("desktop.browser.operationUnavailable"))
  const access = control.authority
  const operationSignal = access?.signal
    ? AbortSignal.any([...(control.signal ? [control.signal] : []), access.signal])
    : control.signal
  const duration =
    validated.op === "search_history" || validated.op === "open_history"
      ? 60_000
      : "timeoutMs" in validated
        ? (validated.timeoutMs ?? OPERATION_TIMEOUT_MS)
        : OPERATION_TIMEOUT_MS
  const deadline = Math.min(control.deadline ?? Infinity, Date.now() + duration)
  const controller = new AbortController()
  const abort = () => controller.abort(failure("cancelled", "Browser operation cancelled."))
  if (operationSignal?.aborted) abort()
  if (!controller.signal.aborted && Date.now() >= deadline)
    controller.abort(failure("timeout", "Browser operation timed out."))
  if (controller.signal.aborted) return withActionStatus(controller.signal.reason)
  operationSignal?.addEventListener("abort", abort, { once: true })
  const timer = setTimeout(
    () => controller.abort(failure("timeout", "Browser operation timed out.")),
    Math.max(0, deadline - Date.now()),
  )
  let interrupted!: () => void
  const cancelled = new Promise<Response<BrowserState>>((resolve) => {
    interrupted = () => resolve(controller.signal.reason)
    controller.signal.addEventListener("abort", interrupted, { once: true })
  })
  let unwatch: (() => void) | undefined
  let deliveryCheck: (() => void) | undefined
  let operationState: ReturnType<typeof startBrowserOperation> | undefined
  const report = (response: Response<BrowserState>) => {
    operationState?.report(response)
    return response
  }
  const operation = (async () => {
    access?.check()
    const tab =
      "tabID" in request
        ? access
          ? access.resolve(request.tabID)
          : browserRegistration(message.sessionID, request.tabID)
        : undefined
    unwatch = tab
      ? watchBrowserAccess(tab, () => {
          // Closing a tab normally revokes access during destruction. Its native close acknowledgement owns success.
          if (validated.op === "close_tab" && tab.contents.isDestroyed()) return
          abort()
        })
      : undefined
    return route(
      message,
      policy,
      controller.signal,
      deadline,
      markDispatched,
      markObservation,
      (check) => {
        deliveryCheck = () => {
          operationSignal?.throwIfAborted()
          access?.check()
          check()
        }
        control.onScreenshotDelivery?.(deliveryCheck)
      },
      access,
      (state) => {
        operationState = state
      },
    )
  })()
    .then((response) =>
      controller.signal.aborted
        ? withActionStatus(controller.signal.reason)
        : Date.now() >= deadline
          ? withActionStatus(failure("timeout", "Browser operation timed out."))
          : withActionStatus(response),
    )
    .catch(() =>
      controller.signal.aborted
        ? withActionStatus(controller.signal.reason)
        : Date.now() >= deadline
          ? withActionStatus(failure("timeout", "Browser operation timed out."))
          : withActionStatus(failure("unavailable", nativeT("desktop.browser.operationUnavailable"))),
    )
  void operation.finally(() => unwatch?.())
  control.onSettled?.(operation)
  try {
    const response = withActionStatus(await Promise.race([operation, cancelled]))
    if (response.ok && browserResponseNeedsDeliveryCheck(validated.op, response.result)) {
      try {
        if (!deliveryCheck) throw new Error("Missing browser delivery authority")
        deliveryCheck()
      } catch {
        return report({
          ...failure("unavailable", nativeT(browserDeliveryError(validated.op, response.result))),
          ...(response.actionStatus
            ? {
                actionStatus:
                  response.actionStatus === "dispatched_observed" ? "dispatched_uncertain" : response.actionStatus,
              }
            : {}),
          ...(response.actionStatus
            ? { actionCause: "observation_failed" as const, error: nativeT("desktop.browser.actionObservationFailed") }
            : {}),
        })
      }
    }
    return report(response)
  } finally {
    clearTimeout(timer)
    operationSignal?.removeEventListener("abort", abort)
    controller.signal.removeEventListener("abort", interrupted)
  }
}

async function route(
  message: BrowserIpcRequest,
  policy: ((url: string) => boolean) | undefined,
  signal: AbortSignal,
  deadline: number,
  markDispatched: () => void,
  markObservation: () => void,
  onScreenshotDelivery: (check: () => void) => void,
  access?: BrowserAuthority,
  onOperationStart?: (state: ReturnType<typeof startBrowserOperation>) => void,
): Promise<Response<BrowserState>> {
  signal.throwIfAborted()
  access?.check()
  const parsed = parseRequest(message.request)
  if (!parsed) return failure("bad_request", "Invalid browser request.")
  if (parsed.op === "grant_tabs" || parsed.op === "revoke_tabs")
    return failure("access_denied", nativeT("desktop.browser.operationUnavailable"))
  if (!browserAgentEnabled()) return failure("access_denied", "Browser agent access is disabled in browser settings.")
  if (parsed.op === "prepare_tab" || "token" in parsed)
    return routeBrowserTab(message.sessionID, parsed, signal, deadline)
  const request = parsed.op === "prepare_write" ? parsed.request : parsed
  if (request.op === "search_history" || request.op === "open_history")
    return routeBrowserHistory(message.sessionID, request, signal)
  const resolve = (tabID: string) => (access ? access.resolve(tabID) : browserRegistration(message.sessionID, tabID))
  if (request.op === "list_tabs") {
    const listed = (access ? access.tabs() : browserTabs(message.sessionID))
      .filter(
        (tab) =>
          !browserTabReserved(tab, access?.token) &&
          tab.agentAccess &&
          (tab.contents.getURL() === "about:blank" ||
            (browserPageURL(tab.contents.getURL()) &&
              (policy ? policy(tab.contents.getURL()) : browserAccessAllowed(tab, tab.contents.getURL())))),
      )
      .map((tab) => ({
        tab,
        url: tab.contents.getURL(),
        revision: tab.revision,
        accessRevision: tab.accessRevision,
        ownerID: tab.ownerID,
        ownerContext: tab.ownerContext?.(),
        sessionID: tab.sessionID,
        agentOwnerSessionID: tab.agentOwnerSessionID,
      }))
    onScreenshotDelivery(() => {
      signal.throwIfAborted()
      access?.check()
      if (!browserAgentEnabled() || Date.now() >= deadline) throw new Error("Inventory authority changed")
      listed.forEach((item) => {
        const tab = item.tab
        if (
          resolve(tab.id) !== tab ||
          browserTabReserved(tab, access?.token) ||
          !tab.agentAccess ||
          tab.contents.getURL() !== item.url ||
          tab.revision !== item.revision ||
          tab.accessRevision !== item.accessRevision ||
          tab.ownerID !== item.ownerID ||
          tab.ownerContext?.() !== item.ownerContext ||
          tab.sessionID !== item.sessionID ||
          tab.agentOwnerSessionID !== item.agentOwnerSessionID
        )
          throw new Error("Inventory authority changed")
      })
    })
    return success({
      tabID: "",
      url: "",
      title: "",
      visibleText: "",
      elements: [],
      tabs: listed.map(({ tab, url }) => ({ tabID: tab.id, url, title: "" })),
    })
  }
  const tab = resolve(request.tabID)
  if (!tab) return failure("no_target", "Browser tab not found in this session.")
  if (browserTabReserved(tab, access?.token))
    return failure("unavailable", nativeT("desktop.browser.operationUnavailable"))
  if (!tab.agentAccess) return failure("access_denied", "Enable agent access for this tab in the browser panel.")
  const isAllowed = policy ?? ((url: string) => browserAccessAllowed(tab, url))
  const contents = tab.contents
  const url = contents.getURL()
  const observing = request.op === "wait_for_navigation" || request.op === "wait_for_element"
  const navigating = request.op === "navigate" || request.op === "wait_for_navigation"
  const siteRequest =
    request.op === "list_site_tools" || request.op === "prepare_site_tool" || request.op === "execute_site_tool"
  if (navigating && (!browserURL(request.url) || !isAllowed(request.url)))
    return failure("blocked_host", nativeT("desktop.browser.websiteAccessRequired"))
  if (!(request.op === "navigate" && url === "about:blank") && (!browserPageURL(url) || !isAllowed(url)))
    return failure("blocked_host", nativeT("desktop.browser.websiteAccessRequired"))
  if (busy.has(tab.id)) return failure("unavailable", "Another operation is running on this tab.")
  const blocked = browserInputFailure(contents)
  if (blocked) return blocked
  if (!navigating && contents.isLoadingMainFrame())
    return failure("unavailable", "Browser page is loading. Wait for loading to finish.")

  const ownerID = tab.ownerID
  const revision = tab.revision
  const accessRevision = tab.accessRevision ?? 0
  const ownerContext =
    tab.ownerContext?.() ?? createHash("sha256").update(`${tab.ownerID}:${tab.sessionID}`).digest("base64url")
  // ponytail: hash the exact source, not a truncated URL; main's epochs also detect A-B-A.
  const origin = url === "about:blank" ? url : new URL(url).origin
  const urlHash = createHash("sha256").update(url).digest("hex")
  const sessionID = tab.sessionID
  const agentOwnerSessionID = tab.agentOwnerSessionID
  if (
    parsed.op !== "prepare_write" &&
    request.op !== "read_state" &&
    request.op !== "prepare_frame" &&
    request.op !== "prepare_frame_select" &&
    !("frameRef" in request) &&
    !observing &&
    !siteRequest &&
    (!("context" in parsed) ||
      parsed.context.tabID !== tab.id ||
      parsed.context.origin !== origin ||
      parsed.context.urlHash !== urlHash ||
      parsed.context.revision !== revision ||
      parsed.context.accessRevision !== accessRevision ||
      parsed.context.ownerContext !== ownerContext)
  )
    return failure("access_denied", nativeT("desktop.browser.operationUnavailable"))
  let destination: { revision: number; url: string } | undefined
  const check = (source = false) => {
    signal.throwIfAborted()
    access?.check()
    if (Date.now() >= deadline) throw new Error("Browser operation timed out")
    if (
      resolve(request.tabID) !== tab ||
      browserTabReserved(tab, access?.token) ||
      tab.sessionID !== sessionID ||
      tab.agentOwnerSessionID !== agentOwnerSessionID ||
      tab.contents !== contents ||
      tab.ownerID !== ownerID ||
      (tab.ownerContext?.() ?? createHash("sha256").update(`${tab.ownerID}:${tab.sessionID}`).digest("base64url")) !==
        ownerContext ||
      !browserAgentEnabled() ||
      !tab.agentAccess ||
      (tab.accessRevision ?? 0) !== accessRevision ||
      contents.isDestroyed() ||
      ((observing || request.op === "screenshot" || request.op === "scroll" || request.op === "select_option") &&
        browserInputFailure(contents)) ||
      ((!navigating || (source && request.op === "navigate")) &&
        (tab.revision !== revision || contents.getURL() !== url)) ||
      (!navigating && contents.isLoadingMainFrame()) ||
      (destination &&
        (tab.revision !== destination.revision ||
          contents.getURL() !== destination.url ||
          contents.isLoadingMainFrame()))
    )
      throw new Error("Browser access changed")
    const current = contents.getURL()
    if (!(request.op === "navigate" && current === "about:blank") && (!browserPageURL(current) || !isAllowed(current)))
      throw new Error(nativeT("desktop.browser.websiteAccessRequired"))
    if (navigating && (!browserURL(request.url) || !isAllowed(request.url)))
      throw new Error(nativeT("desktop.browser.websiteAccessRequired"))
    if (source && request.op === "wait_for_navigation") {
      if (current !== request.url || contents.isLoadingMainFrame()) throw new Error("Browser destination changed")
      destination = { revision: tab.revision, url: current }
    }
  }
  if (parsed.op === "prepare_write") {
    check()
    onScreenshotDelivery(check)
    return success({
      tabID: tab.id,
      url: origin,
      title: "",
      visibleText: "",
      elements: [],
      context: { tabID: tab.id, origin, urlHash, revision, accessRevision, ownerContext },
    })
  }
  const pinDestination = () => {
    check()
    destination = { revision: tab.revision, url: contents.getURL() }
    check()
  }
  // Screenshots observe every source transition but never veto user navigation.
  const screenshot = request.op === "screenshot"
  const visual = request.op === "visual_action"
  const diagnostics = request.op === "observe_console" || request.op === "observe_network"
  const siteExecution = request.op === "execute_site_tool"
  const consent = screenshot || visual || diagnostics || siteExecution ? new AbortController() : undefined
  const revoke = () => consent?.abort()
  if (consent && !tab.captureOwner) return failure("unavailable", nativeT("desktop.browser.operationUnavailable"))
  const ownerCheck = consent ? tab.captureOwner!(screenshot || visual) : undefined
  const authority = (source = false) => {
    check(source)
    consent?.signal.throwIfAborted()
    ownerCheck?.()
  }
  if (!observing && !screenshot && !diagnostics && !siteRequest)
    tab.navigationAllowed = (url) => browserNavigationURL(url) && isAllowed(url)
  busy.add(tab.id)
  const operationState = startBrowserOperation(tab, request.op, signal)
  onOperationStart?.(operationState)
  const release = keepBrowserRendering(contents)
  try {
    if (consent && !siteExecution) {
      if (screenshot) tab.screenshotConsent = consent
      if (diagnostics) tab.diagnosticConsent = consent
      signal.addEventListener("abort", revoke, { once: true })
      authority()
      onScreenshotDelivery(authority)
    }
    if (siteRequest) {
      const access = { tabID: tab.id, origin, urlHash, revision, accessRevision, ownerContext }
      if (request.op === "list_site_tools") {
        const discovered = await discoverSiteTools(contents, authority)
        if (discovered.origin !== origin) throw new Error("Site tool origin changed")
        onScreenshotDelivery(authority)
        return success({
          tabID: tab.id,
          url: origin,
          title: "",
          visibleText: "",
          elements: [],
          siteTools: discovered.tools,
          ...(discovered.truncated ? { siteToolsTruncated: true } : {}),
        })
      }
      const prepared = await prepareSiteTool(contents, request.toolRef, request.arguments, authority)
      if (prepared.origin !== origin) throw new Error("Site tool origin changed")
      if (request.op === "prepare_site_tool") {
        onScreenshotDelivery(authority)
        return success({
          tabID: tab.id,
          url: origin,
          title: "",
          visibleText: "",
          elements: [],
          siteToolContext: {
            ...access,
            toolRef: prepared.ref,
            toolRevision: prepared.revision,
            argumentHash: prepared.argumentHash,
          },
          siteToolRequest: {
            name: prepared.name,
            ...(prepared.public.title ? { title: prepared.public.title } : {}),
            origin,
            arguments: request.arguments,
          },
        })
      }
      const context = request.siteToolContext
      if (
        context.tabID !== access.tabID ||
        context.origin !== access.origin ||
        context.urlHash !== access.urlHash ||
        context.revision !== access.revision ||
        context.accessRevision !== access.accessRevision ||
        context.ownerContext !== access.ownerContext ||
        context.toolRef !== prepared.ref ||
        context.toolRevision !== prepared.revision ||
        context.argumentHash !== prepared.argumentHash
      )
        return failure("access_denied", nativeT("desktop.browser.operationUnavailable"))
      tab.siteToolConsent = consent
      signal.addEventListener("abort", revoke, { once: true })
      authority()
      markDispatched()
      const result = await invokeSiteTool(contents, prepared, request.arguments, authority, consent!.signal)
      authority()
      onScreenshotDelivery(authority)
      return success({
        tabID: tab.id,
        url: origin,
        title: "",
        visibleText: "",
        elements: [],
        siteToolResult: result,
      })
    }
    if ("frameRef" in request) {
      const frame = await executeFrame(
        tab,
        request as FrameRequest,
        authority,
        deadline,
        isAllowed,
        markDispatched,
        markObservation,
      )
      const delivery = () => {
        authority()
        frame.check()
      }
      delivery()
      onScreenshotDelivery(delivery)
      return frame.response
    }
    if (request.op === "observe_network") {
      authority()
      if (!tab.observeNetwork || !consent)
        return failure("unavailable", nativeT("desktop.browser.diagnosticsDeliveryUnavailable"))
      const network = await tab.observeNetwork(request.durationMs, authority, consent.signal)
      authority()
      return success({ tabID: tab.id, url: origin, title: "", visibleText: "", elements: [], diagnostics: { network } })
    }
    // Keep busy/rendering ownership until actual native settlement, even after an early reply.
    const response =
      request.op === "observe_console"
        ? success({
            tabID: tab.id,
            url: origin,
            title: "",
            visibleText: "",
            elements: [],
            diagnostics: {
              console: await observeConsole(
                contents as unknown as EventEmitter,
                request.durationMs,
                authority,
                consent!.signal,
              ),
            },
          })
        : await execute(
            {
              tabID: tab.id,
              contents,
              check: authority,
              signal,
              deadline,
              onActionDispatch: markDispatched,
              onActionObservation: markObservation,
              visualOwnerCheck: screenshot || visual ? ownerCheck : undefined,
              visualDocuments: screenshot || visual ? () => visualDocumentSignature(tab, authority) : undefined,
              visualAuthority:
                screenshot || visual
                  ? createHash("sha256")
                      .update(
                        JSON.stringify([
                          ownerID,
                          sessionID,
                          agentOwnerSessionID,
                          ownerContext,
                          revision,
                          accessRevision,
                          urlHash,
                        ]),
                      )
                      .digest("hex")
                  : undefined,
              pinDestination: request.op === "navigate" ? pinDestination : undefined,
            },
            request,
          )
    if (screenshot) authority()
    if (response.ok && browserOperationReturnsPageState(request.op, response.result)) {
      authority()
      onScreenshotDelivery(authority)
    }
    if (response.ok && request.op === "read_state") {
      let page: BrowserState = response.result
      if (tab.frameSessions) {
        while (Buffer.byteLength(JSON.stringify(page)) > 24 * 1024 && page.elements.length) {
          page = { ...page, elements: page.elements.slice(0, -1), truncated: true }
        }
        while (Buffer.byteLength(JSON.stringify(page)) > 24 * 1024 && page.visibleText.length) {
          page = {
            ...page,
            visibleText: page.visibleText.slice(0, Math.floor(page.visibleText.length / 2)),
            truncated: true,
          }
        }
      }
      const discovered = await discoverDocuments(
        tab,
        authority,
        isAllowed,
        MAX_SNAPSHOT_BYTES - Buffer.byteLength(JSON.stringify(page)) - 512,
      )
      if (discovered) {
        const delivery = () => {
          authority()
          discovered.check()
        }
        delivery()
        onScreenshotDelivery(delivery)
        return success({ ...page, frames: discovered.frames, documents: discovered.documents })
      }
    }
    return response
  } finally {
    signal.removeEventListener("abort", revoke)
    if (consent && tab.screenshotConsent === consent) tab.screenshotConsent = undefined
    if (consent && tab.diagnosticConsent === consent) tab.diagnosticConsent = undefined
    if (consent && tab.siteToolConsent === consent) tab.siteToolConsent = undefined
    busy.delete(tab.id)
    operationState.finish()
    if (!observing && !screenshot && !diagnostics && !siteRequest) tab.navigationAllowed = undefined
    release()
  }
}
