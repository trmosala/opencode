import { describe, expect, test } from "bun:test"
import {
  assertCapabilityResponse,
  buildCapabilityProbeJob,
  CM_CAPABILITY_PROBE_PROMPT,
  CM_CAPABILITY_PROBE_TYPE,
  CM_CAPABILITY_RESPONSE,
  CM_PHASE_CAPABILITY_RESPONSE,
} from "./protocol.mjs"

describe("CookieMonster protocol capability", () => {
  test("uses a probe that does not disclose the expected response", () => {
    expect(JSON.parse(CM_CAPABILITY_PROBE_PROMPT)).toEqual({ type: CM_CAPABILITY_PROBE_TYPE, version: 1 })
    expect(CM_CAPABILITY_PROBE_PROMPT).not.toContain(CM_CAPABILITY_RESPONSE)
  })

  test("does not copy conversation or continuity payloads into the probe", () => {
    const probe = buildCapabilityProbeJob({
      payload: {
        prompt: "private conversation",
        images: [{ data: "private image" }],
        model: "CM_Opus 5 - Extra High",
        target: "coding-agent",
        url: "https://example.test",
        sessionKey: "private-session",
        continueThread: true,
        privateFutureField: "must not leak",
      },
    })
    expect(probe.payload).toEqual({
      prompt: CM_CAPABILITY_PROBE_PROMPT,
      images: [],
      target: "coding-agent",
      url: "https://example.test",
      model: "CM_Opus 5 - Extra High",
      sessionKey: "",
      subagent: false,
      continueThread: false,
      verboseRecorder: false,
    })
    expect(JSON.stringify(probe)).not.toContain("private conversation")
    expect(JSON.stringify(probe)).not.toContain("private-session")
    expect(JSON.stringify(probe)).not.toContain("must not leak")
  })

  test("requests and requires phase support for declared GPT profiles", () => {
    for (const model of [
      "CM_GPT-5.6 Sol - High",
      "CM_GPT6_Sol_High",
      "CM_GPT6_Astra_High",
      "CM_GPT6.1_Sol",
      "CM_GPT6_Sol",
      "CM_GPT6_Astra",
      "CM_GPT-5.6 Sol",
      "CM_GPT6.1_Sol_Low",
      "CM_GPT6.1_Sol_Medium",
      "CM_GPT6.1_Sol_High",
      "CM_GPT6.1_Sol_XHigh",
      "CM_GPT6.1_Sol_Max",
    ]) {
      const probe = buildCapabilityProbeJob({ payload: { model } })

      expect(JSON.parse(probe.payload.prompt)).toEqual({
        type: CM_CAPABILITY_PROBE_TYPE,
        version: 1,
        features: ["assistant_phase"],
      })
      expect(() => assertCapabilityResponse({ finalText: CM_PHASE_CAPABILITY_RESPONSE }, model)).not.toThrow()
      expect(() => assertCapabilityResponse({ finalText: CM_CAPABILITY_RESPONSE }, model)).toThrow(
        /does not advertise CM_REQUEST_V1 support/,
      )
    }
  })

  test("keeps Opus and Gemini families on the existing non-phase capability", () => {
    for (const model of ["CM_Opus5.5", "CM_Gemini-3.7-Flash"]) {
      expect(buildCapabilityProbeJob({ payload: { model } }).payload.prompt).toBe(CM_CAPABILITY_PROBE_PROMPT)
      expect(() => assertCapabilityResponse({ finalText: CM_CAPABILITY_RESPONSE }, model)).not.toThrow()
    }
  })

  test("accepts only the exact advertised capability", () => {
    expect(() =>
      assertCapabilityResponse({ finalText: ` ${CM_CAPABILITY_RESPONSE}\n` }, "CM_Opus 5 - Extra High"),
    ).not.toThrow()
    expect(() => assertCapabilityResponse({ finalText: "I can help" }, "CM_Opus 5 - Extra High")).toThrow(
      /does not advertise CM_REQUEST_V1 support/,
    )
  })

  test("reads the normal nested worker response shape", () => {
    expect(() =>
      assertCapabilityResponse({ response: { finalText: CM_CAPABILITY_RESPONSE } }, "CM_Opus 5 - Extra High"),
    ).not.toThrow()
  })
})
