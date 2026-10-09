import { describe, expect, test } from "bun:test"
import { isSupersededCookieMonsterModel } from "./model-visibility"

const families = [
  {
    id: "CM_GPT6_Sol",
    fixed: ["CM_GPT6_Sol_Low", "CM_GPT6_Sol_Medium", "CM_GPT6_Sol_High", "CM_GPT6_Sol_XHigh"],
  },
  {
    id: "CM_GPT6_Astra",
    fixed: [
      "CM_GPT6_Astra_Low",
      "CM_GPT6_Astra_Medium",
      "CM_GPT6_Astra_High",
      "CM_GPT6_Astra_XHigh",
      "CM_GPT6_Astra_Max",
    ],
  },
  {
    id: "CM_GPT-5.6 Sol",
    fixed: [
      "CM_GPT-5.6 Sol - Low",
      "CM_GPT-5.6 Sol - Medium",
      "CM_GPT-5.6 Sol - High",
      "CM_GPT-5.6 Sol - Extra High",
      "CM_GPT-5.6 Sol - Max",
      "CM_GPT-5.6-Sol_High",
    ],
  },
  {
    id: "CM_Opus5.5",
    fixed: ["CM_Opus5.5-Auto", "CM_Opus5.5-Medium", "CM_Opus5.5-High", "CM_Opus5.5-XHigh", "CM_Opus5.5-Max"],
  },
  {
    id: "CM_Gemini-3.7-Flash",
    fixed: ["CM_Gemini-3.7-Flash_Low", "CM_Gemini-3.7-Flash_Medium", "CM_Gemini-3.7-Flash_High"],
  },
]
const available = families.map((family) => ({ id: family.id, provider: { id: "cookiemonster" } }))
const fixed = families.flatMap((family) => family.fixed.map((id) => [id, family.id]))

describe("CookieMonster default model visibility", () => {
  test.each(fixed)("supersedes fixed route %s with family %s", (modelID, familyID) => {
    expect(
      isSupersededCookieMonsterModel({ providerID: "cookiemonster", modelID }, [
        { id: familyID, provider: { id: "cookiemonster" } },
      ]),
    ).toBe(true)
  })

  test.each(fixed)("keeps fixed route %s when family %s is absent", (modelID, familyID) => {
    expect(
      isSupersededCookieMonsterModel(
        { providerID: "cookiemonster", modelID },
        available.filter((model) => model.id !== familyID),
      ),
    ).toBe(false)
  })

  test("does not use a matching family from another provider", () => {
    expect(
      isSupersededCookieMonsterModel({ providerID: "cookiemonster", modelID: "CM_GPT6_Sol_High" }, [
        { id: "CM_GPT6_Sol", provider: { id: "custom" } },
      ]),
    ).toBe(false)
  })

  test("does not supersede routes on another provider", () => {
    expect(
      isSupersededCookieMonsterModel({ providerID: "custom", modelID: "CM_GPT6_Sol_High" }, [
        ...available,
        { id: "CM_GPT6_Sol", provider: { id: "custom" } },
      ]),
    ).toBe(false)
  })

  test.each([...families.map((family) => family.id), "CM_GPT6.1_Sol"])("keeps family route %s", (modelID) => {
    expect(isSupersededCookieMonsterModel({ providerID: "cookiemonster", modelID }, available)).toBe(false)
  })

  test.each([
    "CM_GPT6_Sol_Max",
    "CM_GPT6_Sol_High_Custom",
    "CM_GPT6_Astra_Custom",
    "CM_GPT-5.6 Sol - Custom",
    "CM_Opus5.5-Custom",
    "CM_Gemini-3.7-Flash_Custom",
    "CM_GPT6.1_Sol_High",
    "unrelated",
    "toString",
  ])("keeps unrelated or custom route %s", (modelID) => {
    expect(isSupersededCookieMonsterModel({ providerID: "cookiemonster", modelID }, available)).toBe(false)
  })

  test("keeps a fixed route when no models are available", () => {
    expect(isSupersededCookieMonsterModel({ providerID: "cookiemonster", modelID: "CM_GPT6_Sol_High" }, [])).toBe(false)
  })
})
