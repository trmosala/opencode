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
export const MODEL_PROFILES = {
  "CM_GPT-5.6 Sol - Low": {
    agentName: "CM_GPT-5.6 Sol - Low",
    toolFormat: "xml",
    commentaryPhase: true,
  },
  "CM_GPT-5.6 Sol - Medium": {
    agentName: "CM_GPT-5.6 Sol - Medium",
    toolFormat: "xml",
    commentaryPhase: true,
  },
  "CM_GPT-5.6 Sol - High": {
    agentName: "CM_GPT-5.6 Sol - High",
    toolFormat: "xml",
    commentaryPhase: true,
  },
  "CM_GPT-5.6 Sol - Extra High": {
    agentName: "CM_GPT-5.6 Sol - Extra High",
    toolFormat: "xml",
    commentaryPhase: true,
  },
  "CM_GPT-5.5 - Low": {
    agentName: "CM_GPT-5.5 - Low",
    toolFormat: "xml",
  },
  "CM_GPT-5.5 - Medium": {
    agentName: "CM_GPT-5.5 - Medium",
    toolFormat: "xml",
  },
  "CM_GPT-5.5 - High": {
    agentName: "CM_GPT-5.5 - High",
    toolFormat: "xml",
  },
  "CM_GPT-5.5 - Extra High": {
    agentName: "CM_GPT-5.5 - Extra High",
    toolFormat: "xml",
  },
  "CM_Opus 4.8 - Low": {
    agentName: "CM_Opus 4.8 - Low",
    toolFormat: "xml",
  },
  "CM_Opus 4.8 - Auto": {
    agentName: "CM_Opus 4.8 - Auto",
    toolFormat: "xml",
  },
  "CM_Opus 4.8 - High": {
    agentName: "CM_Opus 4.8 - High",
    toolFormat: "xml",
  },
  "CM_Opus 4.8 - Extra High": {
    agentName: "CM_Opus 4.8 - Extra High",
    toolFormat: "xml",
  },
  "CM_Opus 5 - Auto": {
    agentName: "CM_Opus 5 - Auto",
    toolFormat: "xml",
  },
  "CM_Opus 5 - Medium": {
    agentName: "CM_Opus 5 - Medium",
    toolFormat: "xml",
  },
  "CM_Opus 5 - High": {
    agentName: "CM_Opus 5 - High",
    toolFormat: "xml",
  },
  "CM_Opus 5 - Extra High": {
    agentName: "CM_Opus 5 - Extra High",
    toolFormat: "xml",
  },
  "CM_Opus 5 - Max": {
    agentName: "CM_Opus 5 - Max",
    toolFormat: "xml",
  },
}

export const DEFAULT_MODEL_ID = "CM_Opus 4.8 - Extra High"

export function resolveModelProfile(modelId) {
  return MODEL_PROFILES[modelId] || MODEL_PROFILES[DEFAULT_MODEL_ID]
}

export const MODEL_IDS = Object.keys(MODEL_PROFILES)
