import { describe, expect, test } from "bun:test"
import { createCdpNetworkReducer, reduceCdpNetworkEvent, summarizeCdpWindow } from "./cdp-network-recorder"

describe("cdp network reducer", () => {
  test("summarizes a completed model request", () => {
    const records = []

    reduceCdpNetworkEvent(records, "Network.requestWillBeSent", {
      requestId: "1",
      type: "Fetch",
      initiator: { type: "script" },
      request: { method: "POST", url: "https://open-web-assistant-cs.wpp.ai/v1/chat/completions" },
    }, 100)
    reduceCdpNetworkEvent(records, "Network.responseReceived", {
      requestId: "1",
      response: { status: 200, mimeType: "text/event-stream" },
    }, 110)
    reduceCdpNetworkEvent(records, "Network.dataReceived", {
      requestId: "1",
      dataLength: 5,
      encodedDataLength: 7,
    }, 120)
    reduceCdpNetworkEvent(records, "Network.eventSourceMessageReceived", { requestId: "1" }, 130)
    reduceCdpNetworkEvent(records, "Network.loadingFinished", {
      requestId: "1",
      encodedDataLength: 9,
    }, 140)

    expect(summarizeCdpWindow(records, 90)).toMatchObject({
      cdpRequestSeen: true,
      cdpStatus: 200,
      cdpBytes: 9,
      cdpFinished: true,
      cdpFailed: false,
      eventSourceMessages: 1,
      requestCount: 1,
      requestType: "Fetch",
      mimeType: "text/event-stream",
      initiatorType: "script",
      targetType: "page",
    })
  })

  test("attributes a worker-issued request to its target kind", () => {
    const reducer = createCdpNetworkReducer(() => 100)

    reducer.handle("Target.attachedToTarget", {
      sessionId: "S1",
      targetInfo: { type: "worker" },
    })
    reducer.handle("Network.requestWillBeSent", {
      requestId: "1",
      type: "Fetch",
      request: { method: "POST", url: "https://abc.lambda-url.eu-west-1.on.aws/" },
    }, "S1")
    reducer.handle("Network.loadingFinished", { requestId: "1", encodedDataLength: 9 }, "S1")

    expect(reducer.summarizeWindow(90)).toMatchObject({
      cdpRequestSeen: true,
      cdpFinished: true,
      targetType: "worker",
    })
  })

  test("records failed model requests", () => {
    const records = []

    reduceCdpNetworkEvent(records, "Network.requestWillBeSent", {
      requestId: "1",
      request: { method: "POST", url: "https://open-web-assistant-cs.wpp.ai/v1/chat/completions" },
    }, 100)
    reduceCdpNetworkEvent(records, "Network.loadingFailed", {
      requestId: "1",
      errorText: "net::ERR_ABORTED",
    }, 120)

    expect(summarizeCdpWindow(records, 90)).toMatchObject({
      cdpRequestSeen: true,
      cdpFailed: true,
      failureText: "net::ERR_ABORTED",
    })
  })

  test("summarizes the SSE completion, not a trailing telemetry beacon", () => {
    const records = []

    // The model completion: text/event-stream, streamed bytes, finished 200.
    reduceCdpNetworkEvent(records, "Network.requestWillBeSent", {
      requestId: "completion",
      type: "Fetch",
      request: { method: "POST", url: "https://abc.lambda-url.eu-west-1.on.aws/" },
    }, 100)
    reduceCdpNetworkEvent(records, "Network.responseReceived", {
      requestId: "completion",
      response: { status: 200, mimeType: "text/event-stream" },
    }, 110)
    reduceCdpNetworkEvent(records, "Network.loadingFinished", { requestId: "completion", encodedDataLength: 1190 }, 120)

    // A trailing telemetry beacon fired AFTER the completion: tiny text/plain 204. This is what
    // .at(-1) used to pick.
    reduceCdpNetworkEvent(records, "Network.requestWillBeSent", {
      requestId: "beacon",
      type: "Fetch",
      request: { method: "POST", url: "https://abc.lambda-url.eu-west-1.on.aws/" },
    }, 130)
    reduceCdpNetworkEvent(records, "Network.responseReceived", {
      requestId: "beacon",
      response: { status: 204, mimeType: "text/plain" },
    }, 140)
    reduceCdpNetworkEvent(records, "Network.loadingFinished", { requestId: "beacon", encodedDataLength: 49 }, 150)

    expect(summarizeCdpWindow(records, 90)).toMatchObject({
      cdpRequestSeen: true,
      cdpStatus: 200,
      cdpBytes: 1190,
      mimeType: "text/event-stream",
      requestCount: 2,
    })
  })

  test("surfaces a failed completion over a finished beacon", () => {
    const records = []

    // Completion fails (no response / aborted).
    reduceCdpNetworkEvent(records, "Network.requestWillBeSent", {
      requestId: "completion",
      request: { method: "POST", url: "https://abc.lambda-url.eu-west-1.on.aws/" },
    }, 100)
    reduceCdpNetworkEvent(records, "Network.loadingFailed", { requestId: "completion", errorText: "net::ERR_FAILED" }, 110)

    // A later beacon finishes fine — must NOT mask the failure.
    reduceCdpNetworkEvent(records, "Network.requestWillBeSent", {
      requestId: "beacon",
      request: { method: "POST", url: "https://abc.lambda-url.eu-west-1.on.aws/" },
    }, 120)
    reduceCdpNetworkEvent(records, "Network.responseReceived", {
      requestId: "beacon",
      response: { status: 204, mimeType: "text/plain" },
    }, 130)
    reduceCdpNetworkEvent(records, "Network.loadingFinished", { requestId: "beacon", encodedDataLength: 49 }, 140)

    expect(summarizeCdpWindow(records, 90)).toMatchObject({
      cdpRequestSeen: true,
      cdpFailed: true,
      failureText: "net::ERR_FAILED",
    })
  })

  test("ignores filtered telemetry and tool requests", () => {
    const records = []

    reduceCdpNetworkEvent(records, "Network.requestWillBeSent", {
      requestId: "1",
      request: { method: "POST", url: "https://datadoghq.example/v1/input" },
    }, 100)
    reduceCdpNetworkEvent(records, "Network.requestWillBeSent", {
      requestId: "2",
      request: { method: "POST", url: "https://open-web-assistant-cs.wpp.ai/v1/tools/list" },
    }, 110)

    expect(summarizeCdpWindow(records, 90).cdpRequestSeen).toBe(false)
  })
})
