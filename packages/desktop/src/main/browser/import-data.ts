import { randomUUID } from "node:crypto"
import { isIP } from "node:net"
import type { CookiesSetDetails } from "electron"

export function mergeLogins(current: (BrowserLogin & { id: string })[], imported: BrowserLogin[]) {
  const batch = new Map(
    imported.map((row) => {
      const login = requireLogin(row)
      return [JSON.stringify([login.origin, login.username]), login] as const
    }),
  )
  const next = new Map(current.map((row) => [JSON.stringify([row.origin, row.username]), row]))
  let add = 0
  let replace = 0
  let unchanged = 0
  for (const [key, row] of batch) {
    const previous = next.get(key)
    if (previous?.password === row.password) {
      unchanged++
      continue
    }
    if (previous) replace++
    else add++
    next.set(key, { ...row, id: previous?.id ?? randomUUID() })
  }
  if (next.size > 2000) throw new Error("Vault limit reached")
  return {
    rows: [...next.values()],
    valid: imported.length,
    duplicate: imported.length - batch.size,
    add,
    replace,
    unchanged,
    unsupported: 0,
  }
}

export type BrowserLogin = { origin: string; username: string; password: string }

export function loginOrigin(value: string) {
  const url = new URL(value)
  if (
    url.username ||
    url.password ||
    (url.protocol !== "https:" &&
      !(url.protocol === "http:" && ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname)))
  )
    throw new Error("Login requires HTTPS")
  return url.origin
}

export function requireLogin(value: unknown): BrowserLogin {
  if (!value || typeof value !== "object") throw new Error("Invalid login")
  const row = value as Record<string, unknown>
  if (
    typeof row.origin !== "string" ||
    typeof row.username !== "string" ||
    typeof row.password !== "string" ||
    !row.password ||
    row.username.length > 4096 ||
    row.password.length > 16384
  )
    throw new Error("Invalid login")
  return { origin: loginOrigin(row.origin), username: row.username, password: row.password }
}

export async function parsePasswordCSV(text: string) {
  const { parse } = await import("csv-parse/sync")
  try {
    const rows: unknown = parse(text, { bom: true, columns: true, skip_empty_lines: true, max_record_size: 32768 })
    if (!Array.isArray(rows) || rows.length > 2000 || !rows.length) throw new Error()
    return rows.map((row) => requireLogin({ origin: row.url, username: row.username, password: row.password }))
  } catch {
    // CSV parser errors can include raw records. Never send credentials back in IPC errors.
    throw new Error("Invalid password import")
  }
}

export function parseCookieJSON(text: string): CookiesSetDetails[] {
  let rows: unknown
  try {
    rows = JSON.parse(text)
  } catch {
    throw new Error("Invalid cookie import")
  }
  if (!Array.isArray(rows) || rows.length > 5000 || !rows.length) throw new Error("Invalid cookie import")
  return rows.map((row) => {
    if (
      !row ||
      typeof row !== "object" ||
      typeof row.name !== "string" ||
      typeof row.value !== "string" ||
      typeof row.domain !== "string" ||
      !row.domain ||
      row.name.length + row.value.length > 8192
    )
      throw new Error("Invalid cookie")
    // Unknown scope fields (including partition/container keys) must not become broader cookies.
    if (
      Object.keys(row).some(
        (key) =>
          ![
            "name",
            "value",
            "domain",
            "path",
            "secure",
            "httpOnly",
            "hostOnly",
            "sameSite",
            "expirationDate",
            "session",
          ].includes(key),
      )
    )
      throw new Error("Unsupported cookie scope")
    if (
      ["secure", "httpOnly", "hostOnly", "session"].some(
        (key) => row[key] !== undefined && typeof row[key] !== "boolean",
      )
    )
      throw new Error("Invalid cookie flags")
    if (row.sameSite !== undefined && !["no_restriction", "strict", "lax", "unspecified"].includes(row.sameSite))
      throw new Error("Unsupported cookie scope")
    if (/[\x00-\x20\x7f;,=]/.test(row.name) || /[\x00-\x1f\x7f;]/.test(row.value)) throw new Error("Invalid cookie")
    const host = row.domain.replace(/^\./, "")
    if (!/^[a-z\d.-]+$/i.test(host)) throw new Error("Invalid cookie domain")
    const url = new URL(`${row.secure === false ? "http" : "https"}://${host}/`)
    if (url.hostname !== host.toLowerCase()) throw new Error("Invalid cookie domain")
    if (row.path !== undefined && (typeof row.path !== "string" || !row.path.startsWith("/")))
      throw new Error("Invalid cookie path")
    if (
      row.expirationDate !== undefined &&
      (typeof row.expirationDate !== "number" || !Number.isFinite(row.expirationDate))
    )
      throw new Error("Invalid cookie expiry")
    const sameSite =
      row.sameSite === "no_restriction"
        ? "no_restriction"
        : row.sameSite === "strict"
          ? "strict"
          : row.sameSite === "lax"
            ? "lax"
            : "unspecified"
    return {
      url: url.href,
      name: row.name,
      value: row.value,
      // Chromium stores IP Domain attributes as host-only; use that identity before review.
      ...(row.hostOnly || isIP(host) ? {} : { domain: row.domain }),
      path: row.path ?? "/",
      secure: row.secure !== false,
      httpOnly: row.httpOnly === true,
      ...(row.session ? {} : { expirationDate: row.expirationDate }),
      sameSite,
    }
  })
}
