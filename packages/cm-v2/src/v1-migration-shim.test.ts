import { expect, test } from "bun:test"
import { readFileSync } from "node:fs"
import { fileURLToPath } from "node:url"

// runtime.ts runs the Bun-only V1 migration under Electron's Node by swapping its one Bun API.
test("the published V1 migration needs only the CryptoHasher shim under Node", () => {
  const file = fileURLToPath(import.meta.resolve("@opencode/core/database/v1-migration.bun"))
  const source = readFileSync(file, "utf8")
  expect(source).toContain("new Bun.CryptoHasher(")
  expect(source.replaceAll("new Bun.CryptoHasher(", "").match(/\bBun\./g)).toBeNull()
})
