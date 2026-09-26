import { homedir } from "node:os"
import { dirname, join } from "node:path"
import { mkdir, readFile, writeFile } from "node:fs/promises"
import { MODEL_IDS, RENAMED_MODEL_IDS } from "./modelProfiles.mjs"

// Advertised model context/output limits. Context is kept below the proxy's O1_CODE_MAX_PROMPT_CHARS
// (600k chars ≈ ~150k tok) so OpenCode auto-compacts before the proxy hard-rejects the serialized
// prompt: 250k - 128k = 122k tok usable ≈ ~488k chars, comfortably under the cap. Also injected via
// OPENCODE_CONFIG_CONTENT (see o1CodeConfigContent) so this wins even on a machine whose seeded
// opencode.json still carries the old value.
export const O1_CODE_CONTEXT_LIMIT = 250000
export const O1_CODE_OUTPUT_LIMIT = 128000

// Browser control for OpenCode is delivered as an MCP server, not proxy/extension logic:
// OpenCode owns the MCP process and its tools, keeping this repo transport-only. The model
// reaches these tools through OpenCode's normal tool surface — no proxy/extension changes
// required. Chrome DevTools MCP (vs Playwright) so the agent can debug the live desktop/web
// surfaces — console, network, real session — rather than drive a clean sandbox.
export const O1_CODE_MCP = {
  "chrome-devtools": {
    type: "local",
    command: ["npx", "-y", "chrome-devtools-mcp@latest"],
    enabled: true,
  },
  figma: {
    type: "remote",
    url: "https://mcp.figma.com/mcp",
    oauth: {
      clientName: "Claude Code",
      scope: "mcp:connect",
      callbackPort: 19876,
    },
    enabled: true,
  },
}

// Exact legacy seed retained only so ensureO1CodeProvider can remove the obsolete picker entry
// without touching a user-created provider that happens to use the same key.
export const WPP_PROVIDER = {
  npm: "@ai-sdk/openai-compatible",
  name: "WPP AI",
  options: {
    baseURL: "http://127.0.0.1:8787/v1",
    apiKey: "wpp-local",
  },
  models: {
    "ogilvy-one-coder": {
      name: "Ogilvy One Coder",
    },
  },
}

const OPUS_COST = { input: 5, output: 25, cache_read: 0, cache_write: 0 }
const GPT_COST = { input: 5, output: 30, cache_read: 0.5, cache_write: 0 }

function projectModel(agentName) {
  return {
    name: agentName,
    family: agentName.startsWith("CM_Opus") ? "claude" : agentName.startsWith("CM_Gemini") ? "gemini" : "gpt-5",
    attachment: true,
    // Non-Opus variants retain the previous builder accounting estimate until WPP exposes an
    // authoritative rate for each project-agent route.
    cost: agentName.startsWith("CM_Opus") ? OPUS_COST : GPT_COST,
    modalities: {
      input: ["text", "image"],
      output: ["text"],
    },
    limit: {
      context: O1_CODE_CONTEXT_LIMIT,
      output: O1_CODE_OUTPUT_LIMIT,
    },
  }
}

export const COOKIE_MONSTER_PROVIDER = {
  npm: "@ai-sdk/openai-compatible",
  name: "CookieMonster",
  options: {
    baseURL: "http://127.0.0.1:8787/v1",
    apiKey: "cookiemonster-local",
  },
  models: Object.fromEntries(MODEL_IDS.map((agentName) => [agentName, projectModel(agentName)])),
}

// Everything a fresh user should get without manual setup: the project roster, MCP servers, and LSP support.
const SEED_PROVIDERS = { cookiemonster: COOKIE_MONSTER_PROVIDER }
const SEED_MCP = O1_CODE_MCP
const LEGACY_O1_CODE_MODELS = new Set(["o1-code", "o1-code-builder"])
const RETIRED_COOKIE_MONSTER_MODELS = new Set([
  "CM_GPT-5.5 - Low",
  "CM_GPT-5.5 - Medium",
  "CM_GPT-5.5 - High",
  "CM_GPT-5.5 - Extra High",
  "CM_Opus 4.8 - Low",
  "CM_Opus 4.8 - Auto",
  "CM_Opus 4.8 - High",
  "CM_Opus 4.8 - Extra High",
  ...RENAMED_MODEL_IDS.keys(),
])

function isLegacyO1CodeProvider(provider) {
  if (!provider || typeof provider !== "object" || Array.isArray(provider)) return false
  const modelIds = Object.keys(provider.models || {})
  return (
    provider.npm === "@ai-sdk/openai-compatible" &&
    provider.name === "O1-Code" &&
    provider.options?.baseURL === "http://127.0.0.1:8787/v1" &&
    provider.options?.apiKey === "o1-code-local" &&
    modelIds.length > 0 &&
    modelIds.every((id) => LEGACY_O1_CODE_MODELS.has(id))
  )
}

function isCookieMonsterProvider(provider) {
  return (
    provider?.npm === COOKIE_MONSTER_PROVIDER.npm &&
    provider?.name === COOKIE_MONSTER_PROVIDER.name &&
    provider?.options?.baseURL === COOKIE_MONSTER_PROVIDER.options.baseURL &&
    provider?.options?.apiKey === COOKIE_MONSTER_PROVIDER.options.apiKey
  )
}

// Resolve the user's global opencode.json the same way the sidecar does (xdg-basedir's config dir).
export function o1CodeConfigFile() {
  return join(process.env.XDG_CONFIG_HOME || join(homedir(), ".config"), "opencode", "opencode.json")
}

// Self-contained config blob injected into the bundled OpenCode sidecar. A clean install must see
// the project roster on its very first start even if the persistent opencode.json seed has not
// completed yet. The disk seed remains useful for external OpenCode sessions and later launches.
export function o1CodeConfigContent(browserPlugin, aePlugin) {
  const plugins = [browserPlugin, aePlugin].filter(Boolean)
  return JSON.stringify({
    provider: {
      cookiemonster: COOKIE_MONSTER_PROVIDER,
    },
    mcp: O1_CODE_MCP,
    ...(plugins.length ? { plugin: plugins } : {}),
    // AE defaults belong to its config hook, below user policy, not this high-precedence blob.
    permission: {
      browser_read_state: "allow",
      browser_search_history: "allow",
      browser_open_history: "ask",
      browser_create_tab: "ask",
      browser_select_tab: "ask",
      browser_close_tab: "ask",
      browser_navigate: "ask",
      browser_click: "ask",
      browser_hover: "ask",
      browser_drag: "ask",
      browser_select_option: "ask",
      browser_screenshot: "ask",
      browser_observe_console: "ask",
      browser_observe_network: "ask",
      browser_list_site_tools: "allow",
      browser_execute_site_tool: "ask",
      browser_fill: "ask",
      browser_press_key: "ask",
      browser_scroll: "ask",
      browser_wait_for_element: "allow",
      browser_wait_for_navigation: "allow",
    },
    lsp: true,
  })
}

// Seed the providers, MCP servers, and LSP support into opencode.json so a new user gets them without manual setup.
// Additive and idempotent: only fills in missing keys, preserves every other key, and refuses to
// rewrite a file it can't parse (e.g. JSONC comments) so hand-edited config is never clobbered.
export async function ensureO1CodeProvider(file = o1CodeConfigFile()) {
  const raw = await readFile(file, "utf8").catch(() => null)
  if (raw === null) {
    await mkdir(dirname(file), { recursive: true })
    const created = {
      $schema: "https://opencode.ai/config.json",
      provider: { ...SEED_PROVIDERS },
      mcp: { ...SEED_MCP },
      lsp: true,
    }
    await writeFile(file, JSON.stringify(created, null, 2) + "\n")
    return
  }
  let config
  try {
    config = JSON.parse(raw)
  } catch {
    return // ponytail: present but unparseable — merging would lose data, so leave it.
  }
  if (!config || typeof config !== "object" || Array.isArray(config)) return

  let changed = false
  if (isLegacyO1CodeProvider(config.provider?.["o1-code"])) {
    const { ["o1-code"]: _legacyO1Code, ...providers } = config.provider
    config.provider = providers
    changed = true
  }
  if (JSON.stringify(config.provider?.wpp) === JSON.stringify(WPP_PROVIDER)) {
    const { wpp: _legacyWpp, ...providers } = config.provider
    config.provider = providers
    changed = true
  }

  for (const [key, value] of Object.entries(SEED_PROVIDERS)) {
    if (!config.provider?.[key]) {
      config.provider = { ...config.provider, [key]: value }
      changed = true
      continue
    }

    if (!isCookieMonsterProvider(config.provider[key])) continue

    const existingModels = config.provider[key]?.models
    if (!existingModels || typeof existingModels !== "object" || Array.isArray(existingModels)) continue

    for (const modelKey of RETIRED_COOKIE_MONSTER_MODELS) {
      if (!(modelKey in existingModels)) continue
      delete existingModels[modelKey]
      changed = true
    }

    for (const [modelKey, seedModel] of Object.entries(value.models || {})) {
      const existingModel = existingModels[modelKey]
      if (!existingModel) {
        existingModels[modelKey] = seedModel
        changed = true
        continue
      }
      if (typeof existingModel !== "object" || Array.isArray(existingModel)) continue

      const existingCost =
        existingModel.cost && typeof existingModel.cost === "object" && !Array.isArray(existingModel.cost)
          ? existingModel.cost
          : {}
      const mergedCost = { ...seedModel.cost, ...existingCost }
      const family = existingModel.family ?? seedModel.family
      if (JSON.stringify(existingCost) === JSON.stringify(mergedCost) && existingModel.family === family) continue

      existingModels[modelKey] = { ...existingModel, family, cost: mergedCost }
      changed = true
    }
  }
  // Point a saved global default at the successor of a renamed agent, but only when the seeded
  // CookieMonster provider actually carries that successor.
  const successor =
    typeof config.model === "string" && config.model.startsWith("cookiemonster/")
      ? RENAMED_MODEL_IDS.get(config.model.slice("cookiemonster/".length))
      : undefined
  if (
    successor &&
    isCookieMonsterProvider(config.provider?.cookiemonster) &&
    config.provider.cookiemonster.models?.[successor]
  ) {
    config.model = `cookiemonster/${successor}`
    changed = true
  }
  for (const [key, value] of Object.entries(SEED_MCP)) {
    if (config.mcp?.[key]) continue
    config.mcp = { ...config.mcp, [key]: value }
    changed = true
  }
  if (config.lsp === undefined) {
    config.lsp = true
    changed = true
  }
  if (!changed) return
  await writeFile(file, JSON.stringify(config, null, 2) + "\n")
}
