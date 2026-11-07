import type { ServerConnection } from "@/context/server"
import { authTokenFromCredentials } from "./server"

// CookieMonster sidecar extensions (same listener, Basic auth and origin policy as /api; owned by packages/cm-v2).
// Exact skill identity for selection:
export type ManagedSkill = { name: string; description?: string; source: string; revision: string }

function isManagedSkill(value: unknown): value is ManagedSkill {
  if (!value || typeof value !== "object") return false
  const item = value as Record<string, unknown>
  return (
    typeof item.name === "string" &&
    typeof item.source === "string" &&
    typeof item.revision === "string" &&
    (item.description === undefined || typeof item.description === "string")
  )
}

export function createExtensionClient(
  server: ServerConnection.HttpBase,
  fetcher: (input: RequestInfo | URL, init?: RequestInit) => Promise<Response> = fetch,
) {
  const request = async (path: string, directory: string, body?: unknown) => {
    const url = new URL(path, server.url.replace(/\/?$/, "/"))
    url.searchParams.set("directory", directory)
    const response = await fetcher(url, {
      method: body === undefined ? "GET" : "POST",
      headers: {
        ...(body === undefined ? {} : { "Content-Type": "application/json" }),
        ...(server.password
          ? {
              Authorization: `Basic ${authTokenFromCredentials({ username: server.username, password: server.password })}`,
            }
          : {}),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    })
    const data: unknown = await response.json().catch(() => undefined)
    if (!response.ok) {
      const message =
        data && typeof data === "object" && "message" in data && typeof data.message === "string"
          ? data.message
          : response.statusText
      throw new Error(message)
    }
    return data
  }
  const skills = {
    // Servers without the extension (official 2.2.5, V1) have no managed catalog.
    catalog: (directory: string) =>
      request("skill/catalog", directory).then(
        (data) => (Array.isArray(data) ? data.filter(isManagedSkill) : []),
        () => [] as ManagedSkill[],
      ),
    select: (directory: string, sessionID: string, selected: ManagedSkill[]) =>
      request("skill/select", directory, {
        sessionID,
        selected: selected.map((item) => ({ name: item.name, source: item.source, revision: item.revision })),
      }),
  }
  const worktree = {
    // 2.2.5 has no native reset; generic V2 servers without the extension fail like any request.
    reset: async (root: string, directory: string) => (await request("worktree/reset", root, { directory })) === true,
  }
  return { skills, worktree }
}

export type ExtensionClient = ReturnType<typeof createExtensionClient>
export type ManagedSkillClient = ExtensionClient["skills"]
