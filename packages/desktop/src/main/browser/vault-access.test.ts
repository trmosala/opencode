import { expect, test } from "bun:test"
import { createVaultAccess } from "./vault-access"

test("locked by default; only successful OS verification unlocks; expiry is synchronous", async () => {
  let time = 100
  const access = createVaultAccess(
    async () => {},
    () => time,
    1000,
  )
  expect(access.status()).toBe("locked")
  expect(() => access.require()).toThrow()
  await access.unlock(undefined)
  const ticket = access.require()
  time = 1099
  expect(access.require(ticket)).toBe(ticket)
  time = 1100
  expect(() => access.require(ticket)).toThrow()
  expect(access.status()).toBe("locked")
})

test("authentication failure never opens the vault", async () => {
  const access = createVaultAccess(async () => {
    throw new Error("cancelled")
  })
  await expect(access.unlock(undefined)).rejects.toThrow()
  expect(access.status()).toBe("locked")
})

test("lock invalidates pending verification and prior operation tickets, even after another unlock", async () => {
  const verification = Promise.withResolvers<void>()
  const access = createVaultAccess(() => verification.promise)
  const pending = access.unlock(undefined)
  expect(access.status()).toBe("unlocking")
  await expect(access.unlock(undefined)).rejects.toThrow()
  access.lock()
  verification.resolve()
  await expect(pending).rejects.toThrow()
  expect(access.status()).toBe("locked")
  await access.unlock(undefined)
  const ticket = access.require()
  access.lock()
  await access.unlock(undefined)
  expect(() => access.require(ticket)).toThrow()
  access.lock()
})
