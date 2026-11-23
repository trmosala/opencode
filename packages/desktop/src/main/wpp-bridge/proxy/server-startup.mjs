export const COOKIEMONSTER_BRIDGE_EXECUTOR = "worker-pool"

export function shouldIgnoreListenError(error) {
  return error?.code === "EADDRINUSE"
}

// CookieMonster's Electron bridge advertises executor:"worker-pool". The legacy wpp-chat-cli
// extension queue does not — treating any :8787 occupant as "us" silently attaches OpenCode to a
// dead queue and surfaces o1_code_extension_timeout after 15 minutes.
export function isCookieMonsterBridgeHealth(body) {
  return Boolean(
    body && typeof body === "object" && body.ok === true && body.executor === COOKIEMONSTER_BRIDGE_EXECUTOR,
  )
}

// "ours": a bridge that accepts this launch's token. "cookiemonster": another CookieMonster launch (another user
// or a dev build beside the packaged app), which refuses our token. "foreign": anything else on the port.
export async function probeProxyOccupant(
  host,
  port,
  { fetchImpl = globalThis.fetch, timeoutMs = 1500, token = "" } = {},
) {
  if (typeof fetchImpl !== "function") return "foreign"
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  try {
    const response = await fetchImpl(`http://${host}:${port}/bridge/health`, {
      method: "GET",
      headers: { authorization: `Bearer ${token}` },
      signal: controller.signal,
    })
    const body = await response?.json?.().catch(() => undefined)
    if (response?.ok) return isCookieMonsterBridgeHealth(body) ? "ours" : "foreign"
    return response?.status === 401 && body?.error?.type === "unauthorized" ? "cookiemonster" : "foreign"
  } catch {
    return "foreign"
  } finally {
    clearTimeout(timer)
  }
}

export function proxyInstanceConflictError(host, port) {
  const error = new Error(
    `Port ${host}:${port} is already used by another CookieMonster (another user or build on this computer). ` +
      `Quit the other CookieMonster and relaunch this one.`,
  )
  error.statusCode = 500
  error.code = "EADDRINUSE"
  error.type = "o1_code_proxy_instance_conflict"
  return error
}

export function proxyPortConflictError(host, port) {
  const error = new Error(
    `Port ${host}:${port} is occupied by a non-CookieMonster O1-Code proxy ` +
      `(missing executor="${COOKIEMONSTER_BRIDGE_EXECUTOR}"). ` +
      `Stop the other process (often wpp-chat-cli's o1-code-openai-proxy) and relaunch CookieMonster.`,
  )
  error.statusCode = 500
  error.code = "EADDRINUSE"
  error.type = "o1_code_proxy_port_conflict"
  return error
}
