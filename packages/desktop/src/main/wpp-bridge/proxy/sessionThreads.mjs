import { createHash } from "node:crypto"
import { resolveModelProfile } from "./modelProfiles.mjs"
import { CM_REQUEST_TYPE, CM_REQUEST_VERSION, toolCallProtocol } from "./protocol.mjs"

// In-memory session -> WPP-thread mirror. OpenCode resends the full logical transcript on every
// call, while the pinned WPP tab also retains the assistant response it produced. Track those two
// facts separately so the next delta consumes the expected assistant echo instead of typing it back
// into the WPP thread as a second assistant message.
//
// "continue" requires a live pinned tab, unchanged instructions/tools/protocol, the prior request
// as an exact prefix, and the WPP response echoed at the expected boundary. Any mismatch falls back
// to a fresh replay because body.messages still holds the full logical conversation.

const threads = new Map() // sessionKey -> { requestHashes, assistantHash, contextHash }
const turnTails = new Map() // sessionKey -> Promise released after the active turn commits/resets

export function threadContinuityEnabled() {
  return process.env.O1_CODE_THREAD_CONTINUITY !== "0"
}

// Serialize the complete decide -> submit -> commit lifecycle for one OpenCode session. The worker
// pool also serializes access to the pinned browser tab, but prompt deltas are calculated before a
// worker is acquired; without this lock two concurrent requests can both serialize against the
// same stale mirror and then submit sequentially to one WPP thread.
export async function acquireThreadTurn(sessionKey) {
  if (!sessionKey) return () => {}

  const previous = turnTails.get(sessionKey) || Promise.resolve()
  let releaseGate
  const gate = new Promise((resolve) => {
    releaseGate = resolve
  })
  const tail = previous.then(() => gate)
  turnTails.set(sessionKey, tail)
  await previous

  let released = false
  return () => {
    if (released) return
    released = true
    releaseGate()
    if (turnTails.get(sessionKey) === tail) turnTails.delete(sessionKey)
  }
}

function nonSystemMessages(body) {
  const all = Array.isArray(body?.messages) ? body.messages : []
  return all.filter((message) => message.role !== "system")
}

function hashMessage(message) {
  return hashValue({
    role: message?.role || "user",
    content: message?.content ?? null,
    toolCallId: message?.tool_call_id || message?.toolCallId || "",
    toolCalls: Array.isArray(message?.tool_calls)
      ? message.tool_calls.map((call) => ({
          id: call.id || "",
          type: call.type || "function",
          name: call.function?.name || call.name || "",
          arguments: call.function?.arguments ?? call.arguments ?? "{}",
        }))
      : Array.isArray(message?.toolCalls)
        ? message.toolCalls
        : null,
  })
}

function hashesFor(body) {
  return nonSystemMessages(body).map(hashMessage)
}

function isPrefix(prev, next) {
  if (prev.length > next.length) return false
  return prev.every((hash, index) => hash === next[index])
}

function contextHash(body) {
  const messages = Array.isArray(body?.messages) ? body.messages : []
  const profile = resolveModelProfile(body?.model)
  return hashValue({
    protocol: { type: CM_REQUEST_TYPE, version: CM_REQUEST_VERSION },
    model: body?.model || "",
    agent: profile.agentName,
    toolCallProtocol: toolCallProtocol(profile.toolFormat),
    instructions: messages.filter((message) => message.role === "system").map((message) => message.content ?? null),
    tools: Array.isArray(body?.tools) ? body.tools : [],
  })
}

function hashValue(value) {
  return createHash("sha256")
    .update(JSON.stringify(canonicalize(value)))
    .digest("hex")
}

function canonicalize(value) {
  if (Array.isArray(value)) return value.map(canonicalize)
  if (!value || typeof value !== "object") return value
  return Object.fromEntries(
    Object.keys(value)
      .sort()
      .map((key) => [key, canonicalize(value[key])]),
  )
}

// Decide how to serialize this turn. `sinceIndex` indexes into the non-system messages (the same
// order messageSerializer iterates), so "continue" forwards only messages after the watermark.
export function decideThreadMode(sessionKey, body, tabAlive) {
  if (!sessionKey || !tabAlive) return { mode: "fresh", sinceIndex: 0 }

  const entry = threads.get(sessionKey)
  if (!entry) return { mode: "fresh", sinceIndex: 0 }
  if (entry.contextHash !== contextHash(body)) return { mode: "fresh", sinceIndex: 0 }

  const current = hashesFor(body)
  if (!isPrefix(entry.requestHashes, current)) {
    return { mode: "fresh", sinceIndex: 0 }
  }

  const assistantIndex = entry.requestHashes.length
  if (current[assistantIndex] !== entry.assistantHash) return { mode: "fresh", sinceIndex: 0 }

  const sinceIndex = assistantIndex + 1
  if (current.length <= sinceIndex) return { mode: "fresh", sinceIndex: 0 }
  return { mode: "continue", sinceIndex }
}

// Record both sides of the mirror after a successful turn: the OpenCode messages submitted to the
// model and the assistant message now present in the WPP tab but not yet in that request body.
export function commitThread(sessionKey, body, assistant) {
  if (!sessionKey) return
  threads.set(sessionKey, {
    requestHashes: hashesFor(body),
    assistantHash: hashMessage({ role: "assistant", ...assistant }),
    contextHash: contextHash(body),
  })
}

// Drop the watermark so the next turn replays fresh — used when a turn fails (the tab may be in an
// unknown state) so we never extend a delta onto a thread we can't trust.
export function resetThread(sessionKey) {
  if (sessionKey) threads.delete(sessionKey)
}
