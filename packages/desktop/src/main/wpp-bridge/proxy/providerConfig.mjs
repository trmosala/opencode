import { homedir } from "node:os"
import { dirname, join } from "node:path"
import { mkdir, readFile, writeFile } from "node:fs/promises"

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
}

// Ogilvy One Coder, exposed directly off the local WPP proxy.
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

export const O1_CODE_PROVIDER = {
  npm: "@ai-sdk/openai-compatible",
  name: "O1-Code",
  options: {
    baseURL: "http://127.0.0.1:8787/v1",
    apiKey: "o1-code-local",
  },
  models: {
    "o1-code": {
      name: "O1-Code",
      attachment: true,
      // Claude Opus 4.8 via OgilvyOneCoder. WPP /models captured 2026-07-03 priced it at
      // $0.005 / 1K input and $0.025 / 1K output; OpenCode config uses dollars per 1M tokens.
      cost: { input: 5, output: 25, cache_read: 0, cache_write: 0 },
      modalities: {
        input: ["text", "image"],
        output: ["text"],
      },
      limit: {
        context: O1_CODE_CONTEXT_LIMIT,
        output: O1_CODE_OUTPUT_LIMIT,
      },
    },
    // Routed to the WPP "OgilvyOneCoder_Builder" agent (GPT-5.5) — a faster building backend.
    // See src/modelProfiles.mjs for the model-id -> agent + tool-call-format mapping.
    "o1-code-builder": {
      name: "O1-Code Builder",
      attachment: true,
      // GPT-5.5 pricing is absent from WPP /models. Use the public July 2026 API rate corroborated by
      // OpenRouter, morphllm, langcopilot, and devtk.ai: $5 input, $30 output, $0.50 cached input / 1M.
      cost: { input: 5, output: 30, cache_read: 0.5, cache_write: 0 },
      modalities: {
        input: ["text", "image"],
        output: ["text"],
      },
      limit: {
        context: O1_CODE_CONTEXT_LIMIT,
        output: O1_CODE_OUTPUT_LIMIT,
      },
    },
  },
}

// Everything a fresh user should get without manual setup: both providers + the MCP server.
const SEED_PROVIDERS = { wpp: WPP_PROVIDER, "o1-code": O1_CODE_PROVIDER }
const SEED_MCP = O1_CODE_MCP

// Resolve the user's global opencode.json the same way the sidecar does (xdg-basedir's config dir).
export function o1CodeConfigFile() {
  return join(process.env.XDG_CONFIG_HOME || join(homedir(), ".config"), "opencode", "opencode.json")
}

// Limit-only config blob for OPENCODE_CONFIG_CONTENT. OpenCode deep-merges this last (local scope),
// so it overrides the context cap on both models even when the seeded opencode.json still carries a
// stale value, while leaving provider/model/MCP definitions file-driven and user-editable. Kept to
// only the limit so we don't freeze anything a user might legitimately want to tune.
export function o1CodeConfigContent() {
  const limit = { context: O1_CODE_CONTEXT_LIMIT, output: O1_CODE_OUTPUT_LIMIT }
  return JSON.stringify({
    provider: {
      "o1-code": { models: { "o1-code": { limit }, "o1-code-builder": { limit } } },
    },
  })
}

// Seed the providers + MCP server into opencode.json so a new user gets them without manual setup.
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
  for (const [key, value] of Object.entries(SEED_PROVIDERS)) {
    if (!config.provider?.[key]) {
      config.provider = { ...config.provider, [key]: value }
      changed = true
      continue
    }

    const existingModels = config.provider[key]?.models
    if (!existingModels || typeof existingModels !== "object" || Array.isArray(existingModels)) continue

    for (const [modelKey, seedModel] of Object.entries(value.models || {})) {
      const existingModel = existingModels[modelKey]
      if (!existingModel || typeof existingModel !== "object" || Array.isArray(existingModel) || !seedModel.cost)
        continue

      const existingCost =
        existingModel.cost && typeof existingModel.cost === "object" && !Array.isArray(existingModel.cost)
          ? existingModel.cost
          : {}
      const mergedCost = { ...seedModel.cost, ...existingCost }
      if (JSON.stringify(existingCost) === JSON.stringify(mergedCost)) continue

      existingModels[modelKey] = { ...existingModel, cost: mergedCost }
      changed = true
    }
  }
  for (const [key, value] of Object.entries(SEED_MCP)) {
    if (config.mcp?.[key]) continue
    config.mcp = { ...config.mcp, [key]: value }
    changed = true
  }
  if (!changed) return
  await writeFile(file, JSON.stringify(config, null, 2) + "\n")
}
