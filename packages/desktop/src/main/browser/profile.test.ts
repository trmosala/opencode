import { expect, test } from "bun:test"
import { clearCookies } from "./browser-storage"

test("clearing cookies preserves other storage categories", async () => {
  const calls: unknown[] = []
  const profile = {
    clearStorageData: async (options: unknown) => {
      calls.push(options)
    },
    clearAuthCache: async () => {
      calls.push("auth")
    },
  }

  await clearCookies(profile)

  expect(calls).toEqual([{ storages: ["cookies"] }, "auth"])
})
