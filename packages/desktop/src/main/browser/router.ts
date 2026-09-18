import { createHash } from "node:crypto"
import type { EventEmitter } from "node:events"
import {
  OPERATION_TIMEOUT_MS,
  failure,
  success,
  parseRequest,
  type BrowserIpcRequest,
  type FrameRequest,
  type BrowserState,
  type Response,
} from "@cookiemonster/cm-browser/protocol"
import { allowed, hostPolicyRevision } from "./allowlist"
import { browserInputFailure, execute } from "./driver"
import {
  browserTabs,
  browserRegistration,
  browserAgentEnabled,
  routeBrowserHistory,
  routeBrowserTab,
  browserOperationBusy,
} from "./registry"
import { browserURL, browserPageURL } from "./policy"
import { keepBrowserRendering } from "./rendering"
import { nativeT } from "../native-translations"
import { discoverFrames, executeFrame } from "./frames"
import { observeConsole } from "./console-diagnostics"
import { discoverSiteTools, invokeSiteTool, prepareSiteTool } from "./site-tools"

const busy = browserOperationBusy

export type BrowserOperation = {
  signal?: AbortSignal
  deadline?: number
  onSettled?: (operation: Promise<unknown>) => void
  onScreenshotDelivery?: (check: () => void) => void
}

export async function routeBrowserRequest(
  message: BrowserIpcRequest,
  isAllowed: (url: string) => boolean = allowed,
  control: BrowserOperation = {},
): Promise<Response<BrowserState>> {
  const validated = parseRequest(message.request)
  if (!validated) return failure("bad_request", "Invalid browser request.")
  const duration =
    validated.op === "search_history" || validated.op === "open_history"
      ? 60_000
      : "timeoutMs" in validated
        ? (validated.timeoutMs ?? OPERATION_TIMEOUT_MS)
        : OPERATION_TIMEOUT_MS
  const deadline = Math.min(control.deadline ?? Infinity, Date.now() + duration)
  const controller = new AbortController()
  const abort = () => controller.abort(failure("cancelled", "Browser operation cancelled."))
  if (control.signal?.aborted) abort()
  if (!controller.signal.aborted && Date.now() >= deadline)
    controller.abort(failure("timeout", "Browser operation timed out."))
  if (controller.signal.aborted) return controller.signal.reason
  control.signal?.addEventListener("abort", abort, { once: true })
  const timer = setTimeout(
    () => controller.abort(failure("timeout", "Browser operation timed out.")),
    Math.max(0, deadline - Date.now()),
  )
  let interrupted!: () => void
  const cancelled = new Promise<Response<BrowserState>>((resolve) => {
    interrupted = () => resolve(controller.signal.reason)
    controller.signal.addEventListener("abort", interrupted, { once: true })
  })
  let deliveryCheck: (() => void) | undefined
  const operation = route(message, isAllowed, controller.signal, deadline, (check) => {
    deliveryCheck = () => {
      control.signal?.throwIfAborted()
      check()
    }
    control.onScreenshotDelivery?.(deliveryCheck)
  })
    .then((response) =>
      controller.signal.aborted
        ? controller.signal.reason
        : Date.now() >= deadline
          ? failure("timeout", "Browser operation timed out.")
          : response,
    )
    .catch(() =>
      controller.signal.aborted
        ? controller.signal.reason
        : Date.now() >= deadline
          ? failure("timeout", "Browser operation timed out.")
          : failure("unavailable", "Browser operation interrupted or unavailable."),
    )
  control.onSettled?.(operation)
  try {
    const response = await Promise.race([operation, cancelled])
    if (
      response.ok &&
      (validated.op === "screenshot" ||
        validated.op === "observe_console" ||
        response.result.frames !== undefined ||
        response.result.frameRef !== undefined ||
        response.result.frameContext !== undefined ||
        response.result.frameSelectContext !== undefined ||
        response.result.siteTools !== undefined ||
        response.result.siteToolContext !== undefined ||
        response.result.siteToolResult !== undefined)
    ) {
      try {
        if (!deliveryCheck) throw new Error("Missing screenshot authority")
        deliveryCheck()
      } catch {
        return failure(
          "unavailable",
          nativeT(
            validated.op === "observe_console"
              ? "desktop.browser.diagnosticsDeliveryUnavailable"
              : validated.op === "list_site_tools" ||
                  validated.op === "prepare_site_tool" ||
                  validated.op === "execute_site_tool"
                ? "desktop.browser.siteToolDeliveryUnavailable"
                : "desktop.browser.screenshotDeliveryUnavailable",
          ),
        )
      }
    }
    return response
  } finally {
    clearTimeout(timer)
    control.signal?.removeEventListener("abort", abort)
    controller.signal.removeEventListener("abort", interrupted)
  }
}

async function route(
  message: BrowserIpcRequest,
  isAllowed: (url: string) => boolean,
  signal: AbortSignal,
  deadline: number,
  onScreenshotDelivery: (check: () => void) => void,
): Promise<Response<BrowserState>> {
  signal.throwIfAborted()
  const parsed = parseRequest(message.request)
  if (!parsed) return failure("bad_request", "Invalid browser request.")
  if (!browserAgentEnabled()) return failure("access_denied", "Browser agent access is disabled in browser settings.")
  if (parsed.op === "prepare_tab" || "token" in parsed)
    return routeBrowserTab(message.sessionID, parsed, signal, deadline)
  const request = parsed.op === "prepare_write" ? parsed.request : parsed
  if (request.op === "search_history" || request.op === "open_history")
    return routeBrowserHistory(message.sessionID, request, signal)
  if (request.op === "list_tabs") {
    return success({
      tabID: "",
      url: "",
      title: "",
      visibleText: "",
      elements: [],
      tabs: browserTabs(message.sessionID)
        .filter(
          (tab) =>
            tab.agentAccess &&
            (tab.contents.getURL() === "about:blank" ||
              (browserPageURL(tab.contents.getURL()) && isAllowed(tab.contents.getURL()))),
        )
        .map((tab) => ({ tabID: tab.id, url: tab.contents.getURL(), title: "" })),
    })
  }
  const tab = browserRegistration(message.sessionID, request.tabID)
  if (!tab) return failure("no_target", "Browser tab not found in this session.")
  if (!tab.agentAccess) return failure("access_denied", "Enable agent access for this tab in the browser panel.")
  const contents = tab.contents
  const url = contents.getURL()
  const observing = request.op === "wait_for_navigation" || request.op === "wait_for_element"
  const navigating = request.op === "navigate" || request.op === "wait_for_navigation"
  const siteRequest =
    request.op === "list_site_tools" || request.op === "prepare_site_tool" || request.op === "execute_site_tool"
  if (navigating && (!browserURL(request.url) || !isAllowed(request.url)))
    return failure("blocked_host", "Browser host is not allowlisted.")
  if (!(request.op === "navigate" && url === "about:blank") && (!browserPageURL(url) || !isAllowed(url)))
    return failure("blocked_host", "Browser host is not allowlisted.")
  if (busy.has(tab.id)) return failure("unavailable", "Another operation is running on this tab.")
  const blocked = browserInputFailure(contents)
  if (blocked) return blocked
  if (!navigating && contents.isLoadingMainFrame())
    return failure("unavailable", "Browser page is loading. Wait for loading to finish.")

  const ownerID = tab.ownerID
  const hosts = hostPolicyRevision()
  const revision = tab.revision
  const accessRevision = tab.accessRevision ?? 0
  const ownerContext =
    tab.ownerContext?.() ?? createHash("sha256").update(`${tab.ownerID}:${tab.sessionID}`).digest("base64url")
  // ponytail: hash the exact source, not a truncated URL; main's epochs also detect A-B-A.
  const origin = url === "about:blank" ? url : new URL(url).origin
  const urlHash = createHash("sha256").update(url).digest("hex")
  if (parsed.op === "prepare_write")
    return success({
      tabID: tab.id,
      url: origin,
      title: "",
      visibleText: "",
      elements: [],
      context: { tabID: tab.id, origin, urlHash, revision, accessRevision, ownerContext },
    })
  if (
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
    return failure("access_denied", "Browser approval context changed. Request approval again.")
  let destination: { revision: number; url: string } | undefined
  const check = (source = false) => {
    signal.throwIfAborted()
    if (Date.now() >= deadline) throw new Error("Browser operation timed out")
    if (
      browserRegistration(message.sessionID, request.tabID) !== tab ||
      tab.contents !== contents ||
      tab.ownerID !== ownerID ||
      (tab.ownerContext?.() ?? createHash("sha256").update(`${tab.ownerID}:${tab.sessionID}`).digest("base64url")) !==
        ownerContext ||
      hostPolicyRevision() !== hosts ||
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
      throw new Error("Browser host is not allowlisted")
    if (navigating && (!browserURL(request.url) || !isAllowed(request.url)))
      throw new Error("Browser host is not allowlisted")
    if (source && request.op === "wait_for_navigation") {
      if (current !== request.url || contents.isLoadingMainFrame()) throw new Error("Browser destination changed")
      destination = { revision: tab.revision, url: current }
    }
  }
  // Screenshots observe every source transition but never veto user navigation.
  const screenshot = request.op === "screenshot"
  const diagnostics = request.op === "observe_console"
  const siteExecution = request.op === "execute_site_tool"
  const consent = screenshot || diagnostics || siteExecution ? new AbortController() : undefined
  const revoke = () => consent?.abort()
  let ownerCheck: (() => void) | undefined
  const authority = (source = false) => {
    check(source)
    consent?.signal.throwIfAborted()
    ownerCheck?.()
  }
  if (!observing && !screenshot && !diagnostics && !siteRequest)
    tab.navigationAllowed = (url) => browserURL(url) && isAllowed(url)
  busy.add(tab.id)
  const release = keepBrowserRendering(contents)
  try {
    if (consent && !siteExecution) {
      if (screenshot) tab.screenshotConsent = consent
      if (diagnostics) tab.diagnosticConsent = consent
      signal.addEventListener("abort", revoke, { once: true })
      authority()
      const approved = diagnostics
        ? await tab.confirmDiagnostics?.(url, request.durationMs, consent.signal)
        : await tab.confirmScreenshot?.(url, consent.signal)
      ownerCheck = typeof approved === "function" ? approved : undefined
      authority()
      if (!ownerCheck)
        return failure(
          "access_denied",
          nativeT(diagnostics ? "desktop.browser.diagnosticsDenied" : "desktop.browser.screenshotDenied"),
        )
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
        return failure("access_denied", "Browser site tool approval context changed. Request approval again.")
      tab.siteToolConsent = consent
      signal.addEventListener("abort", revoke, { once: true })
      authority()
      const approved = await tab.confirmSiteTool?.(url, prepared.public, request.arguments, consent!.signal)
      ownerCheck = typeof approved === "function" ? approved : undefined
      authority()
      if (!ownerCheck) return failure("access_denied", nativeT("desktop.browser.siteToolDenied"))
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
      const frame = await executeFrame(tab, request as FrameRequest, authority, deadline, isAllowed)
      const delivery = () => {
        authority()
        frame.check()
      }
      delivery()
      onScreenshotDelivery(delivery)
      return frame.response
    }
    // Keep busy/rendering ownership until actual native settlement, even after an early reply.
    const response = diagnostics
      ? success({
          tabID: tab.id,
          url: origin,
          title: "",
          visibleText: "",
          elements: [],
          diagnostics: {
            console: await observeConsole(contents as unknown as EventEmitter, request.durationMs, authority, signal),
          },
        })
      : await execute({ tabID: tab.id, contents, check: authority, signal, deadline }, request)
    if (screenshot) authority()
    if (response.ok && request.op === "read_state") {
      const discovered = await discoverFrames(tab, authority, isAllowed)
      if (discovered) {
        const delivery = () => {
          authority()
          discovered.check()
        }
        delivery()
        onScreenshotDelivery(delivery)
        return success({ ...response.result, frames: discovered.frames })
      }
    }
    return response
  } finally {
    signal.removeEventListener("abort", revoke)
    if (consent && tab.screenshotConsent === consent) tab.screenshotConsent = undefined
    if (consent && tab.diagnosticConsent === consent) tab.diagnosticConsent = undefined
    if (consent && tab.siteToolConsent === consent) tab.siteToolConsent = undefined
    busy.delete(tab.id)
    if (!observing && !screenshot && !diagnostics && !siteRequest) tab.navigationAllowed = undefined
    release()
  }
}
