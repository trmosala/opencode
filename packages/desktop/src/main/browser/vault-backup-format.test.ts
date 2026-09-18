import { expect, test } from "bun:test"
import { decryptVaultBackup, encryptVaultBackup } from "./vault-backup-format"

const rows = [
  {
    id: "00000000-0000-4000-8000-000000000001",
    origin: "https://example.test",
    username: "person",
    password: "secret",
  },
]

test("portable backup round trips without live vault IDs", async () => {
  const result = await decryptVaultBackup(
    await encryptVaultBackup(rows, "correct horse battery staple"),
    "correct horse battery staple",
  )
  expect(result).toEqual([{ origin: rows[0].origin, username: rows[0].username, password: rows[0].password }])
})

test("wrong passphrases and ciphertext tampering fail identically", async () => {
  const backup = await encryptVaultBackup(rows, "correct horse battery staple")
  await expect(decryptVaultBackup(backup, "incorrect horse battery staple")).rejects.toThrow(
    "Password backup authentication failed",
  )
  const envelope = JSON.parse(backup.toString("utf8"))
  envelope.cipher.data = Buffer.from("tampered").toString("base64")
  await expect(
    decryptVaultBackup(Buffer.from(JSON.stringify(envelope)), "correct horse battery staple"),
  ).rejects.toThrow("Password backup authentication failed")
})

test("header tampering, unknown fields and weak passphrases are rejected", async () => {
  const backup = await encryptVaultBackup(rows, "correct horse battery staple")
  const header = JSON.parse(backup.toString("utf8"))
  header.kdf.N /= 2
  await expect(
    decryptVaultBackup(Buffer.from(JSON.stringify(header)), "correct horse battery staple"),
  ).rejects.toThrow()
  const unknown = JSON.parse(backup.toString("utf8"))
  unknown.recoveryHint = "leak"
  await expect(
    decryptVaultBackup(Buffer.from(JSON.stringify(unknown)), "correct horse battery staple"),
  ).rejects.toThrow()
  await expect(encryptVaultBackup(rows, "too short")).rejects.toThrow()
})
