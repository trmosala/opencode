import {
  MAX_URL_LENGTH,
  OPERATION_TIMEOUT_MS,
  failure,
  type BrowserIpcRequest,
  type BrowserState,
  type Response,
} from "@cookiemonster/cm-browser/protocol"
import { allowed } from "./allowlist"
import { execute } from "./driver"
import { resolveBrowserTarget } from "./registry"

export async function routeBrowserRequest(
  message: BrowserIpcRequest,
  isAllowed: (url: string) => boolean = allowed,
): Promise<Response<BrowserState>> {
  const target = resolveBrowserTarget(message.sessionID)
  if (!target) return failure("no_target", "No browser panel is registered for this session.")

  const destination = message.request.op === "navigate" ? message.request.url : target.contents.getURL()
  if (destination.length > MAX_URL_LENGTH) return failure("bad_request", "Browser URL is too long.")
  if (!isAllowed(destination)) return failure("blocked_host", `Browser host is not allowlisted: ${destination}`)

  return Promise.race([
    execute(target, message.request),
    new Promise<Response<BrowserState>>((resolve) => {
      setTimeout(() => resolve(failure("timeout", "Browser operation timed out.")), OPERATION_TIMEOUT_MS).unref()
    }),
  ])
}
