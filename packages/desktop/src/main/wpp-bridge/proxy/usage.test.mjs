import { describe, expect, test } from "bun:test"
import { resolveUsage } from "./usage.mjs"

describe("WPP usage resolution", () => {
  test("prefers exact request-scoped network usage and preserves bounded details", () => {
    const resolved = resolveUsage({
      measurement: {
        scope: "request",
        source: "network",
        fidelity: "exact",
        promptTokens: 100,
        completionTokens: 25,
        totalTokens: 999,
        cachedTokens: 120,
        reasoningTokens: 30,
      },
      promptTokens: 2,
      completionText: "ignored estimate",
    })

    expect(resolved.usage).toEqual({
      prompt_tokens: 100,
      completion_tokens: 25,
      total_tokens: 125,
      prompt_tokens_details: { cached_tokens: 100 },
      completion_tokens_details: { reasoning_tokens: 25 },
    })
    expect(resolved.evidence).toMatchObject({ source: "network", scope: "request", fidelity: "exact" })
  })

  test("uses only a confirmed post-turn context pill", () => {
    const resolved = resolveUsage({
      measurement: {
        scope: "context",
        source: "dom-pill",
        fidelity: "confirmed",
        totalTokens: 500,
        observation: { before: 450, networkComplete: 450, settled: 500 },
      },
      promptTokens: 2,
      completionText: "done",
    })

    expect(resolved.usage.total_tokens).toBe(500)
    expect(resolved.usage.prompt_tokens + resolved.usage.completion_tokens).toBe(500)
    expect(resolved.evidence.observation).toEqual({ before: 450, networkComplete: 450, settled: 500 })
  })

  test("adds retained context only for a continued-thread estimate", () => {
    const continued = resolveUsage({
      promptTokens: 10,
      completionText: "done",
      retainedContextTokens: 400,
      continued: true,
    })
    const fresh = resolveUsage({
      promptTokens: 10,
      completionText: "done",
      retainedContextTokens: 400,
      continued: false,
    })

    expect(continued.usage.prompt_tokens).toBe(410)
    expect(continued.evidence).toMatchObject({ source: "estimate", retainedContextTokens: 400 })
    expect(fresh.usage.prompt_tokens).toBe(10)
    expect(fresh.evidence.retainedContextTokens).toBeUndefined()
  })

  test("rejects malformed measurements and keeps all output finite and nonnegative", () => {
    const resolved = resolveUsage({
      measurement: {
        scope: "request",
        source: "network",
        fidelity: "exact",
        promptTokens: -1,
        completionTokens: Number.NaN,
      },
      promptTokens: -5,
      completionText: "done",
    })

    expect(resolved.evidence.source).toBe("estimate")
    expect(resolved.usage.prompt_tokens).toBe(0)
    expect(resolved.usage.completion_tokens).toBeGreaterThanOrEqual(0)
    expect(resolved.usage.prompt_tokens + resolved.usage.completion_tokens).toBe(resolved.usage.total_tokens)
  })
})
