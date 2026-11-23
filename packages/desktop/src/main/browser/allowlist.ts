// Test-only host policy for the native smoke fixtures, which pass `allowed` to routeBrowserRequest's optional
// policy seam to exercise destination/receiver revocation races. Production never uses it: the bridge routes without
// a policy, and authority is the per-tab Agent Access grant in registry.ts. In memory only, so running a fixture
// never writes into the user's state directory.

import { DEFAULT_ALLOWLIST, hostAllowed } from "@cookiemonster/cm-browser/protocol"

const hosts = new Set(DEFAULT_ALLOWLIST)

export const allowed = (url: string) => hostAllowed(url, [...hosts])

export function updateAgentHost(value: string, remove = false) {
  if (typeof value !== "string" || typeof remove !== "boolean") throw new Error("Invalid host")
  const host = value.trim().toLowerCase()
  if (
    !host ||
    host.length > 253 ||
    !/^(?:localhost|(?:[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\.)+[a-z0-9](?:[a-z0-9-]*[a-z0-9])?)$/.test(host)
  )
    throw new Error("Enter a hostname without a scheme, path, port, or wildcard")
  if (remove) {
    hosts.delete(host)
    return
  }
  if (!hosts.has(host) && hosts.size >= 200) throw new Error("Host limit reached")
  hosts.add(host)
}
