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
import { browserURL } from "./policy"
import { keepBrowserRendering } from "./rendering"

const busy = new Set<string>()

export async function routeBrowserRequest(
  message: BrowserIpcRequest,
  isAllowed: (url: string) => boolean = allowed,
): Promise<Response<BrowserState>> {
  const request = parseRequest(message.request)
  if (!request) return failure("bad_request", "Invalid browser request.")
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
          (tab) => tab.agentAccess && (tab.contents.getURL() === "about:blank" || isAllowed(tab.contents.getURL())),
        )
        .map((tab) => ({ tabID: tab.id, url: tab.contents.getURL(), title: "" })),
    })
  }
  const tab = browserRegistration(message.sessionID, request.tabID)
  if (!tab) return failure("no_target", "Browser tab not found in this session.")
  if (!tab.agentAccess) return failure("access_denied", "Enable agent access for this tab in the browser panel.")
  const destination = request.op === "navigate" ? request.url : tab.contents.getURL()
  if (!browserURL(destination) || !isAllowed(destination))
    return failure("blocked_host", "Browser host is not allowlisted.")
  if (busy.has(tab.id)) return failure("unavailable", "Another operation is running on this tab.")

  const revision = tab.revision
  const accessRevision = tab.accessRevision
  const deadline = Date.now() + OPERATION_TIMEOUT_MS
  const check = () => {
    if (Date.now() >= deadline) throw new Error("Browser operation timed out")
    if (
      !browserAgentEnabled() ||
      !tab.agentAccess ||
      tab.accessRevision !== accessRevision ||
      tab.contents.isDestroyed() ||
      (request.op !== "navigate" && tab.revision !== revision)
    )
      throw new Error("Browser access changed")
    const url = tab.contents.getURL()
    if (!(request.op === "navigate" && url === "about:blank") && !isAllowed(url))
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
