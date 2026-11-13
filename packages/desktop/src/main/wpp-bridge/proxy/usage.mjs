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

  // DOM pill is whole-thread WPP context, not a request prompt. Publishing it as OpenAI
  // prompt_tokens makes SessionCompaction.due() fire early once measured anchors work.
  // Keep the pill on evidence for logs/UI; OpenAI usage falls through to the estimate.
  const retained = continued ? (finiteToken(retainedContextTokens) ?? 0) : 0
  const prompt = (finiteToken(promptTokens) ?? 0) + retained
  const usage = standardUsage(prompt, completionEstimate)
  return result(usage, {
    scope: "context",
    source: "estimate",
    fidelity: "estimated",
    totalTokens: usage.total_tokens,
    ...(pillObservation(measurement) ? { observation: pillObservation(measurement) } : {}),
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

function pillObservation(measurement) {
  if (measurement?.source !== "dom-pill" || measurement.scope !== "context") return undefined
  return measurement.observation
}

function standardUsage(prompt, completion, cached, reasoning) {
  const cachedTokens = finiteToken(cached)
  const reasoningTokens = finiteToken(reasoning)
  // Always emit cached_tokens so OpenCode's openai-compat path sets noCache = prompt_tokens
  // (undefined details leave input at 0 and hasMeasuredPrompt never anchors).
  const usage = {
    prompt_tokens: prompt,
    completion_tokens: completion,
    total_tokens: prompt + completion,
    prompt_tokens_details: { cached_tokens: cachedTokens !== null ? Math.min(cachedTokens, prompt) : 0 },
  }
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
