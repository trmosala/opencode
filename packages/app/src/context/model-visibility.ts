const cookieMonsterFamilies = new Map([
  ["CM_GPT6_Sol_Low", "CM_GPT6_Sol"],
  ["CM_GPT6_Sol_Medium", "CM_GPT6_Sol"],
  ["CM_GPT6_Sol_High", "CM_GPT6_Sol"],
  ["CM_GPT6_Sol_XHigh", "CM_GPT6_Sol"],
  ["CM_GPT6_Astra_Low", "CM_GPT6_Astra"],
  ["CM_GPT6_Astra_Medium", "CM_GPT6_Astra"],
  ["CM_GPT6_Astra_High", "CM_GPT6_Astra"],
  ["CM_GPT6_Astra_XHigh", "CM_GPT6_Astra"],
  ["CM_GPT6_Astra_Max", "CM_GPT6_Astra"],
  ["CM_GPT-5.6 Sol - Low", "CM_GPT-5.6 Sol"],
  ["CM_GPT-5.6 Sol - Medium", "CM_GPT-5.6 Sol"],
  ["CM_GPT-5.6 Sol - High", "CM_GPT-5.6 Sol"],
  ["CM_GPT-5.6 Sol - Extra High", "CM_GPT-5.6 Sol"],
  ["CM_GPT-5.6 Sol - Max", "CM_GPT-5.6 Sol"],
  ["CM_GPT-5.6-Sol_High", "CM_GPT-5.6 Sol"],
  ["CM_Opus5.5-Auto", "CM_Opus5.5"],
  ["CM_Opus5.5-Medium", "CM_Opus5.5"],
  ["CM_Opus5.5-High", "CM_Opus5.5"],
  ["CM_Opus5.5-XHigh", "CM_Opus5.5"],
  ["CM_Opus5.5-Max", "CM_Opus5.5"],
  ["CM_Gemini-3.7-Flash_Low", "CM_Gemini-3.7-Flash"],
  ["CM_Gemini-3.7-Flash_Medium", "CM_Gemini-3.7-Flash"],
  ["CM_Gemini-3.7-Flash_High", "CM_Gemini-3.7-Flash"],
])

export function isSupersededCookieMonsterModel(
  model: { providerID: string; modelID: string },
  available: readonly { id: string; provider: { id: string } }[],
) {
  if (model.providerID !== "cookiemonster") return false
  const family = cookieMonsterFamilies.get(model.modelID)
  return family !== undefined && available.some((m) => m.provider.id === model.providerID && m.id === family)
}
