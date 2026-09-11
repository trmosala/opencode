import { expect, test } from "bun:test"
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { MODEL_IDS } from "./modelProfiles.mjs"
import {
  COOKIE_MONSTER_PROVIDER,
  ensureO1CodeProvider,
  O1_CODE_MCP,
  o1CodeConfigContent,
  WPP_PROVIDER,
} from "./providerConfig.mjs"

async function tmpFile() {
  const dir = await mkdtemp(join(tmpdir(), "cm-config-"))
  return { dir, file: join(dir, "opencode.json") }
}

const legacyO1CodeProvider = {
  npm: "@ai-sdk/openai-compatible",
  name: "O1-Code",
  options: {
    baseURL: "http://127.0.0.1:8787/v1",
    apiKey: "o1-code-local",
  },
  models: {
    "o1-code": { name: "O1-Code" },
    "o1-code-builder": { name: "O1-Code Builder" },
  },
}

test("creates opencode.json with the exact CookieMonster project roster", async () => {
  const { dir, file } = await tmpFile()
  await ensureO1CodeProvider(file)
  const config = JSON.parse(await readFile(file, "utf8"))

  expect(config.$schema).toBe("https://opencode.ai/config.json")
  expect(config.provider.cookiemonster).toEqual(COOKIE_MONSTER_PROVIDER)
  expect(Object.keys(config.provider.cookiemonster.models)).toEqual(MODEL_IDS)
  expect(config.provider.cookiemonster.models["CM_Gemini-3.7-Flash_High"].family).toBe("gemini")
  expect(config.provider["o1-code"]).toBeUndefined()
  expect(config.provider.wpp).toBeUndefined()
  expect(config.mcp).toEqual(O1_CODE_MCP)
  expect(config.lsp).toBe(true)
  await rm(dir, { recursive: true, force: true })
})

test("removes only the legacy seeded aliases while adding the project provider", async () => {
  const { dir, file } = await tmpFile()
  await writeFile(
    file,
    JSON.stringify({ provider: { "o1-code": legacyO1CodeProvider, wpp: WPP_PROVIDER, other: { name: "Other" } } }),
  )
  await ensureO1CodeProvider(file)
  const config = JSON.parse(await readFile(file, "utf8"))

  expect(config.provider["o1-code"]).toBeUndefined()
  expect(config.provider.wpp).toBeUndefined()
  expect(config.provider.cookiemonster).toEqual(COOKIE_MONSTER_PROVIDER)
  expect(config.provider.other).toEqual({ name: "Other" })
  await rm(dir, { recursive: true, force: true })
})

test("preserves customized providers that reuse legacy keys", async () => {
  const { dir, file } = await tmpFile()
  const customO1 = { ...legacyO1CodeProvider, name: "Custom O1" }
  const customWpp = { ...WPP_PROVIDER, name: "Custom WPP" }
  await writeFile(file, JSON.stringify({ provider: { "o1-code": customO1, wpp: customWpp } }))
  await ensureO1CodeProvider(file)
  const config = JSON.parse(await readFile(file, "utf8"))

  expect(config.provider["o1-code"]).toEqual(customO1)
  expect(config.provider.wpp).toEqual(customWpp)
  expect(config.provider.cookiemonster).toEqual(COOKIE_MONSTER_PROVIDER)
  await rm(dir, { recursive: true, force: true })
})

test("fully seeded config is left byte-for-byte unchanged", async () => {
  const { dir, file } = await tmpFile()
  await ensureO1CodeProvider(file)
  const first = await readFile(file, "utf8")
  await ensureO1CodeProvider(file)
  expect(await readFile(file, "utf8")).toBe(first)
  await rm(dir, { recursive: true, force: true })
})

test("fills missing project models and cost keys without overriding custom values", async () => {
  const { dir, file } = await tmpFile()
  const [firstAgent] = MODEL_IDS
  const { family: _family, ...firstModel } = COOKIE_MONSTER_PROVIDER.models[firstAgent]
  await writeFile(
    file,
    JSON.stringify({
      provider: {
        cookiemonster: {
          ...COOKIE_MONSTER_PROVIDER,
          models: {
            [firstAgent]: { ...firstModel, cost: { input: 9 } },
          },
        },
      },
    }),
  )
  await ensureO1CodeProvider(file)
  const config = JSON.parse(await readFile(file, "utf8"))
  const models = config.provider.cookiemonster.models

  expect(Object.keys(models)).toEqual(MODEL_IDS)
  expect(models[firstAgent].cost).toEqual({ input: 9, output: 30, cache_read: 0.5, cache_write: 0 })
  expect(models[firstAgent].family).toBe("gpt-5")
  await rm(dir, { recursive: true, force: true })
})

test("removes retired project models from the seeded CookieMonster provider", async () => {
  const { dir, file } = await tmpFile()
  await writeFile(
    file,
    JSON.stringify({
      provider: {
        cookiemonster: {
          ...COOKIE_MONSTER_PROVIDER,
          models: {
            ...COOKIE_MONSTER_PROVIDER.models,
            "CM_GPT-5.5 - High": { name: "CM_GPT-5.5 - High" },
            "CM_Opus 4.8 - Extra High": { name: "CM_Opus 4.8 - Extra High" },
          },
        },
      },
    }),
  )
  await ensureO1CodeProvider(file)
  const config = JSON.parse(await readFile(file, "utf8"))

  expect(Object.keys(config.provider.cookiemonster.models)).toEqual(MODEL_IDS)
  await rm(dir, { recursive: true, force: true })
})

test("preserves an explicit LSP setting", async () => {
  const { dir, file } = await tmpFile()
  await writeFile(file, JSON.stringify({ lsp: false }))
  await ensureO1CodeProvider(file)
  const config = JSON.parse(await readFile(file, "utf8"))

  expect(config.lsp).toBe(false)
  await rm(dir, { recursive: true, force: true })
})

test("leaves a custom provider under the CookieMonster key untouched", async () => {
  const { dir, file } = await tmpFile()
  const custom = { name: "My provider", models: { custom: { name: "Custom" } } }
  await writeFile(file, JSON.stringify({ provider: { cookiemonster: custom } }))
  await ensureO1CodeProvider(file)
  const config = JSON.parse(await readFile(file, "utf8"))
  expect(config.provider.cookiemonster).toEqual(custom)
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

for (const browser of [false, true]) {
  for (const ae of [false, true]) {
    test(`injected plugins browser=${browser} AE=${ae} never inject AE permissions`, () => {
      const browserPlugin = "file:///resources/cm-browser/plugin.mjs"
      const aePlugin = [
        "file:///resources/cm-ae/plugin.mjs",
        {
          releaseMetadata: { cookieMonsterVersion: "1.18.27+cm.1" },
        },
      ]
      const config = JSON.parse(o1CodeConfigContent(browser ? browserPlugin : undefined, ae ? aePlugin : undefined))
      const plugins = [...(browser ? [browserPlugin] : []), ...(ae ? [aePlugin] : [])]
      expect(config.plugin).toEqual(plugins.length ? plugins : undefined)
      expect(config.permission).toEqual(JSON.parse(o1CodeConfigContent()).permission)
      expect(Object.keys(config.permission).every((name) => name.startsWith("browser_"))).toBe(true)
      // High-precedence injection cannot replace AE denies, wildcards or agent/mode policies.
      const policy = {
        permission: { ae_execute: "deny", "ae_*": "deny" },
        agent: { restricted: { permission: { ae_execute: "deny" } } },
        mode: { review: { permission: { "ae_*": "deny" } } },
      }
      expect({ ...policy.permission, ...config.permission }.ae_execute).toBe("deny")
      expect(config.agent).toBeUndefined()
      expect(config.mode).toBeUndefined()
      expect(config.tools).toBeUndefined()
    })
  }
}

test("global seed preserves user plugins and all permission settings, and never seeds local AE paths", async () => {
  const { dir, file } = await tmpFile()
  try {
    const user = {
      plugin: ["user-plugin"],
      permission: { "ae_*": "deny", browser_click: "deny" },
      agent: { review: { permission: { ae_execute: "deny" } } },
      tools: { ae_execute: false },
    }
    await writeFile(file, JSON.stringify(user))
    await ensureO1CodeProvider(file)
    expect(JSON.parse(await readFile(file, "utf8"))).toMatchObject(user)
    await rm(file)
    await ensureO1CodeProvider(file)
    const fresh = JSON.parse(await readFile(file, "utf8"))
    expect(fresh.plugin).toBeUndefined()
    expect(fresh.permission).toBeUndefined()
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test("injected config is self-contained for a clean bundled OpenCode install", () => {
  const plugin = "file:///resources/cm-browser/plugin.mjs"
  const config = JSON.parse(o1CodeConfigContent(plugin))
  const models = config.provider.cookiemonster.models

  expect(config.provider).toEqual({ cookiemonster: COOKIE_MONSTER_PROVIDER })
  expect(config.mcp).toEqual(O1_CODE_MCP)
  expect(config.lsp).toBe(true)
  expect(config.plugin).toEqual([plugin])
  expect(config.permission).toEqual({
    browser_read_state: "allow",
    browser_navigate: "ask",
    browser_click: "ask",
    browser_fill: "ask",
    browser_press_key: "ask",
  })
  expect(Object.keys(models)).toEqual(MODEL_IDS)
  for (const agentName of MODEL_IDS) {
    expect(models[agentName]).toEqual(COOKIE_MONSTER_PROVIDER.models[agentName])
  }
})
