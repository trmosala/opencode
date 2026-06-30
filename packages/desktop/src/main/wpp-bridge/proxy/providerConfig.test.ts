import { expect, test } from "bun:test"
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { ensureO1CodeProvider, O1_CODE_MCP, O1_CODE_PROVIDER, WPP_PROVIDER } from "./providerConfig.mjs"

async function tmpFile() {
  const dir = await mkdtemp(join(tmpdir(), "o1-config-"))
  return { dir, file: join(dir, "opencode.json") }
}

test("creates opencode.json with the provider when missing", async () => {
  const { dir, file } = await tmpFile()
  await ensureO1CodeProvider(file)
  const config = JSON.parse(await readFile(file, "utf8"))
  expect(config.$schema).toBe("https://opencode.ai/config.json")
  expect(config.provider["o1-code"]).toEqual(O1_CODE_PROVIDER)
  expect(config.provider.wpp).toEqual(WPP_PROVIDER)
  expect(config.mcp["chrome-devtools"]).toEqual(O1_CODE_MCP["chrome-devtools"])
  await rm(dir, { recursive: true, force: true })
})

test("seeds the second provider and mcp into a config that only has o1-code", async () => {
  const { dir, file } = await tmpFile()
  await writeFile(file, JSON.stringify({ provider: { "o1-code": { name: "custom" } } }))
  await ensureO1CodeProvider(file)
  const config = JSON.parse(await readFile(file, "utf8"))
  expect(config.provider["o1-code"]).toEqual({ name: "custom" }) // untouched
  expect(config.provider.wpp).toEqual(WPP_PROVIDER)
  expect(config.mcp["chrome-devtools"]).toEqual(O1_CODE_MCP["chrome-devtools"])
  await rm(dir, { recursive: true, force: true })
})

test("fully-seeded config is left byte-for-byte unchanged", async () => {
  const { dir, file } = await tmpFile()
  await ensureO1CodeProvider(file)
  const first = await readFile(file, "utf8")
  await ensureO1CodeProvider(file)
  expect(await readFile(file, "utf8")).toBe(first)
  await rm(dir, { recursive: true, force: true })
})

test("merges into an existing config without touching other keys", async () => {
  const { dir, file } = await tmpFile()
  await writeFile(file, JSON.stringify({ provider: { other: { name: "Other" } }, plugin: ["x"] }))
  await ensureO1CodeProvider(file)
  const config = JSON.parse(await readFile(file, "utf8"))
  expect(config.provider.other).toEqual({ name: "Other" })
  expect(config.provider["o1-code"]).toEqual(O1_CODE_PROVIDER)
  expect(config.plugin).toEqual(["x"])
  await rm(dir, { recursive: true, force: true })
})

test("is a no-op when the provider already exists", async () => {
  const { dir, file } = await tmpFile()
  await writeFile(file, JSON.stringify({ provider: { "o1-code": { name: "custom" } } }))
  await ensureO1CodeProvider(file)
  const config = JSON.parse(await readFile(file, "utf8"))
  expect(config.provider["o1-code"]).toEqual({ name: "custom" })
  await rm(dir, { recursive: true, force: true })
})

test("leaves an unparseable file untouched", async () => {
  const { dir, file } = await tmpFile()
  const original = '{ // comment\n  "provider": {} }'
  await writeFile(file, original)
  await ensureO1CodeProvider(file)
  expect(await readFile(file, "utf8")).toBe(original)
  await rm(dir, { recursive: true, force: true })
})
