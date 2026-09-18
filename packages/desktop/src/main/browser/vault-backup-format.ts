import crypto from "node:crypto"
import { loginOrigin, requireLogin, type BrowserLogin } from "./import-data"

const FORMAT = "cookiemonster-password-backup"
const PAYLOAD_FORMAT = "cookiemonster-password-backup-payload"
const CONTEXT = "CookieMonster portable password backup v1"
const MAX_BACKUP_BYTES = 5 * 1024 * 1024
const MAX_LOGINS = 2000
const SCRYPT_N = 65536
const SCRYPT_R = 8
const SCRYPT_P = 1

type Header = {
  format: typeof FORMAT
  version: 1
  kdf: { name: "scrypt"; salt: string; N: typeof SCRYPT_N; r: typeof SCRYPT_R; p: typeof SCRYPT_P; keyLength: 32 }
  cipher: { name: "aes-256-gcm"; iv: string }
}

type Envelope = Header & { cipher: Header["cipher"] & { tag: string; data: string } }

export async function encryptVaultBackup(
  logins: BrowserLogin[],
  passphrase: string,
  createdAt = new Date().toISOString(),
) {
  requirePassphrase(passphrase)
  if (logins.length > MAX_LOGINS) throw new Error("Password backup limit exceeded")
  const payload = Buffer.from(
    JSON.stringify({
      format: PAYLOAD_FORMAT,
      version: 1,
      createdAt,
      logins: logins.map((login) => {
        const row = requireLogin(login)
        return { origin: row.origin, username: row.username, password: row.password }
      }),
    }),
  )
  if (payload.length > MAX_BACKUP_BYTES) throw new Error("Password backup limit exceeded")
  const salt = crypto.randomBytes(32)
  const iv = crypto.randomBytes(12)
  const header: Header = {
    format: FORMAT,
    version: 1,
    kdf: {
      name: "scrypt",
      salt: salt.toString("base64"),
      N: SCRYPT_N,
      r: SCRYPT_R,
      p: SCRYPT_P,
      keyLength: 32,
    },
    cipher: { name: "aes-256-gcm", iv: iv.toString("base64") },
  }
  const key = await deriveKey(passphrase, salt)
  try {
    const cipher = crypto.createCipheriv("aes-256-gcm", key, iv)
    cipher.setAAD(aad(header), { plaintextLength: payload.length })
    const data = Buffer.concat([cipher.update(payload), cipher.final()])
    const envelope: Envelope = {
      ...header,
      cipher: { ...header.cipher, tag: cipher.getAuthTag().toString("base64"), data: data.toString("base64") },
    }
    const result = Buffer.from(JSON.stringify(envelope, undefined, 2) + "\n")
    if (result.length > MAX_BACKUP_BYTES) throw new Error("Password backup limit exceeded")
    return result
  } finally {
    key.fill(0)
    payload.fill(0)
  }
}

export async function decryptVaultBackup(bytes: Buffer, passphrase: string): Promise<BrowserLogin[]> {
  requirePassphrase(passphrase)
  if (!bytes.length || bytes.length > MAX_BACKUP_BYTES) throw new Error("Invalid password backup")
  const envelope = requireEnvelope(JSON.parse(bytes.toString("utf8")))
  const salt = canonicalBase64(envelope.kdf.salt, 32)
  const iv = canonicalBase64(envelope.cipher.iv, 12)
  const tag = canonicalBase64(envelope.cipher.tag, 16)
  const data = canonicalBase64(envelope.cipher.data)
  if (!data.length || data.length > MAX_BACKUP_BYTES) throw new Error("Invalid password backup")
  const key = await deriveKey(passphrase, salt)
  let plaintext = Buffer.alloc(0)
  try {
    const decipher = crypto.createDecipheriv("aes-256-gcm", key, iv)
    decipher.setAAD(aad(envelope), { plaintextLength: data.length })
    decipher.setAuthTag(tag)
    plaintext = Buffer.concat([decipher.update(data), decipher.final()])
    if (plaintext.length > MAX_BACKUP_BYTES) throw new Error()
    const payload = requirePayload(JSON.parse(plaintext.toString("utf8")))
    return payload.logins.map(requireLogin)
  } catch {
    throw new Error("Password backup authentication failed")
  } finally {
    key.fill(0)
    plaintext.fill(0)
  }
}

function aad(header: Header) {
  return Buffer.from(
    JSON.stringify({
      context: CONTEXT,
      format: header.format,
      version: header.version,
      kdf: header.kdf,
      cipher: { name: header.cipher.name, iv: header.cipher.iv },
    }),
  )
}

function deriveKey(passphrase: string, salt: Buffer) {
  return new Promise<Buffer>((resolve, reject) => {
    crypto.scrypt(
      passphrase.normalize("NFKC"),
      salt,
      32,
      { N: SCRYPT_N, r: SCRYPT_R, p: SCRYPT_P, maxmem: 128 * 1024 * 1024 },
      (error, key) => {
        if (error) return reject(error)
        resolve(key)
      },
    )
  })
}

function requirePassphrase(value: string) {
  if (typeof value !== "string" || value.length < 12 || value.length > 256 || /[\u0000]/.test(value))
    throw new Error("Backup passphrase must contain 12 to 256 characters")
}

function canonicalBase64(value: unknown, length?: number) {
  if (typeof value !== "string" || !value.length || value.length > MAX_BACKUP_BYTES * 2) throw new Error()
  const result = Buffer.from(value, "base64")
  if (result.toString("base64") !== value || (length !== undefined && result.length !== length)) throw new Error()
  return result
}

function requireEnvelope(value: unknown): Envelope {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error()
  const envelope = value as Record<string, unknown>
  if (!exactKeys(envelope, ["format", "version", "kdf", "cipher"])) throw new Error()
  if (envelope.format !== FORMAT || envelope.version !== 1) throw new Error()
  if (!envelope.kdf || typeof envelope.kdf !== "object" || Array.isArray(envelope.kdf)) throw new Error()
  if (!envelope.cipher || typeof envelope.cipher !== "object" || Array.isArray(envelope.cipher)) throw new Error()
  const kdf = envelope.kdf as Record<string, unknown>
  const cipher = envelope.cipher as Record<string, unknown>
  if (!exactKeys(kdf, ["name", "salt", "N", "r", "p", "keyLength"])) throw new Error()
  if (!exactKeys(cipher, ["name", "iv", "tag", "data"])) throw new Error()
  if (
    kdf.name !== "scrypt" ||
    kdf.N !== SCRYPT_N ||
    kdf.r !== SCRYPT_R ||
    kdf.p !== SCRYPT_P ||
    kdf.keyLength !== 32 ||
    cipher.name !== "aes-256-gcm" ||
    typeof kdf.salt !== "string" ||
    typeof cipher.iv !== "string" ||
    typeof cipher.tag !== "string" ||
    typeof cipher.data !== "string"
  )
    throw new Error()
  return envelope as Envelope
}

function requirePayload(value: unknown) {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error()
  const payload = value as Record<string, unknown>
  if (!exactKeys(payload, ["format", "version", "createdAt", "logins"])) throw new Error()
  if (
    payload.format !== PAYLOAD_FORMAT ||
    payload.version !== 1 ||
    typeof payload.createdAt !== "string" ||
    !Number.isFinite(Date.parse(payload.createdAt)) ||
    !Array.isArray(payload.logins) ||
    payload.logins.length > MAX_LOGINS
  )
    throw new Error()
  const logins = payload.logins.map((value) => {
    if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error()
    const row = value as Record<string, unknown>
    if (!exactKeys(row, ["origin", "username", "password"])) throw new Error()
    if (typeof row.origin !== "string" || loginOrigin(row.origin) !== row.origin) throw new Error()
    return { origin: row.origin, username: row.username, password: row.password }
  })
  return { logins }
}

function exactKeys(value: Record<string, unknown>, keys: string[]) {
  const actual = Object.keys(value).sort()
  const expected = [...keys].sort()
  return actual.length === expected.length && actual.every((key, index) => key === expected[index])
}
