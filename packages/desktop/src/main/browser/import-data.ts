import type { CookiesSetDetails } from "electron"

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
  const rows: unknown = JSON.parse(text)
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
      ...(row.hostOnly ? {} : { domain: row.domain }),
      path: row.path ?? "/",
      secure: row.secure !== false,
      httpOnly: row.httpOnly === true,
      ...(row.session ? {} : { expirationDate: row.expirationDate }),
      sameSite,
    }
  })
}
