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
  // Diagnostics for recorder_parser_miss: the CDP resource type ("Fetch"/"XHR"/"Document"/…), the
  // response mimeType, the request initiator type, and the kind of target that issued it
  // ("page"/"iframe"/"worker"/"service_worker"/…). Together with pageRecorderRequestSeen these tell
  // whether the page recorder was structurally blind (request issued from a worker the fetch/XHR
  // patch never reached) or merely failed to parse a body it did see.
  type: string | null
  mimeType: string | null
  initiatorType: string | null
  targetType: string | null
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
  // sessionId -> target kind ("page"/"iframe"/"worker"/"service_worker"/…), learned from
  // Target.attachedToTarget. Lets a witnessed request report which target issued it, so a
  // worker-issued model POST (which the page recorder's fetch/XHR patch can never reach) is
  // distinguishable from one in a frame the recorder did patch.
  const sessionTargets = new Map<string, string>()

  return {
    handle(method: string, params: unknown, sessionId?: string) {
      if (method === "Target.attachedToTarget") {
        const value = params && typeof params === "object" ? params as Record<string, unknown> : {}
        const childSessionId = typeof value.sessionId === "string" ? value.sessionId : ""
        const info = value.targetInfo && typeof value.targetInfo === "object"
          ? value.targetInfo as { type?: string }
          : {}
        if (childSessionId && info.type) sessionTargets.set(childSessionId, String(info.type))
        return
      }
      reduceCdpNetworkEvent(records, method, params, now(), sessionId, sessionTargets)
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
  sessionTargets?: Map<string, string>,
) {
  const value = params && typeof params === "object" ? params as Record<string, unknown> : {}
  const key = requestKey(value.requestId, sessionId)
  if (!key) return

  if (method === "Network.requestWillBeSent") {
    const request = value.request && typeof value.request === "object"
      ? value.request as { url?: string; method?: string }
      : {}
    if (!isWppModelRequest(request)) return
    const initiator = value.initiator && typeof value.initiator === "object"
      ? value.initiator as { type?: string }
      : {}
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
      type: value.type ? String(value.type) : null,
      mimeType: null,
      initiatorType: initiator.type ? String(initiator.type) : null,
      targetType: sessionTargets?.get(sessionId) ?? (sessionId ? "child" : "page"),
    })
    return
  }

  const record = records.find((candidate) => candidate.key === key)
  if (!record) return

  record.updatedAt = ts

  if (method === "Network.responseReceived") {
    const response = value.response && typeof value.response === "object"
      ? value.response as { status?: number; mimeType?: string }
      : {}
    record.status = Number(response.status) || record.status
    if (response.mimeType) record.mimeType = String(response.mimeType)
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
  const record = selectPrimaryRecord(relevant)

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
    requestType: record?.type || null,
    mimeType: record?.mimeType || null,
    initiatorType: record?.initiatorType || null,
    targetType: record?.targetType || null,
  }
}

// A WPP turn fires several model-matching POSTs (observed: 4–5), of which the model completion is
// the SSE stream and the rest are short telemetry beacons (small text/plain 204s) — and a beacon is
// usually LAST. Picking .at(-1) therefore described a beacon, not the stream: cdpBytes/cdpMimeType
// pointed at the wrong request, and a completion that FAILED could be masked by a beacon that
// finished (misclassifying wpp_request_failed as recorder_parser_miss). Select the request that
// represents the model response instead: a failed one first (so a real failure surfaces over a
// finished beacon), then the stream (SSE mime / eventSource frames), then the byte-heaviest.
function selectPrimaryRecord(relevant: CdpRecord[]): CdpRecord | undefined {
  if (relevant.length === 0) return undefined
  const stream = relevant.filter(isStreamLikeRecord)
  const pool = stream.length > 0 ? stream : relevant
  const failed = pool.filter((record) => record.failed)
  if (failed.length > 0) return failed.at(-1)
  return pool.reduce((best, record) => (record.bytes >= best.bytes ? record : best))
}

function isStreamLikeRecord(record: CdpRecord): boolean {
  return String(record.mimeType || "").toLowerCase().includes("event-stream") || record.eventSourceMessages > 0
}

function requestKey(requestId: unknown, sessionId: string) {
  if (typeof requestId !== "string" || !requestId) return ""
  return `${sessionId || "root"}:${requestId}`
}
