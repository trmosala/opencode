// Browser control for OpenCode is delivered as an MCP server, not proxy/extension logic:
// OpenCode owns the Playwright MCP process and its tools, keeping this repo transport-only.
// The model reaches these tools through OpenCode's normal tool surface (serialized into the
// prompt, parsed back out of the response) — no proxy/extension changes are required.
export const O1_CODE_MCP = {
  playwright: {
    type: "local",
    command: ["npx", "-y", "@playwright/mcp@latest"],
    enabled: true
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
