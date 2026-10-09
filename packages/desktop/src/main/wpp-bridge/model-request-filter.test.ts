import { describe, expect, test } from "bun:test"
import vm from "node:vm"
import { isWppModelRequest, MODEL_REQUEST_FILTER_SOURCE } from "./model-request-filter"

describe("isWppModelRequest", () => {
  test("accepts a POST to the assistant chat endpoint", () => {
    expect(
      isWppModelRequest({
        method: "POST",
        url: "https://open-web-assistant-cs.wpp.ai/chat/abc/ai-assistant/completions",
      }),
    ).toBe(true)
  })

  test("rejects non-POST", () => {
    expect(isWppModelRequest({ method: "GET", url: "https://open-web-assistant-cs.wpp.ai/chat/abc" })).toBe(false)
  })

  test("rejects Heap analytics beacons (telemetry, not the model response)", () => {
    expect(
      isWppModelRequest({
        method: "POST",
        url: "https://c.eu.heap-api.com/api/capture/v2/identify",
      }),
    ).toBe(false)
    expect(isWppModelRequest({ method: "POST", url: "https://heapanalytics.com/h" })).toBe(false)
  })

  test("rejects datadog / RUM telemetry", () => {
    expect(isWppModelRequest({ method: "POST", url: "https://browser-intake-datadoghq.com/api/v2/rum" })).toBe(false)
    expect(isWppModelRequest({ method: "POST", url: "https://dataplane.rum.us5.datadoghq.com/" })).toBe(false)
  })

  test("rejects project/tools/oauth control-plane calls", () => {
    for (const path of ["/v1/project/x", "/v1/tools/x", "/v1/oauth/x"]) {
      expect(isWppModelRequest({ method: "POST", url: `https://open-web-assistant-cs.wpp.ai${path}` })).toBe(false)
    }
  })

  test.each([
    "https://www.google-analytics.com/g/collect",
    "https://events.launchdarkly.com/events/bulk/flags",
    "https://ogilvy.os.wpp.com/api/az/v5/users/me/permissions",
  ])("excludes background POSTs from both capture predicates: %s", (url) => {
    const window: { __o1CodeShouldRecordRequest?: (request: { method: string; url: string }) => boolean } = {}
    vm.runInNewContext(MODEL_REQUEST_FILTER_SOURCE, { window, URL, location: { href: "https://ogilvy.os.wpp.com/" } })
    const request = { method: "POST", url }
    expect(isWppModelRequest(request)).toBe(false)
    expect(window.__o1CodeShouldRecordRequest?.(request)).toBe(false)
  })
})
