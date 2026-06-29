import { describe, expect, test } from "bun:test"
import { decideCaptureVerdict, type CdpNetworkSummary } from "./capture-verdict"

const witness = (overrides: Partial<CdpNetworkSummary> = {}): CdpNetworkSummary => ({
  cdpRequestSeen: false,
  cdpStatus: null,
  cdpBytes: 0,
  cdpFinished: false,
  cdpFailed: false,
  failureText: null,
  eventSourceMessages: 0,
  ...overrides,
})

describe("decideCaptureVerdict", () => {
  test("accepts page-recorder network output", () => {
    expect(decideCaptureVerdict({
      responseSource: "network",
      pageRecorderRequestSeen: true,
      witness: witness({ cdpRequestSeen: true, cdpFinished: true }),
    })).toEqual({ accept: true, verdict: "network", kind: null, message: null })
  })

  test("rejects DOM fallback when CDP saw a failed request", () => {
    expect(decideCaptureVerdict({
      responseSource: "dom",
      witness: witness({ cdpRequestSeen: true, cdpFailed: true, failureText: "net::ERR_FAILED" }),
    })).toMatchObject({ accept: false, kind: "wpp_request_failed" })
  })

  test("rejects DOM fallback when CDP saw a completed request the parser missed", () => {
    expect(decideCaptureVerdict({
      responseSource: "dom",
      witness: witness({ cdpRequestSeen: true, cdpFinished: true }),
    })).toMatchObject({ accept: false, kind: "recorder_parser_miss" })
  })

  test("rejects DOM fallback when no model request was observed", () => {
    expect(decideCaptureVerdict({
      responseSource: "dom",
      witness: witness(),
    })).toMatchObject({ accept: false, kind: "submit_or_ui_failure" })
  })

  test("inlines branch-deciding witness facts in the failure message", () => {
    const verdict = decideCaptureVerdict({
      responseSource: "dom",
      pageRecorderRequestSeen: false,
      witness: witness({
        cdpRequestSeen: true,
        cdpFinished: true,
        cdpStatus: 200,
        cdpBytes: 1234,
        requestType: "Fetch",
        mimeType: "text/event-stream",
        targetType: "worker",
        url: "https://abc.lambda-url.eu-west-1.on.aws/",
      }),
    })
    expect(verdict.kind).toBe("recorder_parser_miss")
    expect(verdict.message).toContain("recorderSawRequest=false")
    expect(verdict.message).toContain("cdpTarget=worker")
    expect(verdict.message).toContain("cdpMime=text/event-stream")
    expect(verdict.message).toContain("host=abc.lambda-url.eu-west-1.on.aws")
  })
})
