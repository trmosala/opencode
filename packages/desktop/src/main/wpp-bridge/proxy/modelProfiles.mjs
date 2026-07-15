// Single source of truth tying an OpenAI `model` id to the WPP agent that serves it and the
// tool-call format that agent emits. Both the routing seam (openaiCompat.mjs sets
// bridgeOptions.model = agentName) and the protocol seam (messageSerializer.mjs declares the
// expected response protocol) read from here, so "which agent" and "which format" never drift.
//
//   toolFormat "xml"  -> <function_calls> blocks (src/anthropicToolFormat.mjs)
//   toolFormat "json" -> {"type":"tool_call","tool":...,"args":{}} (src/jsonToolFormat.mjs)
//
// The agentName is also the affinity key the extension uses to pin a tab to one agent
// (extension/background.js) and the label it selects in the composer pill (extension/content.js).
const PROFILES = {
  "o1-code": { agentName: "CookieMonster_Opus 4.8 - Extra High", toolFormat: "xml" },
  "o1-code-builder": { agentName: "CookieMonster_GPT-5.5 - Extra High", toolFormat: "xml" },
}

const DEFAULT_MODEL_ID = "o1-code"

export function resolveModelProfile(modelId) {
  return PROFILES[modelId] || PROFILES[DEFAULT_MODEL_ID]
}

export const MODEL_IDS = Object.keys(PROFILES)
