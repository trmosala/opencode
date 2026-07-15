import { describe, expect, test } from "bun:test"
import { MODEL_IDS, resolveModelProfile } from "./modelProfiles.mjs"

describe("CookieMonster model profiles", () => {
  test("routes stable OpenCode model ids to the current WPP roster", () => {
    expect(resolveModelProfile("o1-code")).toEqual({
      agentName: "CookieMonster_Opus 4.8 - Extra High",
      toolFormat: "xml",
    })
    expect(resolveModelProfile("o1-code-builder")).toEqual({
      agentName: "CookieMonster_GPT-5.5 - Extra High",
      toolFormat: "xml",
    })
    expect(MODEL_IDS).toEqual(["o1-code", "o1-code-builder"])
  })

  test("unknown model ids use the default CookieMonster profile", () => {
    expect(resolveModelProfile("legacy-or-unknown")).toEqual(resolveModelProfile("o1-code"))
  })
})
