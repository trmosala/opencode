import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { mkdir, readFile, writeFile } from "node:fs/promises";

// Browser control for OpenCode is delivered as an MCP server, not proxy/extension logic:
// OpenCode owns the MCP process and its tools, keeping this repo transport-only. The model
// reaches these tools through OpenCode's normal tool surface — no proxy/extension changes
// required. Chrome DevTools MCP (vs Playwright) so the agent can debug the live desktop/web
// surfaces — console, network, real session — rather than drive a clean sandbox.
export const O1_CODE_MCP = {
  "chrome-devtools": {
    type: "local",
    command: ["npx", "-y", "chrome-devtools-mcp@latest"],
    enabled: true
  }
};

// Ogilvy One Coder, exposed directly off the local WPP proxy.
export const WPP_PROVIDER = {
  npm: "@ai-sdk/openai-compatible",
  name: "WPP AI",
  options: {
    baseURL: "http://127.0.0.1:8787/v1",
    apiKey: "wpp-local"
  },
  models: {
    "ogilvy-one-coder": {
      name: "Ogilvy One Coder"
    }
  }
};

export const O1_CODE_PROVIDER = {
  npm: "@ai-sdk/openai-compatible",
  name: "O1-Code",
  options: {
    baseURL: "http://127.0.0.1:8787/v1",
    apiKey: "o1-code-local"
  },
  models: {
    "o1-code": {
      name: "O1-Code",
      attachment: true,
      modalities: {
        input: ["text", "image"],
        output: ["text"]
      },
      limit: {
        context: 1000000,
        output: 128000
      }
    },
    // Routed to the WPP "OgilvyOneCoder_Builder" agent (GPT-5.5) — a faster building backend.
    // See src/modelProfiles.mjs for the model-id -> agent + tool-call-format mapping.
    "o1-code-builder": {
      name: "O1-Code Builder",
      attachment: true,
      modalities: {
        input: ["text", "image"],
        output: ["text"]
      },
      limit: {
        context: 1000000,
        output: 128000
      }
    }
  }
};

// Everything a fresh user should get without manual setup: both providers + the MCP server.
const SEED_PROVIDERS = { wpp: WPP_PROVIDER, "o1-code": O1_CODE_PROVIDER };
const SEED_MCP = O1_CODE_MCP;

// Resolve the user's global opencode.json the same way the sidecar does (xdg-basedir's config dir).
export function o1CodeConfigFile() {
  return join(process.env.XDG_CONFIG_HOME || join(homedir(), ".config"), "opencode", "opencode.json");
}

// Seed the providers + MCP server into opencode.json so a new user gets them without manual setup.
// Additive and idempotent: only fills in missing keys, preserves every other key, and refuses to
// rewrite a file it can't parse (e.g. JSONC comments) so hand-edited config is never clobbered.
export async function ensureO1CodeProvider(file = o1CodeConfigFile()) {
  const raw = await readFile(file, "utf8").catch(() => null);
  if (raw === null) {
    await mkdir(dirname(file), { recursive: true });
    const created = { $schema: "https://opencode.ai/config.json", provider: { ...SEED_PROVIDERS }, mcp: { ...SEED_MCP } };
    await writeFile(file, JSON.stringify(created, null, 2) + "\n");
    return;
  }
  let config;
  try {
    config = JSON.parse(raw);
  } catch {
    return; // ponytail: present but unparseable — merging would lose data, so leave it.
  }
  if (!config || typeof config !== "object" || Array.isArray(config)) return;

  let changed = false;
  for (const [key, value] of Object.entries(SEED_PROVIDERS)) {
    if (config.provider?.[key]) continue;
    config.provider = { ...config.provider, [key]: value };
    changed = true;
  }
  for (const [key, value] of Object.entries(SEED_MCP)) {
    if (config.mcp?.[key]) continue;
    config.mcp = { ...config.mcp, [key]: value };
    changed = true;
  }
  if (!changed) return;
  await writeFile(file, JSON.stringify(config, null, 2) + "\n");
}
