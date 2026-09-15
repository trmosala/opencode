import { createCipheriv, createDecipheriv, randomBytes, randomUUID } from "node:crypto"
import { app, safeStorage } from "electron"
import { getStore } from "../store"
import { requireLogin, type BrowserLogin } from "./import-data"
import { vaultAccess } from "./vault-session"

type Login = BrowserLogin & { id: string }
const store = () => getStore("cm-browser")
const context = Buffer.from("CookieMonster browser vault v1")

export function vaultAvailable() {
  return (
    !app.commandLine.hasSwitch("remote-debugging-port") &&
    !app.commandLine.hasSwitch("remote-debugging-pipe") &&
    safeStorage.isEncryptionAvailable() &&
    (process.platform !== "linux" || !["basic_text", "unknown"].includes(safeStorage.getSelectedStorageBackend()))
  )
}

export function readLogins(): Login[] {
  const ticket = vaultAccess.require()
  if (!vaultAvailable()) throw new Error("Secure storage unavailable")
  const value = store().get("vault")
  if (value === undefined) return migrateLogins()
  // Never fall back to old data, or silently replace a vault that cannot be authenticated.
  try {
    if (!value || typeof value !== "object") throw new Error()
    const record = value as Record<string, unknown>
    if (record.version !== 1) throw new Error()
    const key = Buffer.from(safeStorage.decryptString(bytes(record.key)), "base64")
    try {
      const iv = bytes(record.iv)
      const tag = bytes(record.tag)
      if (key.length !== 32 || iv.length !== 12 || tag.length !== 16) throw new Error()
      const decipher = createDecipheriv("aes-256-gcm", key, iv)
      decipher.setAAD(context)
      decipher.setAuthTag(tag)
      const plain = Buffer.concat([decipher.update(bytes(record.data)), decipher.final()])
      try {
        const rows: unknown = JSON.parse(plain.toString("utf8"))
        if (!Array.isArray(rows) || rows.length > 2000) throw new Error()
        const logins = rows.map((row) => {
          if (!row || typeof row.id !== "string" || !/^[a-f\d-]{36}$/i.test(row.id)) throw new Error()
          return { id: row.id, ...requireLogin(row) }
        })
        vaultAccess.require(ticket)
        return logins
      } finally {
        plain.fill(0)
      }
    } finally {
      key.fill(0)
    }
  } catch {
    throw new Error("Saved logins could not be unlocked")
  }
}

export function writeLogins(rows: Login[]) {
  const ticket = vaultAccess.require()
  if (!vaultAvailable()) throw new Error("Secure storage unavailable")
  if (rows.length > 2000) throw new Error("Vault limit reached")
  const key = randomBytes(32)
  const plain = Buffer.from(JSON.stringify(rows))
  try {
    if (plain.length > 32 * 1024 * 1024) throw new Error("Vault size limit reached")
    const iv = randomBytes(12)
    const cipher = createCipheriv("aes-256-gcm", key, iv)
    cipher.setAAD(context)
    const data = Buffer.concat([cipher.update(plain), cipher.final()])
    // One atomic electron-store write binds origins, usernames, IDs and secrets together.
    // Fresh keys and nonces on every write avoid nonce reuse across crashes and restores.
    const vault = {
      version: 1,
      key: safeStorage.encryptString(key.toString("base64")).toString("base64"),
      iv: iv.toString("base64"),
      tag: cipher.getAuthTag().toString("base64"),
      data: data.toString("base64"),
    }
    vaultAccess.require(ticket)
    store().store = Object.fromEntries([
      ...Object.entries(store().store).filter(([key]) => key !== "credentials" && key !== "vault"),
      ["vault", vault],
    ])
  } finally {
    key.fill(0)
    plain.fill(0)
  }
}

export function clearLogins() {
  vaultAccess.lock()
  // Explicit user-confirmed deletion remains possible if the key is lost or the vault is corrupt.
  store().store = Object.fromEntries(
    Object.entries(store().store).filter(([key]) => key !== "credentials" && key !== "vault"),
  )
}

function bytes(value: unknown) {
  if (typeof value !== "string" || !value || value.length > 64 * 1024 * 1024) throw new Error()
  const buffer = Buffer.from(value, "base64")
  if (buffer.toString("base64") !== value) throw new Error()
  return buffer
}

function migrateLogins(): Login[] {
  const legacy = store().get("credentials", [])
  if (!Array.isArray(legacy) || legacy.length > 2000) throw new Error("Invalid legacy vault")
  if (!legacy.length) return []
  const rows = legacy.map((row) => ({
    id: randomUUID(),
    ...requireLogin({
      origin: row.origin,
      username: row.username,
      password: safeStorage.decryptString(bytes(row.encrypted)),
    }),
  }))
  writeLogins(rows)
  return rows
}
