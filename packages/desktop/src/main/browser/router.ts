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
import { execute } from "./driver"
import { browserTabs, browserRegistration, browserAgentEnabled, routeBrowserHistory } from "./registry"
import { browserURL, browserPageURL } from "./policy"
import { keepBrowserRendering } from "./rendering"

const busy = new Set<string>()

export async function routeBrowserRequest(
  message: BrowserIpcRequest,
  isAllowed: (url: string) => boolean = allowed,
): Promise<Response<BrowserState>> {
  const parsed = parseRequest(message.request)
  if (!parsed) return failure("bad_request", "Invalid browser request.")
  const request = parsed.op === "prepare_write" ? parsed.request : parsed
  if (!browserAgentEnabled()) return failure("access_denied", "Browser agent access is disabled in browser settings.")
  if (request.op === "search_history" || request.op === "open_history")
    return routeBrowserHistory(message.sessionID, request)
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
  const url = tab.contents.getURL()
  if (request.op === "navigate" && (!browserURL(request.url) || !isAllowed(request.url)))
    return failure("blocked_host", "Browser host is not allowlisted.")
  if (!(request.op === "navigate" && url === "about:blank") && (!browserPageURL(url) || !isAllowed(url)))
    return failure("blocked_host", "Browser host is not allowlisted.")
  if (busy.has(tab.id)) return failure("unavailable", "Another operation is running on this tab.")
  if (request.op !== "navigate" && tab.contents.isLoadingMainFrame())
    return failure("unavailable", "Browser page is loading. Wait for loading to finish.")

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
    (!("context" in parsed) ||
      parsed.context.tabID !== tab.id ||
      parsed.context.origin !== origin ||
      parsed.context.urlHash !== urlHash ||
      parsed.context.revision !== revision ||
      parsed.context.accessRevision !== accessRevision)
  )
    return failure("access_denied", "Browser approval context changed. Request approval again.")
  const deadline = Date.now() + OPERATION_TIMEOUT_MS
  const check = (source = false) => {
    if (Date.now() >= deadline) throw new Error("Browser operation timed out")
    if (
      !browserAgentEnabled() ||
      !tab.agentAccess ||
      (tab.accessRevision ?? 0) !== accessRevision ||
      tab.contents.isDestroyed() ||
      ((source || request.op !== "navigate") && (tab.revision !== revision || tab.contents.getURL() !== url)) ||
      (request.op !== "navigate" && tab.contents.isLoadingMainFrame())
    )
      throw new Error("Browser access changed")
    const current = tab.contents.getURL()
    if (!(request.op === "navigate" && current === "about:blank") && (!browserPageURL(current) || !isAllowed(current)))
      throw new Error("Browser host is not allowlisted")
    // The driver's final source check is synchronous with loadURL, after old-load cancellation.
    if (source && request.op === "navigate" && (!browserURL(request.url) || !isAllowed(request.url)))
      throw new Error("Browser host is not allowlisted")
  }
  tab.navigationAllowed = (url) => browserURL(url) && isAllowed(url)
  busy.add(tab.id)
  // CDP input needs current compositor hit-test data, including for background tabs.
  const release = keepBrowserRendering(tab.contents)
  const operation = execute({ tabID: tab.id, contents: tab.contents, check }, request)
    .catch(() => failure("unavailable", "Browser operation interrupted or unavailable."))
    .finally(() => {
      busy.delete(tab.id)
      tab.navigationAllowed = undefined
      release()
    })
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    return await Promise.race([
      operation,
      new Promise<Response<BrowserState>>((resolve) => {
        timer = setTimeout(() => resolve(failure("timeout", "Browser operation timed out.")), OPERATION_TIMEOUT_MS)
      }),
    ])
  } finally {
    clearTimeout(timer)
  }
}
