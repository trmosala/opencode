import type { WebContents } from "electron"
import { installInRootAndChildTargets } from "./cdp-targets"
import { isWppModelRequest } from "./model-request-filter"
import type { CdpNetworkSummary } from "./capture-verdict"

type CdpRecord = {
  key: string
  requestId: string
  firstSeenAt: number
  updatedAt: number
  url: string
  method: string
  status: number | null
  bytes: number
  finished: boolean
  failed: boolean
  failureText: string | null
  eventSourceMessages: number
}

const MAX_RECORDS = 100

export type NetworkWitness = {
  summarizeWindow: (sinceMs: number) => CdpNetworkSummary
}

export async function installNetworkWitness(contents: WebContents): Promise<NetworkWitness> {
  const dbg = contents.debugger
  const reducer = createCdpNetworkReducer()

  dbg.on("message", (_event, method, params, sessionId) => {
    reducer.handle(method, params, typeof sessionId === "string" ? sessionId : undefined)
  })

  await installInRootAndChildTargets(contents, async (sessionId) => {
    await dbg.sendCommand("Network.enable", {}, sessionId)
  })

  return {
    summarizeWindow: (sinceMs) => reducer.summarizeWindow(sinceMs),
  }
}

export function createCdpNetworkReducer(now = () => Date.now()) {
  const records: CdpRecord[] = []

  return {
    handle(method: string, params: unknown, sessionId?: string) {
      reduceCdpNetworkEvent(records, method, params, now(), sessionId)
      if (records.length > MAX_RECORDS) records.splice(0, records.length - MAX_RECORDS)
    },
    summarizeWindow(sinceMs: number) {
      return summarizeCdpWindow(records, sinceMs)
    },
    records,
  }
}

export function reduceCdpNetworkEvent(
  records: CdpRecord[],
  method: string,
  params: unknown,
  ts: number,
  sessionId = "",
) {
  const value = params && typeof params === "object" ? params as Record<string, unknown> : {}
  const key = requestKey(value.requestId, sessionId)
  if (!key) return

  if (method === "Network.requestWillBeSent") {
    const request = value.request && typeof value.request === "object"
      ? value.request as { url?: string; method?: string }
      : {}
    if (!isWppModelRequest(request)) return
    records.push({
      key,
      requestId: String(value.requestId),
      firstSeenAt: ts,
      updatedAt: ts,
      url: String(request.url || ""),
      method: String(request.method || "GET").toUpperCase(),
      status: null,
      bytes: 0,
      finished: false,
      failed: false,
      failureText: null,
      eventSourceMessages: 0,
    })
    return
  }

  const record = records.find((candidate) => candidate.key === key)
  if (!record) return

  record.updatedAt = ts

  if (method === "Network.responseReceived") {
    const response = value.response && typeof value.response === "object"
      ? value.response as { status?: number }
      : {}
    record.status = Number(response.status) || record.status
    return
  }

  if (method === "Network.dataReceived") {
    record.bytes += Number(value.encodedDataLength ?? value.dataLength) || 0
    return
  }

  if (method === "Network.eventSourceMessageReceived") {
    record.eventSourceMessages += 1
    return
  }

  if (method === "Network.loadingFinished") {
    record.finished = true
    record.bytes = Math.max(record.bytes, Number(value.encodedDataLength) || 0)
    return
  }

  if (method === "Network.loadingFailed") {
    record.failed = true
    record.failureText = String(value.errorText || "Network request failed.")
  }
}

export function summarizeCdpWindow(records: CdpRecord[], sinceMs: number): CdpNetworkSummary {
  const relevant = records.filter((record) => record.firstSeenAt >= sinceMs)
  const record = relevant.at(-1)

  return {
    cdpRequestSeen: Boolean(record),
    cdpStatus: record?.status || null,
    cdpBytes: record?.bytes || 0,
    cdpFinished: record?.finished === true,
    cdpFailed: record?.failed === true,
    failureText: record?.failureText || null,
    eventSourceMessages: record?.eventSourceMessages || 0,
    requestCount: relevant.length,
    url: record?.url || null,
    method: record?.method || null,
  }
}

function requestKey(requestId: unknown, sessionId: string) {
  if (typeof requestId !== "string" || !requestId) return ""
  return `${sessionId || "root"}:${requestId}`
}
