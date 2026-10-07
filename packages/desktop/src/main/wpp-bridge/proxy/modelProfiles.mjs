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
  "CM_GPT6_Sol_Low": {
    agentName: "CM_GPT6_Sol_Low",
    toolFormat: "xml",
    commentaryPhase: true,
  },
  "CM_GPT6_Sol_Medium": {
    agentName: "CM_GPT6_Sol_Medium",
    toolFormat: "xml",
    commentaryPhase: true,
  },
  "CM_GPT6_Sol_High": {
    agentName: "CM_GPT6_Sol_High",
    toolFormat: "xml",
    commentaryPhase: true,
  },
  "CM_GPT6_Sol_XHigh": {
    agentName: "CM_GPT6_Sol_XHigh",
    toolFormat: "xml",
    commentaryPhase: true,
  },
  "CM_GPT6_Astra_Low": {
    agentName: "CM_GPT6_Astra_Low",
    toolFormat: "xml",
    commentaryPhase: true,
  },
  "CM_GPT6_Astra_Medium": {
    agentName: "CM_GPT6_Astra_Medium",
    toolFormat: "xml",
    commentaryPhase: true,
  },
  "CM_GPT6_Astra_High": {
    agentName: "CM_GPT6_Astra_High",
    toolFormat: "xml",
    commentaryPhase: true,
  },
  "CM_GPT6_Astra_XHigh": {
    agentName: "CM_GPT6_Astra_XHigh",
    toolFormat: "xml",
    commentaryPhase: true,
  },
  "CM_GPT6_Astra_Max": {
    agentName: "CM_GPT6_Astra_Max",
    toolFormat: "xml",
    commentaryPhase: true,
  },
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
  "CM_GPT-5.6 Sol - Max": {
    agentName: "CM_GPT-5.6 Sol - Max",
    toolFormat: "xml",
    commentaryPhase: true,
  },
  "CM_GPT-5.6-Sol_High": {
    agentName: "CM_GPT-5.6-Sol_High",
    toolFormat: "xml",
    commentaryPhase: true,
  },
  "CM_Opus5.5-Auto": {
    agentName: "CM_Opus5.5-Auto",
    toolFormat: "xml",
  },
  "CM_Opus5.5-Medium": {
    agentName: "CM_Opus5.5-Medium",
    toolFormat: "xml",
  },
  "CM_Opus5.5-High": {
    agentName: "CM_Opus5.5-High",
    toolFormat: "xml",
  },
  "CM_Opus5.5-XHigh": {
    agentName: "CM_Opus5.5-XHigh",
    toolFormat: "xml",
  },
  "CM_Opus5.5-Max": {
    agentName: "CM_Opus5.5-Max",
    toolFormat: "xml",
  },
  "CM_Gemini-3.7-Flash_Low": {
    agentName: "CM_Gemini-3.7-Flash_Low",
    toolFormat: "xml",
  },
  "CM_Gemini-3.7-Flash_Medium": {
    agentName: "CM_Gemini-3.7-Flash_Medium",
    toolFormat: "xml",
  },
  "CM_Gemini-3.7-Flash_High": {
    agentName: "CM_Gemini-3.7-Flash_High",
    toolFormat: "xml",
  },
  "CM_GPT6.1_Sol": {
    defaultReasoningEffort: "medium",
    reasoningEfforts: {
      low: "CM_GPT6.1_Sol_Low",
      medium: "CM_GPT6.1_Sol_Medium",
      high: "CM_GPT6.1_Sol_High",
      xhigh: "CM_GPT6.1_Sol_XHigh",
      max: "CM_GPT6.1_Sol_Max",
    },
    toolFormat: "xml",
    commentaryPhase: true,
  },
}

export const DEFAULT_MODEL_ID = "CM_GPT-5.6-Sol_High"

// Retired WPP agent names that still route to their successor, so in-flight sessions and saved
// defaults keep working after a rename. Never advertised; providerConfig strips them from the seed.
export const RENAMED_MODEL_IDS = new Map([
  ["CM_Opus 5 - Auto", "CM_Opus5.5-Auto"],
  ["CM_Opus 5 - Medium", "CM_Opus5.5-Medium"],
  ["CM_Opus 5 - High", "CM_Opus5.5-High"],
  ["CM_Opus 5 - Extra High", "CM_Opus5.5-XHigh"],
  ["CM_Opus 5 - Max", "CM_Opus5.5-Max"],
])

export function resolveModelProfile(modelId) {
  const id = RENAMED_MODEL_IDS.get(modelId) ?? modelId
  const profile = Object.hasOwn(MODEL_PROFILES, id) ? MODEL_PROFILES[id] : undefined
  if (profile) {
    if (!Object.hasOwn(profile, "reasoningEfforts")) return profile
    return { ...profile, agentName: profile.reasoningEfforts[profile.defaultReasoningEffort] }
  }

  const sol = MODEL_PROFILES["CM_GPT6.1_Sol"]
  if (Object.values(sol.reasoningEfforts).includes(id)) {
    return { agentName: id, toolFormat: sol.toolFormat, commentaryPhase: sol.commentaryPhase }
  }
  if (typeof id === "string" && (id === "CM_GPT6.1" || id.startsWith("CM_GPT6.1_"))) {
    const error = new Error(`Unknown model: ${id}`)
    error.statusCode = 400
    error.type = "invalid_model"
    throw error
  }
  return MODEL_PROFILES[DEFAULT_MODEL_ID]
}

export function resolveRequestModelProfile(body) {
  const override = body?.o1_code_model
  const profile = resolveModelProfile(override || body?.model)
  if (!Object.hasOwn(profile, "reasoningEfforts")) {
    return override ? { ...profile, agentName: override } : profile
  }

  const effort = Object.hasOwn(body, "reasoning_effort") ? body.reasoning_effort : profile.defaultReasoningEffort
  if (typeof effort !== "string" || !Object.hasOwn(profile.reasoningEfforts, effort)) {
    const error = new Error(`reasoning_effort must be one of: ${Object.keys(profile.reasoningEfforts).join(", ")}`)
    error.statusCode = 400
    error.type = "invalid_reasoning_effort"
    throw error
  }
  return { ...profile, agentName: profile.reasoningEfforts[effort] }
}

export const MODEL_IDS = Object.keys(MODEL_PROFILES)
