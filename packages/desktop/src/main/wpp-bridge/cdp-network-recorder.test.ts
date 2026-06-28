import { describe, expect, test } from "bun:test"
import { reduceCdpNetworkEvent, summarizeCdpWindow } from "./cdp-network-recorder"

describe("cdp network reducer", () => {
  test("summarizes a completed model request", () => {
    const records = []

    reduceCdpNetworkEvent(records, "Network.requestWillBeSent", {
      requestId: "1",
      request: { method: "POST", url: "https://open-web-assistant-cs.wpp.ai/v1/chat/completions" },
    }, 100)
    reduceCdpNetworkEvent(records, "Network.responseReceived", {
      requestId: "1",
      response: { status: 200 },
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
