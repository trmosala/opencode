import { randomUUID } from "node:crypto"
import { safeStorage } from "electron"
import { CONTACT_FIELDS, type BrowserContact } from "@opencode-ai/app/browser-panel"
import { getStore } from "../store"
import { vaultAvailable } from "./vault"
import { vaultAccess } from "./vault-session"

export function requireContact(value: unknown): BrowserContact {
  if (!value || typeof value !== "object") throw new Error("Invalid contact")
  const row = value as Record<string, unknown>
  if (
    typeof row.id !== "string" ||
    !/^[a-f\d-]{36}$/i.test(row.id) ||
    typeof row.revision !== "string" ||
    !/^[a-f\d-]{36}$/i.test(row.revision) ||
    typeof row.label !== "string" ||
    !row.label.trim() ||
    row.label.length > 100 ||
    /[\x00-\x1f\x7f]/.test(row.label) ||
    !row.values ||
    typeof row.values !== "object" ||
    Array.isArray(row.values)
  )
    throw new Error("Invalid contact")
  const values = Object.fromEntries(
    Object.entries(row.values).map(([key, entry]) => {
      if (
        !CONTACT_FIELDS.some((field) => field === key) ||
        typeof entry !== "string" ||
        entry.length > 1000 ||
        /[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/.test(entry) ||
        (key !== "street-address" && /[\r\n]/.test(entry)) ||
        (key === "country" && entry !== "" && !/^[A-Z]{2}$/.test(entry))
      )
        throw new Error("Invalid contact")
      return [key, entry]
    }),
  )
  if (!Object.values(values).some((entry) => entry.trim())) throw new Error("Empty contact")
  return { id: row.id, revision: row.revision, label: row.label.trim(), values }
}

export function readContacts(): BrowserContact[] {
  vaultAccess.require()
  if (!vaultAvailable()) throw new Error("Secure storage unavailable")
  const stored = getStore("cm-browser").get("contacts")
  if (stored === undefined) return []
  try {
    if (typeof stored !== "string" || stored.length > 8 * 1024 * 1024) throw new Error()
    const bytes = Buffer.from(stored, "base64")
    if (bytes.toString("base64") !== stored) throw new Error()
    const rows: unknown = JSON.parse(safeStorage.decryptString(bytes))
    if (!Array.isArray(rows) || rows.length > 100) throw new Error()
    const contacts = rows.map(requireContact)
    if (new Set(contacts.map((row) => row.id)).size !== contacts.length) throw new Error()
    return contacts
  } catch {
    throw new Error("Saved contacts could not be unlocked")
  }
}

export function contactSummary() {
  if (vaultAccess.status() !== "unlocked") return { contacts: [] }
  try {
    return { contacts: readContacts() }
  } catch {
    return { contacts: [], contactsUnavailable: true }
  }
}

export function saveContact(value: unknown, create: boolean) {
  if (typeof create !== "boolean") throw new Error("Invalid contact operation")
  const row = requireContact(value)
  const rows = readContacts()
  const current = rows.find((entry) => entry.id === row.id)
  if (create ? !!current : !current || current.revision !== row.revision) throw new Error("Contact changed")
  if (!current && rows.length >= 100) throw new Error("Contact limit reached")
  writeContacts([{ ...row, revision: randomUUID() }, ...rows.filter((entry) => entry.id !== row.id)])
}

export function deleteContact(id: string, revision: string) {
  const rows = readContacts()
  const current = rows.find((row) => row.id === id)
  if (!current || current.revision !== revision) throw new Error("Contact changed")
  writeContacts(rows.filter((row) => row.id !== id))
}

function writeContacts(rows: BrowserContact[]) {
  const ticket = vaultAccess.require()
  const encrypted = safeStorage.encryptString(JSON.stringify(rows)).toString("base64")
  vaultAccess.require(ticket)
  getStore("cm-browser").set("contacts", encrypted)
}
