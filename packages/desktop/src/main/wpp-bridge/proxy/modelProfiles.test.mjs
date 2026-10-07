import { describe, expect, test } from "bun:test"
import {
  DEFAULT_MODEL_ID,
  MODEL_IDS,
  RENAMED_MODEL_IDS,
  resolveModelProfile,
  resolveRequestModelProfile,
} from "./modelProfiles.mjs"
import { listModels } from "./openaiCompat.mjs"

const PROJECT_AGENTS = [
  "CM_GPT6_Sol_Low",
  "CM_GPT6_Sol_Medium",
  "CM_GPT6_Sol_High",
  "CM_GPT6_Sol_XHigh",
  "CM_GPT6_Astra_Low",
  "CM_GPT6_Astra_Medium",
  "CM_GPT6_Astra_High",
  "CM_GPT6_Astra_XHigh",
  "CM_GPT6_Astra_Max",
  "CM_GPT-5.6 Sol - Low",
  "CM_GPT-5.6 Sol - Medium",
  "CM_GPT-5.6 Sol - High",
  "CM_GPT-5.6 Sol - Extra High",
  "CM_GPT-5.6 Sol - Max",
  "CM_GPT-5.6-Sol_High",
  "CM_Opus5.5-Auto",
  "CM_Opus5.5-Medium",
  "CM_Opus5.5-High",
  "CM_Opus5.5-XHigh",
  "CM_Opus5.5-Max",
  "CM_Gemini-3.7-Flash_Low",
  "CM_Gemini-3.7-Flash_Medium",
  "CM_Gemini-3.7-Flash_High",
]

describe("CookieMonster model profiles", () => {
  test("exposes the WPP project roster under the exact agent names", () => {
    expect(MODEL_IDS).toEqual([...PROJECT_AGENTS, "CM_GPT6.1_Sol"])
    for (const agentName of PROJECT_AGENTS) {
      expect(resolveModelProfile(agentName)).toEqual({
        agentName,
        toolFormat: "xml",
        ...(agentName.startsWith("CM_GPT") ? { commentaryPhase: true } : {}),
      })
    }
  })

  test("advertises the renamed Opus High model in the discovery response", () => {
    const models = listModels()
    expect(models.object).toBe("list")
    expect(models.data.map((model) => model.id)).toEqual([...PROJECT_AGENTS, "CM_GPT6.1_Sol"])
    expect(models.data.find((model) => model.id === "CM_Opus5.5-High")).toEqual({
      id: "CM_Opus5.5-High",
      object: "model",
      created: 0,
      owned_by: "cookiemonster",
    })
    expect(models.data.some((model) => model.id === "CM_Opus 5 - High")).toBe(false)
  })

  for (const [retired, successor] of RENAMED_MODEL_IDS) {
    test(`resolves the retired ${retired} ID to ${successor} without advertising it`, () => {
      expect(MODEL_IDS).toContain(successor)
      expect(resolveModelProfile(retired)).toBe(resolveModelProfile(successor))
      expect(resolveModelProfile(retired)).toEqual({ agentName: successor, toolFormat: "xml" })
      expect(MODEL_IDS).not.toContain(retired)
      expect(listModels().data.some((model) => model.id === retired)).toBe(false)
    })
  }

  test("discovers one Sol 6.1 family without advertising fixed agent routes", () => {
    expect(listModels().data.filter((model) => model.id.startsWith("CM_GPT6.1"))).toEqual([
      { id: "CM_GPT6.1_Sol", object: "model", created: 0, owned_by: "cookiemonster" },
    ])
    expect(resolveModelProfile("CM_GPT6.1_Sol")).toEqual({
      agentName: "CM_GPT6.1_Sol_Medium",
      defaultReasoningEffort: "medium",
      reasoningEfforts: {
        medium: "CM_GPT6.1_Sol_Medium",
        high: "CM_GPT6.1_Sol_High",
      },
      toolFormat: "xml",
      commentaryPhase: true,
    })
  })

  for (const [effort, agentName] of [
    ["medium", "CM_GPT6.1_Sol_Medium"],
    ["high", "CM_GPT6.1_Sol_High"],
  ]) {
    test(`routes Sol 6.1 ${effort} without changing the API model ID`, () => {
      const body = Object.freeze({ model: "CM_GPT6.1_Sol", reasoning_effort: effort })
      expect(resolveRequestModelProfile(body)).toEqual({
        ...resolveModelProfile("CM_GPT6.1_Sol"),
        agentName,
      })
      expect(body.model).toBe("CM_GPT6.1_Sol")
      expect(resolveModelProfile("CM_GPT6.1_Sol").agentName).toBe("CM_GPT6.1_Sol_Medium")
    })

    test(`keeps hidden ${agentName} fixed for capability checks and requests`, () => {
      const profile = { agentName, toolFormat: "xml", commentaryPhase: true }
      expect(resolveModelProfile(agentName)).toEqual(profile)
      expect(MODEL_IDS).not.toContain(agentName)
      expect(resolveRequestModelProfile({ model: agentName })).toEqual(profile)
      for (const reasoning_effort of ["medium", "high", "low", null, 1, [], "constructor"]) {
        expect(resolveRequestModelProfile({ model: agentName, reasoning_effort })).toEqual(profile)
        expect(
          resolveRequestModelProfile({ model: "CM_GPT6.1_Sol", o1_code_model: agentName, reasoning_effort }),
        ).toEqual(profile)
      }
    })
  }

  test("defaults the family to medium only when reasoning_effort is omitted", () => {
    expect(resolveRequestModelProfile({ model: "CM_GPT6.1_Sol" })).toEqual(resolveModelProfile("CM_GPT6.1_Sol"))
    const body = Object.assign(Object.create({ reasoning_effort: "high" }), { model: "CM_GPT6.1_Sol" })
    expect(resolveRequestModelProfile(body).agentName).toBe("CM_GPT6.1_Sol_Medium")
  })

  for (const effort of [
    undefined,
    null,
    0,
    1,
    true,
    false,
    [],
    ["medium"],
    ["high"],
    {},
    { toString: () => "medium" },
    "",
    "low",
    "xhigh",
    "max",
    "auto",
    "Medium",
    " high ",
    "constructor",
    "toString",
    "__proto__",
    "hasOwnProperty",
    "valueOf",
  ]) {
    test(`rejects malformed or unsupported family effort ${JSON.stringify(effort)}`, () => {
      for (const body of [
        { model: "CM_GPT6.1_Sol", reasoning_effort: effort },
        { model: DEFAULT_MODEL_ID, o1_code_model: "CM_GPT6.1_Sol", reasoning_effort: effort },
      ]) {
        expect(() => resolveRequestModelProfile(body)).toThrow(
          expect.objectContaining({ statusCode: 400, type: "invalid_reasoning_effort" }),
        )
      }
    })
  }

  for (const model of [
    "CM_GPT6.1",
    "CM_GPT6.1_Unknown",
    "CM_GPT6.1_Astra",
    "CM_GPT6.1_Sol_Low",
    "CM_GPT6.1_Sol_XHigh",
    "CM_GPT6.1_Sol_constructor",
  ]) {
    test(`rejects unknown 6.1 model ${model} rather than using the legacy fallback`, () => {
      for (const resolve of [
        () => resolveModelProfile(model),
        () => resolveRequestModelProfile({ model }),
        () => resolveRequestModelProfile({ model: DEFAULT_MODEL_ID, o1_code_model: model }),
      ]) {
        expect(resolve).toThrow(expect.objectContaining({ statusCode: 400, type: "invalid_model" }))
      }
    })
  }

  test("resolves the effective diagnostic override before the request model and effort", () => {
    expect(
      resolveRequestModelProfile({
        model: "CM_GPT6.1_Sol_Low",
        o1_code_model: "CM_GPT6.1_Sol",
        reasoning_effort: "high",
      }),
    ).toMatchObject({ agentName: "CM_GPT6.1_Sol_High", toolFormat: "xml", commentaryPhase: true })
    expect(resolveRequestModelProfile({ o1_code_model: "CM_GPT6.1_Sol" }).agentName).toBe("CM_GPT6.1_Sol_Medium")
    expect(
      resolveRequestModelProfile({ model: "CM_GPT6.1_Sol", o1_code_model: "CM_Opus5.5-High", reasoning_effort: null }),
    ).toEqual(resolveModelProfile("CM_Opus5.5-High"))
    expect(
      resolveRequestModelProfile({ model: "CM_GPT6.1_Sol", o1_code_model: "custom-agent", reasoning_effort: null }),
    ).toEqual({ ...resolveModelProfile(DEFAULT_MODEL_ID), agentName: "custom-agent" })
    expect(
      resolveRequestModelProfile({ model: DEFAULT_MODEL_ID, o1_code_model: "CM_Opus 5 - High" }),
    ).toEqual({ agentName: "CM_Opus 5 - High", toolFormat: "xml" })
    for (const o1_code_model of ["", null, false, 0]) {
      expect(
        resolveRequestModelProfile({ model: "CM_GPT6.1_Sol", o1_code_model, reasoning_effort: "high" }).agentName,
      ).toBe("CM_GPT6.1_Sol_High")
    }
  })

  test("preserves every legacy request route, renamed model and unknown-model fallback", () => {
    for (const model of [
      ...PROJECT_AGENTS,
      ...RENAMED_MODEL_IDS.keys(),
      "legacy-or-unknown",
      "constructor",
      "toString",
      "__proto__",
      "hasOwnProperty",
      undefined,
      null,
    ]) {
      for (const reasoning_effort of [undefined, null, "high", "unsupported"]) {
        expect(resolveRequestModelProfile({ model, reasoning_effort })).toEqual(resolveModelProfile(model))
      }
    }
    expect(resolveRequestModelProfile()).toBe(resolveModelProfile(DEFAULT_MODEL_ID))
  })

  test("uses the project Sol High agent as the fallback", () => {
    expect(DEFAULT_MODEL_ID).toBe("CM_GPT-5.6-Sol_High")
    expect(resolveModelProfile("legacy-or-unknown")).toEqual(resolveModelProfile(DEFAULT_MODEL_ID))
  })

  test("falls back for inherited object keys", () => {
    for (const id of ["constructor", "toString", "__proto__", "hasOwnProperty"]) {
      expect(resolveModelProfile(id)).toBe(resolveModelProfile(DEFAULT_MODEL_ID))
    }
  })
})
