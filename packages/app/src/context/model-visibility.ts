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
  ["CM_Gemini4_Carbon_Low", "CM_Gemini4_Carbon"],
  ["CM_Gemini4_Carbon_Medium", "CM_Gemini4_Carbon"],
  ["CM_Gemini4_Carbon_High", "CM_Gemini4_Carbon"],
  ["CM_Gemini4_Low", "CM_Gemini4"],
  ["CM_Gemini4_Medium", "CM_Gemini4"],
  ["CM_Gemini4_High", "CM_Gemini4"],
])

// Families whose fixed routes are not advertised. An effort-shaped custom id under one of these
// stays visible; a family that is not listed here still folds by suffix.
const knownFamilies = new Set([...cookieMonsterFamilies.values(), "CM_GPT6.1_Sol"])

// Longer suffixes first. " - Extra High" also ends in " - High", and "_XHigh" also ends in "_High".
const effortSuffixes = [
  " - Extra High",
  " - Medium",
  " - High",
  " - Low",
  " - Max",
  "_XHigh",
  "_Medium",
  "_High",
  "_Low",
  "_Max",
  "-XHigh",
  "-Medium",
  "-High",
  "-Auto",
  "-Max",
]

function cookieMonsterFamily(modelID: string) {
  const listed = cookieMonsterFamilies.get(modelID)
  if (listed) return listed
  const suffix = effortSuffixes.find((item) => modelID.endsWith(item))
  if (!suffix || modelID.length === suffix.length) return
  const family = modelID.slice(0, -suffix.length)
  if (knownFamilies.has(family)) return
  return family
}

export function isSupersededCookieMonsterModel(
  model: { providerID: string; modelID: string },
  available: readonly { id: string; provider: { id: string } }[],
) {
  if (model.providerID !== "cookiemonster") return false
  const family = cookieMonsterFamily(model.modelID)
  return family !== undefined && available.some((item) => item.provider.id === model.providerID && item.id === family)
}
