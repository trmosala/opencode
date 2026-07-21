import { resolveModelProfile } from "./modelProfiles.mjs"
import { imagePlaceholderText } from "./imageInputs.mjs"
import { CM_REQUEST_TYPE, CM_REQUEST_VERSION, CM_TASK_COMPLETE_PROTOCOL, toolCallProtocol } from "./protocol.mjs"
import { toolCallInstructions, toolCallRecoveryInstructions } from "./toolCallReminder.mjs"

// WPP only exposes a chat composer, so the bridge cannot send true system/tool-role messages.
// Preserve the hierarchy as data in one versioned envelope instead of imitating privileged
// messages with free-form [system]/[harness] text. The WPP-side agent system instruction owns the
// meaning of this protocol; see ../WPP_AGENT_SYSTEM_PROMPT.md.

function stringifyContent(content, state = { imageIndex: 0 }) {
  if (typeof content === "string") {
    return content
  }

  if (Array.isArray(content)) {
    return content
      .map((part) => {
        if (typeof part === "string") {
          return part
        }

        if (part?.type === "text") {
          return part.text || ""
        }

        if (part?.type === "image_url") {
          state.imageIndex += 1
          return imagePlaceholderText(part, state.imageIndex)
        }

        return JSON.stringify(part)
      })
      .join("\n")
  }

  if (content == null) {
    return ""
  }

  return JSON.stringify(content)
}

// `sinceIndex` > 0 selects delta mode: continue an existing WPP thread by forwarding only messages
// the tab has not already seen. The fresh envelope carries instructions and tool definitions; a
// continuation relies on the live WPP thread and sends only the logical delta.
export function serializeChatCompletionRequest(body, { sinceIndex = 0, purpose = "chat" } = {}) {
  const allMessages = Array.isArray(body.messages) ? body.messages : []
  const systemMessages = allMessages.filter((m) => m.role === "system")
  const nonSystemMessages = allMessages.filter((m) => m.role !== "system")
  const { toolFormat } = resolveModelProfile(body.model)
  const state = { imageIndex: 0 }
  const delta = sinceIndex > 0
  const turnMessages = delta ? nonSystemMessages.slice(sinceIndex) : nonSystemMessages
  const tools = serializeTools(body.tools)
  const toolInstructions = purpose === "chat" && tools.length > 0
    ? toolCallInstructions(toolFormat)
    : undefined
  const delegatedInstructions = systemMessages
    .map((message) => stringifyContent(message.content, state))
    .filter((content) => content.trim())
  const freshInstructions = toolInstructions
    ? delegatedInstructions.length > 0
      ? [
          ...delegatedInstructions.slice(0, -1),
          `${delegatedInstructions.at(-1)}\n\n${toolInstructions}`,
        ]
      : [toolInstructions]
    : delegatedInstructions
  const envelope = {
    type: CM_REQUEST_TYPE,
    version: CM_REQUEST_VERSION,
    mode: delta ? "continue" : "fresh",
    purpose,
    toolCallProtocol: toolCallProtocol(toolFormat),
    ...(toolInstructions && toolFormat === "json" ? { completionProtocol: CM_TASK_COMPLETE_PROTOCOL } : {}),
    ...(delta
      ? {
          ...(toolInstructions ? { instructions: [toolInstructions] } : {}),
          toolsAvailable: true,
        }
      : {
          instructions: freshInstructions,
          tools,
        }),
    messages: turnMessages.map((message) => serializeMessage(message, state)),
  }

  return JSON.stringify(envelope, null, 2)
}

export function serializeIncompleteTaskContinuationRequest(body, { purpose = "chat" } = {}) {
  const tools = serializeTools(body.tools)
  const { toolFormat } = resolveModelProfile(body.model)
  return JSON.stringify({
    type: CM_REQUEST_TYPE,
    version: CM_REQUEST_VERSION,
    mode: "continue",
    purpose,
    toolCallProtocol: toolCallProtocol(toolFormat),
    completionProtocol: CM_TASK_COMPLETE_PROTOCOL,
    toolsAvailable: tools.length > 0,
    instructions: [toolCallInstructions(toolFormat)],
    resumeIncomplete: true,
    messages: [],
  }, null, 2)
}

// A terminal answer that violates an explicit first-tool requirement is recovered through a
// deliberately compact routing turn. Replaying the full coding prompt can reproduce the same WPP
// miss, but replaying only the latest user request loses completed tool progress and can make the
// router repeat its first call.
// Keep the latest user request plus a bounded suffix of coherent tool-call/result groups from that
// active turn. Older turns and prose-only assistant answers stay out of the recovery prompt.
export function serializeToolRecoveryRequest(body, { purpose = "chat" } = {}) {
  const messages = Array.isArray(body.messages) ? body.messages : []
  const tools = serializeTools(body.tools)
  const router = toolCallRecoveryInstructions(tools.map((tool) => tool.name))
  return serializeChatCompletionRequest(
    {
      ...body,
      messages: [
        { role: "system", content: router },
        ...toolRecoveryMessages(messages),
      ],
    },
    { purpose },
  )
}

const MAX_TOOL_RECOVERY_GROUPS = 6

function toolRecoveryMessages(messages) {
  const latestUserIndex = messages.findLastIndex((message) => message?.role === "user")
  if (latestUserIndex < 0) return []

  const groups = []
  for (const message of messages.slice(latestUserIndex + 1)) {
    if (message?.role === "assistant" && Array.isArray(message.tool_calls) && message.tool_calls.length > 0) {
      groups.push([message])
      continue
    }

    if (message?.role === "tool" && groups.length > 0) {
      groups.at(-1).push(message)
    }
  }

  return [messages[latestUserIndex], ...groups.slice(-MAX_TOOL_RECOVERY_GROUPS).flat()]
}

export function serializableMessagesForRequest(body) {
  const allMessages = Array.isArray(body.messages) ? body.messages : []
  const systemMessages = allMessages.filter((m) => m.role === "system")
  const nonSystemMessages = allMessages.filter((m) => m.role !== "system")

  return [...systemMessages, ...nonSystemMessages]
}

function serializeTools(tools) {
  if (!Array.isArray(tools)) return []
  return tools.map((tool) => {
    const fn = tool.function || tool
    return {
      name: fn.name || "",
      description: fn.description || "",
      parameters: fn.parameters || {},
    }
  })
}

function serializeMessage(message, state) {
  const serialized = {
    role: message.role || "user",
    content: stringifyContent(message.content, state),
  }

  if (message.tool_call_id) serialized.toolCallId = message.tool_call_id
  if (Array.isArray(message.tool_calls) && message.tool_calls.length > 0) {
    serialized.toolCalls = message.tool_calls.map((call) => ({
      id: call.id || "",
      name: call.function?.name || call.name || "",
      arguments: call.function?.arguments ?? call.arguments ?? "{}",
    }))
  }

  return serialized
}
