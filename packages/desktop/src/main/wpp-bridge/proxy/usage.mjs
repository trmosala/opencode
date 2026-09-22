import { estimateTokens } from "./tokenEstimate.mjs"

export function resolveUsage({
  measurement,
  promptTokens,
  completionText,
  retainedContextTokens = 0,
  continued = false,
}) {
  const completionEstimate = estimateTokens(completionText || "")
  const network = exactNetworkUsage(measurement)
  if (network) {
    return result(network, measurement)
  }

  const context = confirmedContextUsage(measurement, completionEstimate)
  if (context) {
    return result(context, measurement)
  }

  const retained = continued ? (finiteToken(retainedContextTokens) ?? 0) : 0
  const prompt = (finiteToken(promptTokens) ?? 0) + retained
  const usage = standardUsage(prompt, completionEstimate)
  return result(usage, {
    scope: "context",
    source: "estimate",
    fidelity: "estimated",
    totalTokens: usage.total_tokens,
    ...(retained > 0 ? { retainedContextTokens: retained } : {}),
  })
}

function exactNetworkUsage(measurement) {
  if (measurement?.source !== "network" || measurement.scope !== "request") return undefined
  const prompt = finiteToken(measurement.promptTokens)
  const completion = finiteToken(measurement.completionTokens)
  if (prompt === null || completion === null) return undefined
  return standardUsage(prompt, completion, measurement.cachedTokens, measurement.reasoningTokens)
}

function confirmedContextUsage(measurement, completionEstimate) {
  if (measurement?.source !== "dom-pill" || measurement.scope !== "context") return undefined
  const total = finiteToken(measurement.totalTokens)
  if (total === null) return undefined
  const completion = Math.min(completionEstimate, total)
  return standardUsage(total - completion, completion)
}

function standardUsage(prompt, completion, cached, reasoning) {
  const usage = {
    prompt_tokens: prompt,
    completion_tokens: completion,
    total_tokens: prompt + completion,
  }
  const cachedTokens = finiteToken(cached)
  const reasoningTokens = finiteToken(reasoning)
  if (cachedTokens !== null) usage.prompt_tokens_details = { cached_tokens: Math.min(cachedTokens, prompt) }
  if (reasoningTokens !== null)
    usage.completion_tokens_details = { reasoning_tokens: Math.min(reasoningTokens, completion) }
  return usage
}

function result(usage, evidence) {
  return {
    usage,
    evidence: {
      scope: evidence.scope,
      source: evidence.source,
      fidelity: evidence.fidelity,
      totalTokens: usage.total_tokens,
      ...(evidence.observation ? { observation: evidence.observation } : {}),
      ...(evidence.retainedContextTokens ? { retainedContextTokens: evidence.retainedContextTokens } : {}),
    },
    context: {
      totalTokens: usage.total_tokens,
      source: evidence.source,
      fidelity: evidence.fidelity,
    },
  }
}

function finiteToken(value) {
  return Number.isFinite(value) && value >= 0 ? Math.ceil(value) : null
}
