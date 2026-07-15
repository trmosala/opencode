export const CM_REQUEST_TYPE = "CM_REQUEST_V1"
export const CM_REQUEST_VERSION = 1
export const CM_CAPABILITY_PROBE_TYPE = "CM_CAPABILITY_PROBE_V1"
export const CM_CAPABILITY_RESPONSE = "CM_CAPABILITY_V1_OK"
export const CM_CAPABILITY_PROBE_PROMPT = JSON.stringify({
  type: CM_CAPABILITY_PROBE_TYPE,
  version: 1,
})

export function toolCallProtocol(toolFormat) {
  return toolFormat === "json" ? "CM_JSON_TOOL_CALL_V1" : "CM_XML_TOOL_CALL_V1"
}

export function buildCapabilityProbeJob(job) {
  const payload = job?.payload || {}
  return {
    id: crypto.randomUUID(),
    type: "ask",
    payload: {
      prompt: CM_CAPABILITY_PROBE_PROMPT,
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
  if (String(finalText).trim() === CM_CAPABILITY_RESPONSE) return

  const error = new Error(
    `WPP agent ${JSON.stringify(agentName)} does not advertise ${CM_REQUEST_TYPE} support. ` +
      "Publish the versioned CookieMonster system instruction before using this desktop build.",
  )
  error.statusCode = 409
  error.type = "o1_code_protocol_incompatible"
  error.diagnostics = {
    phase: "protocol_capability",
    expected: CM_CAPABILITY_RESPONSE,
    receivedChars: String(finalText).length,
    agent: agentName,
  }
  throw error
}
