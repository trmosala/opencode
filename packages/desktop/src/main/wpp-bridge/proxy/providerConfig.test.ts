import { expect, test } from "bun:test"
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { MODEL_IDS, MODEL_PROFILES, RENAMED_MODEL_IDS, resolveRequestModelProfile } from "./modelProfiles.mjs"
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
  expect(config.provider.cookiemonster.models["CM_Opus5.5-High"]).toMatchObject({
    name: "CM_Opus5.5-High",
    family: "claude",
  })
  expect(config.provider.cookiemonster.models["CM_Opus 5 - High"]).toBeUndefined()
  expect(config.provider["o1-code"]).toBeUndefined()
  expect(config.provider.wpp).toBeUndefined()
  expect(config.mcp).toEqual(O1_CODE_MCP)
  expect(config.lsp).toBe(true)
  await rm(dir, { recursive: true, force: true })
})

test("advertises only the Sol 6.1 family with explicit native variants and a medium default", () => {
  const models = JSON.parse(o1CodeConfigContent()).provider.cookiemonster.models
  const family = models["CM_GPT6.1_Sol"]
  expect(Object.keys(models).filter((id) => id.startsWith("CM_GPT6.1"))).toEqual(["CM_GPT6.1_Sol"])
  expect(family.name).toBe("CM_GPT6.1_Sol")
  expect(family.options).toEqual({ reasoningEffort: "medium" })
  expect(family.variants).toEqual({
    low: { reasoningEffort: "low" },
    medium: { reasoningEffort: "medium" },
    high: { reasoningEffort: "high" },
    xhigh: { reasoningEffort: "xhigh" },
    max: { reasoningEffort: "max" },
  })
  expect(Object.keys(family.variants)).toEqual(["low", "medium", "high", "xhigh", "max"])
  expect(family.reasoning).toBeUndefined()
  expect(
    resolveRequestModelProfile({ model: family.name, reasoning_effort: family.options.reasoningEffort }),
  ).toMatchObject({
    agentName: "CM_GPT6.1_Sol_Medium",
  })
  for (const [effort, agentName] of [
    ["low", "CM_GPT6.1_Sol_Low"],
    ["medium", "CM_GPT6.1_Sol_Medium"],
    ["high", "CM_GPT6.1_Sol_High"],
    ["xhigh", "CM_GPT6.1_Sol_XHigh"],
    ["max", "CM_GPT6.1_Sol_Max"],
  ]) {
    expect(
      resolveRequestModelProfile({ model: family.name, reasoning_effort: family.variants[effort].reasoningEffort }),
    ).toMatchObject({ agentName })
  }
  for (const id of MODEL_IDS.filter((id) => !Object.hasOwn(MODEL_PROFILES[id], "reasoningEfforts"))) {
    expect(models[id].variants).toBeUndefined()
    expect(models[id].options).toBeUndefined()
    expect(models[id].reasoning).toBeUndefined()
  }
})

test("seeds every family selector while retaining saved fixed-effort selections", async () => {
  const { dir, file } = await tmpFile()
  try {
    const models = Object.fromEntries(
      Object.entries(COOKIE_MONSTER_PROVIDER.models).filter(
        ([id]) => !Object.hasOwn(MODEL_PROFILES[id], "reasoningEfforts"),
      ),
    )
    const user = {
      model: "cookiemonster/CM_GPT-5.6-Sol_High",
      small_model: "cookiemonster/CM_Gemini-3.7-Flash_Low",
      agent: { review: { model: "cookiemonster/CM_Opus5.5-Max" } },
    }
    await writeFile(
      file,
      JSON.stringify({ ...user, provider: { cookiemonster: { ...COOKIE_MONSTER_PROVIDER, models } } }),
    )
    await ensureO1CodeProvider(file)
    const first = await readFile(file, "utf8")
    const config = JSON.parse(first)
    expect(config).toMatchObject(user)
    expect(config.provider.cookiemonster.models).toEqual(COOKIE_MONSTER_PROVIDER.models)
    const injected = JSON.parse(o1CodeConfigContent()).provider.cookiemonster.models
    for (const id of MODEL_IDS.filter((id) => Object.hasOwn(MODEL_PROFILES[id], "reasoningEfforts"))) {
      const profile = MODEL_PROFILES[id]
      const family = injected[id]
      expect(family.options).toEqual({ reasoningEffort: profile.defaultReasoningEffort })
      expect(Object.keys(family.variants)).toEqual(Object.keys(profile.reasoningEfforts))
      expect(family.reasoning).toBeUndefined()
      for (const [effort, agentName] of Object.entries(profile.reasoningEfforts)) {
        expect(
          resolveRequestModelProfile({ model: id, reasoning_effort: family.variants[effort].reasoningEffort }),
        ).toEqual({
          ...profile,
          agentName,
        })
      }
    }
    await ensureO1CodeProvider(file)
    expect(await readFile(file, "utf8")).toBe(first)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

for (const hasFamily of [false, true]) {
  test(`seeds Sol 6.1 additively with existing family=${hasFamily}`, async () => {
    const { dir, file } = await tmpFile()
    try {
      const custom = {
        ...COOKIE_MONSTER_PROVIDER.models["CM_GPT6.1_Sol"],
        name: "My Sol",
        options: { reasoningEffort: "high", temperature: 0.2 },
        variants: { medium: { disabled: true }, high: { reasoningEffort: "high", temperature: 0.4 } },
        limit: { context: 100000, output: 16000 },
        cost: { input: 9, output: 27, cache_read: 1, cache_write: 2 },
      }
      const legacy = {
        ...COOKIE_MONSTER_PROVIDER.models["CM_GPT6_Sol_High"],
        name: "My legacy Sol",
        options: { temperature: 0.5 },
      }
      const user = {
        model: "cookiemonster/CM_GPT6_Sol_High",
        small_model: "other/small",
        plugin: ["user-plugin"],
        permission: { bash: "ask" },
        lsp: false,
      }
      await writeFile(
        file,
        JSON.stringify({
          ...user,
          provider: {
            cookiemonster: {
              ...COOKIE_MONSTER_PROVIDER,
              models: {
                ...Object.fromEntries(
                  Object.entries(COOKIE_MONSTER_PROVIDER.models).filter(([id]) => id !== "CM_GPT6.1_Sol"),
                ),
                CM_GPT6_Sol_High: legacy,
                ...(hasFamily ? { "CM_GPT6.1_Sol": custom } : {}),
              },
            },
            other: { name: "Other" },
          },
        }),
      )
      await ensureO1CodeProvider(file)
      const first = await readFile(file, "utf8")
      const config = JSON.parse(first)
      const models = config.provider.cookiemonster.models
      expect(Object.keys(models).sort()).toEqual([...MODEL_IDS].sort())
      expect(models["CM_GPT6.1_Sol"]).toEqual(hasFamily ? custom : COOKIE_MONSTER_PROVIDER.models["CM_GPT6.1_Sol"])
      expect(models["CM_GPT6_Sol_High"]).toEqual(legacy)
      for (const id of MODEL_IDS.filter((id) => id !== "CM_GPT6.1_Sol" && id !== "CM_GPT6_Sol_High")) {
        expect(models[id]).toEqual(COOKIE_MONSTER_PROVIDER.models[id])
      }
      expect(config).toMatchObject(user)
      expect(config.provider.other).toEqual({ name: "Other" })
      await ensureO1CodeProvider(file)
      expect(await readFile(file, "utf8")).toBe(first)
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })
}

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

test("disables only Zen and Go in injected and fresh configs", async () => {
  expect(JSON.parse(o1CodeConfigContent()).disabled_providers).toEqual(["opencode", "opencode-go"])
  const { dir, file } = await tmpFile()
  try {
    await ensureO1CodeProvider(file)
    expect(JSON.parse(await readFile(file, "utf8")).disabled_providers).toEqual(["opencode", "opencode-go"])
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test("preserves existing disabled providers without duplicating Zen or Go", async () => {
  const { dir, file } = await tmpFile()
  try {
    await writeFile(file, JSON.stringify({ disabled_providers: ["openai", "opencode"] }))
    await ensureO1CodeProvider(file)
    const first = await readFile(file, "utf8")
    expect(JSON.parse(first).disabled_providers).toEqual(["openai", "opencode", "opencode-go"])
    await ensureO1CodeProvider(file)
    expect(await readFile(file, "utf8")).toBe(first)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
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

for (const hasRenamedModel of [false, true]) {
  test(`migrates the old Opus High seed with renamed model present=${hasRenamedModel}`, async () => {
    const { dir, file } = await tmpFile()
    try {
      const renamed = {
        name: "Custom Opus High",
        family: "claude",
        cost: { input: 9, output: 27, cache_read: 1, cache_write: 2 },
        limit: { context: 100000, output: 16000 },
      }
      const other = { name: "Custom model", family: "custom", cost: { input: 1 } }
      await writeFile(
        file,
        JSON.stringify({
          provider: {
            cookiemonster: {
              ...COOKIE_MONSTER_PROVIDER,
              models: {
                ...Object.fromEntries(
                  Object.entries(COOKIE_MONSTER_PROVIDER.models).filter(([id]) => id !== "CM_Opus5.5-High"),
                ),
                "CM_Opus 5 - High": { name: "CM_Opus 5 - High" },
                ...(hasRenamedModel ? { "CM_Opus5.5-High": renamed } : {}),
                custom: other,
              },
            },
            other: { name: "Other", models: { "CM_Opus 5 - High": { name: "Keep this" } } },
          },
          model: "cookiemonster/CM_Opus5.5-XHigh",
        }),
      )
      await ensureO1CodeProvider(file)
      const first = await readFile(file, "utf8")
      const config = JSON.parse(first)
      const models = config.provider.cookiemonster.models

      expect(models["CM_Opus 5 - High"]).toBeUndefined()
      expect(models["CM_Opus5.5-High"]).toEqual(
        hasRenamedModel ? renamed : COOKIE_MONSTER_PROVIDER.models["CM_Opus5.5-High"],
      )
      expect(Object.keys(models).sort()).toEqual([...MODEL_IDS, "custom"].sort())
      expect(models.custom).toEqual(other)
      for (const id of MODEL_IDS.filter((id) => id !== "CM_Opus5.5-High")) {
        expect(models[id]).toEqual(COOKIE_MONSTER_PROVIDER.models[id])
      }
      expect(config.provider.other).toEqual({
        name: "Other",
        models: { "CM_Opus 5 - High": { name: "Keep this" } },
      })
      expect(config.model).toBe("cookiemonster/CM_Opus5.5-XHigh")
      await ensureO1CodeProvider(file)
      expect(await readFile(file, "utf8")).toBe(first)
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })
}

for (const provider of [
  undefined,
  {
    ...COOKIE_MONSTER_PROVIDER,
    models: { "CM_Opus 5 - High": { name: "CM_Opus 5 - High" } },
  },
  COOKIE_MONSTER_PROVIDER,
]) {
  test(`migrates the retired global default with provider models=${Object.keys(provider?.models ?? {}).join(",")}`, async () => {
    const { dir, file } = await tmpFile()
    try {
      const unrelated = {
        small_model: "other/CM_Opus 5 - High",
        agent: { review: { model: "other/CM_Opus 5 - High" } },
        permission: { bash: "ask" },
        plugin: ["user-plugin"],
        lsp: false,
      }
      await writeFile(
        file,
        JSON.stringify({
          ...unrelated,
          model: "cookiemonster/CM_Opus 5 - High",
          provider: { cookiemonster: provider, other: { name: "Keep this" } },
        }),
      )
      await ensureO1CodeProvider(file)
      const first = await readFile(file, "utf8")
      const config = JSON.parse(first)

      expect(config.model).toBe("cookiemonster/CM_Opus5.5-High")
      expect(config).toMatchObject(unrelated)
      expect(config.provider.other).toEqual({ name: "Keep this" })
      expect(config.provider.cookiemonster.models["CM_Opus 5 - High"]).toBeUndefined()
      expect(config.provider.cookiemonster.models["CM_Opus5.5-High"]).toBeDefined()
      await ensureO1CodeProvider(file)
      expect(await readFile(file, "utf8")).toBe(first)
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })
}

for (const [retired, successor] of RENAMED_MODEL_IDS) {
  test(`migrates the retired seed and global default ${retired} to ${successor}`, async () => {
    const { dir, file } = await tmpFile()
    try {
      await writeFile(
        file,
        JSON.stringify({
          model: `cookiemonster/${retired}`,
          provider: {
            cookiemonster: {
              ...COOKIE_MONSTER_PROVIDER,
              models: { ...COOKIE_MONSTER_PROVIDER.models, [retired]: { name: retired } },
            },
          },
        }),
      )
      await ensureO1CodeProvider(file)
      const first = await readFile(file, "utf8")
      const config = JSON.parse(first)

      expect(config.model).toBe(`cookiemonster/${successor}`)
      expect(config.provider.cookiemonster.models[retired]).toBeUndefined()
      expect(Object.keys(config.provider.cookiemonster.models)).toEqual(MODEL_IDS)
      await ensureO1CodeProvider(file)
      expect(await readFile(file, "utf8")).toBe(first)
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })
}

for (const model of [
  undefined,
  "cookiemonster/CM_Opus5.5-High",
  "cookiemonster/CM_Opus5.5-XHigh",
  "other/CM_Opus 5 - High",
  "CM_Opus 5 - High",
]) {
  test(`preserves unrelated global default ${model}`, async () => {
    const { dir, file } = await tmpFile()
    try {
      await writeFile(file, JSON.stringify({ model, provider: { cookiemonster: COOKIE_MONSTER_PROVIDER } }))
      await ensureO1CodeProvider(file)
      expect(JSON.parse(await readFile(file, "utf8")).model).toBe(model)
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })
}

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
  const custom = {
    ...COOKIE_MONSTER_PROVIDER,
    name: "My provider",
    models: { custom: { name: "Custom" }, "CM_Opus 5 - High": { name: "Keep this" } },
  }
  await writeFile(
    file,
    JSON.stringify({ model: "cookiemonster/CM_Opus 5 - High", provider: { cookiemonster: custom } }),
  )
  await ensureO1CodeProvider(file)
  const config = JSON.parse(await readFile(file, "utf8"))
  expect(config.provider.cookiemonster).toEqual(custom)
  expect(config.model).toBe("cookiemonster/CM_Opus 5 - High")
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
      expect(config.permission.browser_list_site_tools).toBe("allow")
      expect(config.permission.browser_execute_site_tool).toBe("allow")
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
  expect(config.mcp).toEqual({ figma: O1_CODE_MCP.figma })
  expect(config.mcp.figma.oauth).toEqual({
    clientName: "Claude Code",
    scope: "mcp:connect",
    callbackPort: 19876,
  })
  expect(config.lsp).toBe(true)
  expect(config.plugin).toEqual([plugin])
  expect(config.permission).toEqual({
    browser_read_state: "allow",
    browser_search_history: "allow",
    browser_open_history: "ask",
    browser_navigate: "allow",
    browser_click: "allow",
    browser_hover: "allow",
    browser_drag: "allow",
    browser_select_option: "allow",
    browser_screenshot: "allow",
    browser_visual_action: "allow",
    browser_observe_console: "allow",
    browser_observe_network: "allow",
    browser_list_site_tools: "allow",
    browser_execute_site_tool: "allow",
    browser_fill: "allow",
    browser_press_key: "allow",
    browser_scroll: "allow",
    browser_wait_for_element: "allow",
    browser_wait_for_navigation: "allow",
  })
  expect(Object.keys(models)).toEqual(MODEL_IDS)
  expect(models["CM_Opus5.5-High"]).toMatchObject({
    name: "CM_Opus5.5-High",
    family: "claude",
  })
  expect(models["CM_Opus 5 - High"]).toBeUndefined()
  for (const agentName of MODEL_IDS) {
    expect(models[agentName]).toEqual(COOKIE_MONSTER_PROVIDER.models[agentName])
  }
})

test("Chrome debugging defaults off without overriding existing definitions", async () => {
  expect(O1_CODE_MCP["chrome-devtools"].enabled).toBe(false)
  expect(JSON.parse(o1CodeConfigContent(undefined, undefined, true)).mcp["chrome-devtools"].enabled).toBe(true)
  for (const customized of [false, true]) {
    const { dir, file } = await tmpFile()
    try {
      const chrome = {
        ...O1_CODE_MCP["chrome-devtools"],
        enabled: true,
        ...(customized ? { environment: { DEBUG_BROWSER: "1" } } : {}),
      }
      await writeFile(file, JSON.stringify({ mcp: { "chrome-devtools": chrome } }))
      await ensureO1CodeProvider(file)
      expect(JSON.parse(await readFile(file, "utf8")).mcp["chrome-devtools"]).toEqual(chrome)
      const seeded = await readFile(file, "utf8")
      await ensureO1CodeProvider(file)
      expect(await readFile(file, "utf8")).toBe(seeded)
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  }
})

test("Chrome re-enablement survives later launches after fresh and existing config seeding", async () => {
  for (const existing of [false, true]) {
    const { dir, file } = await tmpFile()
    try {
      if (existing) await writeFile(file, JSON.stringify({}))
      await ensureO1CodeProvider(file)
      const config = JSON.parse(await readFile(file, "utf8"))
      expect(config.mcp["chrome-devtools"].enabled).toBe(false)
      config.mcp["chrome-devtools"].enabled = true
      const enabled = JSON.stringify(config, null, 2) + "\n"
      await writeFile(file, enabled)
      await ensureO1CodeProvider(file)
      expect(await readFile(file, "utf8")).toBe(enabled)
      await ensureO1CodeProvider(file)
      expect(await readFile(file, "utf8")).toBe(enabled)
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  }
})
