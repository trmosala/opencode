import { mkdir, writeFile, readdir, unlink } from "node:fs/promises"
import { join } from "node:path"
import { redact } from "./policy.mjs"

const DEFAULT_LOG_KEEP = 200
// Only generated run-JSON files (ISO-timestamp prefix). Anything else in the dir — and the
// root debug log, which lives outside logDir — is never touched by pruning.
const RUN_LOG_PATTERN = /^\d{4}-\d{2}-\d{2}T.*\.json$/u

export async function writeRunLog(record) {
  if (process.env.O1_CODE_PROXY_LOGS === "0") {
    return null
  }

  const logDir = process.env.O1_CODE_PROXY_LOG_DIR || join(process.cwd(), "logs")
  const fileName = `${new Date().toISOString().replace(/[:.]/g, "-")}-${record.id || "run"}.json`
  const path = join(logDir, fileName)

  await mkdir(logDir, { recursive: true })
  await writeFile(path, `${JSON.stringify(redact(runLogRecord(record)), null, 2)}\n`, "utf8")
  await pruneRunLogs(logDir).catch(() => {})

  return path
}

// System instructions, tool results, and user content are necessary for the live relay but should
// not become a second durable transcript in diagnostic logs. Raw payload logging is an explicit
// troubleshooting opt-in; normal logs retain only enough structure to diagnose routing and size.
export function runLogRecord(record, includePayloads = process.env.O1_CODE_PROXY_LOG_PAYLOADS === "1") {
  if (includePayloads) return record
  return omitNestedPayloads({
    ...record,
    ...(Object.hasOwn(record, "request") ? { request: requestSummary(record.request) } : {}),
  })
}

function requestSummary(request) {
  if (!request || typeof request !== "object" || Array.isArray(request)) return request
  const messages = Array.isArray(request.messages) ? request.messages : []
  return {
    model: request.model || null,
    stream: request.stream === true,
    messageCount: messages.length,
    messageRoles: messages.map((message) => message?.role || "unknown"),
    toolCount: Array.isArray(request.tools) ? request.tools.length : 0,
  }
}

function payloadSummary(payload) {
  if (typeof payload === "string") {
    if (payload.startsWith("[omitted by default:")) return payload
    return `[omitted by default: ${payload.length} chars; set O1_CODE_PROXY_LOG_PAYLOADS=1 to include]`
  }
  if (Array.isArray(payload)) return { omittedByDefault: true, count: payload.length }
  if (payload && typeof payload === "object") {
    return { omittedByDefault: true, keyCount: Object.keys(payload).length }
  }
  return payload
}

const PAYLOAD_FIELDS = new Set([
  "prompt",
  "finalText",
  "content",
  "arguments",
  "text",
  "rawText",
  "value",
  "thinkingText",
  "ignoredAssistantErrorText",
])
const PAYLOAD_COLLECTION_FIELDS = new Set(["chunks", "events", "unparsed", "toolCallParts"])

function omitNestedPayloads(value) {
  if (Array.isArray(value)) return value.map(omitNestedPayloads)
  if (!value || typeof value !== "object") return value
  return Object.fromEntries(
    Object.entries(value).map(([key, entry]) => [
      key,
      (PAYLOAD_FIELDS.has(key) || PAYLOAD_COLLECTION_FIELDS.has(key)) && !isTextMetrics(entry)
        ? payloadSummary(entry)
        : omitNestedPayloads(entry),
    ]),
  )
}

function isTextMetrics(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false
  const keys = Object.keys(value)
  return keys.length === 2 && keys.includes("chars") && keys.includes("estimatedTokens")
}

function logKeep() {
  const configured = Number(process.env.O1_CODE_PROXY_LOG_KEEP)
  return Number.isFinite(configured) && configured > 0 ? configured : DEFAULT_LOG_KEEP
}

// Best-effort retention: keep the most recent N generated run-JSON files, delete older ones.
// The ISO-timestamp filename prefix sorts chronologically, so a lexical sort is enough.
async function pruneRunLogs(logDir) {
  const keep = logKeep()
  const entries = (await readdir(logDir)).filter((name) => RUN_LOG_PATTERN.test(name))

  if (entries.length <= keep) {
    return
  }

  entries.sort()
  const stale = entries.slice(0, entries.length - keep)

  await Promise.all(stale.map((name) => unlink(join(logDir, name)).catch(() => {})))
}
