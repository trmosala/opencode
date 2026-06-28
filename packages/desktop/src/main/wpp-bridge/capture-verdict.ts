export type CaptureFailureKind = "wpp_request_failed" | "recorder_parser_miss" | "submit_or_ui_failure"

export type CdpNetworkSummary = {
  cdpRequestSeen: boolean
  cdpStatus: number | null
  cdpBytes: number
  cdpFinished: boolean
  cdpFailed: boolean
  failureText: string | null
  eventSourceMessages: number
  requestCount?: number
  url?: string | null
  method?: string | null
}

export type CaptureVerdict =
  | { accept: true; verdict: "network"; kind: null; message: null }
  | { accept: false; verdict: CaptureFailureKind; kind: CaptureFailureKind; message: string }

export type CaptureInput = {
  responseSource?: string | null
  pageRecorderRequestSeen?: boolean
  witness: CdpNetworkSummary
}

export function decideCaptureVerdict(input: CaptureInput): CaptureVerdict {
  if (input.responseSource === "network") {
    return { accept: true, verdict: "network", kind: null, message: null }
  }

  if (input.witness.cdpFailed) {
    return {
      accept: false,
      verdict: "wpp_request_failed",
      kind: "wpp_request_failed",
      message: input.witness.failureText || "WPP model request failed before the page recorder produced a trusted response.",
    }
  }

  if (input.witness.cdpRequestSeen && input.witness.cdpFinished) {
    return {
      accept: false,
      verdict: "recorder_parser_miss",
      kind: "recorder_parser_miss",
      message: "WPP model request completed, but the page recorder did not parse a trusted network response.",
    }
  }

  if (input.witness.cdpRequestSeen) {
    return {
      accept: false,
      verdict: "wpp_request_failed",
      kind: "wpp_request_failed",
      message: "WPP model request was observed but did not finish before capture completed.",
    }
  }

  return {
    accept: false,
    verdict: "submit_or_ui_failure",
    kind: "submit_or_ui_failure",
    message: input.pageRecorderRequestSeen
      ? "Page recorder observed a request, but CDP did not corroborate it during this worker run."
      : "No WPP model request was observed after prompt submission.",
  }
}

export function captureHealth(input: {
  responseSource?: string | null
  pageRecorderRequestSeen?: boolean
  parseComplete?: boolean
  retryCount?: number
  witness: CdpNetworkSummary
  verdict: CaptureVerdict
}) {
  return {
    cdpRequestSeen: input.witness.cdpRequestSeen,
    cdpStatus: input.witness.cdpStatus,
    cdpBytes: input.witness.cdpBytes,
    cdpFinished: input.witness.cdpFinished,
    cdpFailed: input.witness.cdpFailed,
    failureText: input.witness.failureText,
    eventSourceMessages: input.witness.eventSourceMessages,
    cdpRequestCount: input.witness.requestCount || 0,
    pageRecorderRequestSeen: input.pageRecorderRequestSeen === true,
    parseComplete: input.parseComplete === true,
    responseSourceAccepted: input.verdict.accept ? input.responseSource || null : null,
    lowFidelity: input.responseSource === "dom",
    retryCount: input.retryCount || 0,
    verdict: input.verdict.verdict,
  }
}

export function captureFailureError(verdict: CaptureVerdict, capture: ReturnType<typeof captureHealth>) {
  if (verdict.accept) return null

  const error = new Error(verdict.message) as Error & {
    statusCode: number
    type: string
    kind: CaptureFailureKind
    capture: ReturnType<typeof captureHealth>
    diagnostics: { capture: ReturnType<typeof captureHealth> }
  }
  error.statusCode = 502
  error.type = "o1_code_capture_failure"
  error.kind = verdict.kind
  error.capture = capture
  error.diagnostics = { capture }
  return error
}
