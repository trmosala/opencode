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

export async function probeCookieMonsterBridgeOccupant(
  host,
  port,
  { fetchImpl = globalThis.fetch, timeoutMs = 1500 } = {},
) {
  if (typeof fetchImpl !== "function") return false
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  try {
    const response = await fetchImpl(`http://${host}:${port}/bridge/health`, {
      method: "GET",
      signal: controller.signal,
    })
    if (!response?.ok) return false
    return isCookieMonsterBridgeHealth(await response.json())
  } catch {
    return false
  } finally {
    clearTimeout(timer)
  }
}

export function proxyPortConflictError(host, port) {
  const error = new Error(
    `Port ${host}:${port} is occupied by a non-CookieMonster O1-Code proxy `
      + `(missing executor="${COOKIEMONSTER_BRIDGE_EXECUTOR}"). `
      + `Stop the other process (often wpp-chat-cli's o1-code-openai-proxy) and relaunch CookieMonster.`,
  )
  error.statusCode = 500
  error.code = "EADDRINUSE"
  error.type = "o1_code_proxy_port_conflict"
  return error
}
