import { describe, expect, test } from "bun:test"
import { DEFAULT_MODEL_ID, MODEL_IDS, resolveModelProfile } from "./modelProfiles.mjs"

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
  "CM_Opus 5 - Auto",
  "CM_Opus 5 - Medium",
  "CM_Opus 5 - High",
  "CM_Opus 5 - Extra High",
  "CM_Opus 5 - Max",
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

  test("uses the project Sol Medium agent as the fallback", () => {
    expect(DEFAULT_MODEL_ID).toBe("CM_GPT-5.6 Sol - Medium")
    expect(resolveModelProfile("legacy-or-unknown")).toEqual(resolveModelProfile(DEFAULT_MODEL_ID))
  })
})
