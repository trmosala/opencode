import { resolveModelProfile } from "./modelProfiles.mjs"

export const CM_REQUEST_TYPE = "CM_REQUEST_V1"
export const CM_REQUEST_VERSION = 1
export const CM_CAPABILITY_PROBE_TYPE = "CM_CAPABILITY_PROBE_V1"
export const CM_CAPABILITY_RESPONSE = "CM_CAPABILITY_V1_OK"
export const CM_PHASE_CAPABILITY_RESPONSE = "CM_CAPABILITY_V1_PHASES_OK"
export const CM_TASK_COMPLETE_PROTOCOL = "CM_TASK_COMPLETE_V1"
export const CM_CAPABILITY_PROBE_PROMPT = JSON.stringify({
  type: CM_CAPABILITY_PROBE_TYPE,
  version: 1,
})

export function toolCallProtocol(toolFormat) {
  return toolFormat === "json" ? "CM_JSON_TOOL_CALL_V1" : "CM_XML_TOOL_CALL_V1"
}

export function buildCapabilityProbeJob(job) {
  const payload = job?.payload || {}
  const profile = resolveModelProfile(payload.model)
  return {
    id: crypto.randomUUID(),
    type: "ask",
    payload: {
      prompt: profile.commentaryPhase
        ? JSON.stringify({ type: CM_CAPABILITY_PROBE_TYPE, version: 1, features: ["assistant_phase"] })
        : CM_CAPABILITY_PROBE_PROMPT,
      images: [],
      target: payload.target,
      url: payload.url,
      model: payload.model,
      sessionKey: "",
      subagent: false,
      continueThread: false,
      verboseRecorder: payload.verboseRecorder === true,
    },
  }
}

export function assertCapabilityResponse(result, agentName) {
  const finalText = result?.finalText ?? result?.response?.finalText ?? ""
  const expected = resolveModelProfile(agentName).commentaryPhase
    ? CM_PHASE_CAPABILITY_RESPONSE
    : CM_CAPABILITY_RESPONSE
  if (String(finalText).trim() === expected) return

  const error = new Error(
    `WPP agent ${JSON.stringify(agentName)} does not advertise ${CM_REQUEST_TYPE} support. ` +
      "Publish the versioned CookieMonster system instruction before using this desktop build.",
  )
  error.statusCode = 409
  error.type = "o1_code_protocol_incompatible"
  error.diagnostics = {
    phase: "protocol_capability",
    expected,
    receivedChars: String(finalText).length,
    agent: agentName,
  }
  throw error
}
