import { describe, expect, test } from "bun:test"
import { DEFAULT_MODEL_ID, MODEL_IDS, resolveModelProfile } from "./modelProfiles.mjs"

const PROJECT_AGENTS = [
  "CM_GPT-5.6 Sol - Low",
  "CM_GPT-5.6 Sol - Medium",
  "CM_GPT-5.6 Sol - High",
  "CM_GPT-5.6 Sol - Extra High",
  "CM_GPT-5.5 - Low",
  "CM_GPT-5.5 - Medium",
  "CM_GPT-5.5 - High",
  "CM_GPT-5.5 - Extra High",
  "CM_Opus 4.8 - Low",
  "CM_Opus 4.8 - Auto",
  "CM_Opus 4.8 - High",
  "CM_Opus 4.8 - Extra High",
  "CM_Opus 5 - Auto",
  "CM_Opus 5 - Medium",
  "CM_Opus 5 - High",
  "CM_Opus 5 - Extra High",
  "CM_Opus 5 - Max",
]

describe("CookieMonster model profiles", () => {
  test("exposes the WPP project roster under the exact agent names", () => {
    expect(MODEL_IDS).toEqual(PROJECT_AGENTS)
    for (const agentName of PROJECT_AGENTS) {
      expect(resolveModelProfile(agentName)).toEqual({ agentName, toolFormat: "xml" })
    }
  })

  test("uses the project Opus Extra High agent as the fallback", () => {
    expect(DEFAULT_MODEL_ID).toBe("CM_Opus 4.8 - Extra High")
    expect(resolveModelProfile("legacy-or-unknown")).toEqual(resolveModelProfile(DEFAULT_MODEL_ID))
  })
})
