import { createHash } from "node:crypto"
import {
  OPERATION_TIMEOUT_MS,
  failure,
  success,
  parseRequest,
  type BrowserIpcRequest,
  type BrowserState,
  type Response,
} from "@cookiemonster/cm-browser/protocol"
import { allowed } from "./allowlist"
import { browserInputFailure, execute } from "./driver"
import { browserTabs, browserRegistration, browserAgentEnabled, routeBrowserHistory } from "./registry"
import { browserURL, browserPageURL } from "./policy"
import { keepBrowserRendering } from "./rendering"

const busy = new Set<string>()

export type BrowserOperation = {
  signal?: AbortSignal
  deadline?: number
  onSettled?: (operation: Promise<unknown>) => void
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
  const operation = route(message, isAllowed, controller.signal, deadline)
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
    return await Promise.race([operation, cancelled])
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
): Promise<Response<BrowserState>> {
  signal.throwIfAborted()
  const parsed = parseRequest(message.request)
  if (!parsed) return failure("bad_request", "Invalid browser request.")
  const request = parsed.op === "prepare_write" ? parsed.request : parsed
  if (!browserAgentEnabled()) return failure("access_denied", "Browser agent access is disabled in browser settings.")
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
  const revision = tab.revision
  const accessRevision = tab.accessRevision ?? 0
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
      context: { tabID: tab.id, origin, urlHash, revision, accessRevision },
    })
  if (
    request.op !== "read_state" &&
    !observing &&
    (!("context" in parsed) ||
      parsed.context.tabID !== tab.id ||
      parsed.context.origin !== origin ||
      parsed.context.urlHash !== urlHash ||
      parsed.context.revision !== revision ||
      parsed.context.accessRevision !== accessRevision)
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
      !browserAgentEnabled() ||
      !tab.agentAccess ||
      (tab.accessRevision ?? 0) !== accessRevision ||
      contents.isDestroyed() ||
      ((observing || request.op === "scroll") && browserInputFailure(contents)) ||
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
  // Observation must not veto an independently initiated user navigation.
  if (!observing) tab.navigationAllowed = (url) => browserURL(url) && isAllowed(url)
  busy.add(tab.id)
  // CDP input needs current compositor hit-test data, including for background tabs.
  const release = keepBrowserRendering(contents)
  try {
    // Do not race native settlement here: cancelled calls may still act until their promise settles.
    return await execute({ tabID: tab.id, contents, check, signal, deadline }, request)
  } finally {
    busy.delete(tab.id)
    if (!observing) tab.navigationAllowed = undefined
    release()
  }
}
