import { describe, expect, test } from "bun:test"
import { DEFAULT_MODEL_ID, MODEL_IDS, RENAMED_MODEL_IDS, resolveModelProfile } from "./modelProfiles.mjs"
import { listModels } from "./openaiCompat.mjs"

const PROJECT_AGENTS = [
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
    expect(MODEL_IDS).toEqual(PROJECT_AGENTS)
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
    expect(models.data.map((model) => model.id)).toEqual(PROJECT_AGENTS)
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
