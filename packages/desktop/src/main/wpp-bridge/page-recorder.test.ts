import { describe, expect, test } from "bun:test"
import { join } from "node:path"
import vm from "node:vm"

type Recorder = {
  finalText: string
  primaryMessageId: string | null
  alternateAssistantTexts: Record<string, string>
  toolCallParts: Record<string, { name?: string; arguments?: string }>
  usage?: Record<string, unknown> | null
}

type RecorderHarness = {
  createRecord: (request: Record<string, unknown>) => Recorder
  parseDataLine: (record: Recorder, data: string) => void
  serializeRecord: (record: Recorder) => Record<string, unknown>
  networkUsage: (value: unknown) => Record<string, unknown> | null
}

const harness = await loadRecorderHarness()

describe("WPP page recorder", () => {
  test("does not append a terminal full-message snapshot after streamed deltas", () => {
    const record = harness.createRecord({})

    parse(record, {
      message_id: "assistant-1",
      choices: [{ index: 0, delta: { content: "I'll inspect the worktree." } }],
    })
    parse(record, {
      message_id: "assistant-1",
      choices: [{ index: 0, message: { content: "I'll inspect the worktree." }, finish_reason: "stop" }],
    })

    expect(record.finalText).toBe("I'll inspect the worktree.")
  })

  test("uses a longer terminal snapshot to complete a partial stream", () => {
    const record = harness.createRecord({})

    parse(record, {
      message_id: "assistant-1",
      choices: [{ index: 0, delta: { content: "I'll inspect" } }],
    })
    parse(record, {
      message_id: "assistant-1",
      choices: [{ index: 0, message: { content: "I'll inspect the worktree." } }],
    })

    expect(record.finalText).toBe("I'll inspect the worktree.")
  })

  test("keeps choice zero and ignores unrelated choices", () => {
    const record = harness.createRecord({})

    parse(record, {
      message_id: "assistant-1",
      choices: [
        { index: 0, delta: { content: "I'll inspect the worktree." } },
        { index: 1, delta: { content: "I'm not able to share internal system information." } },
      ],
    })

    expect(record.finalText).toBe("I'll inspect the worktree.")
  })

  test("ignores a second assistant message multiplexed into the same response", () => {
    const record = harness.createRecord({})

    parse(record, {
      message_id: "assistant-1",
      choices: [{ index: 0, delta: { content: "I'll inspect the worktree." } }],
    })
    parse(record, {
      message_id: "policy-fallback",
      choices: [{ index: 0, delta: { content: "I'm not able to share internal system information." } }],
    })

    expect(record.finalText).toBe("I'll inspect the worktree.")
    expect(record.primaryMessageId).toBe("assistant-1")
  })

  test("uses the WPP delta message id when filtering multiplexed assistant output", () => {
    const record = harness.createRecord({})

    parse(record, {
      choices: [{ index: 0, delta: { messageId: "assistant-1", content: "I'll inspect the worktree." } }],
    })
    parse(record, {
      choices: [{ index: 0, delta: { messageId: "policy-fallback", content: "Local tools are unavailable." } }],
    })

    expect(record.finalText).toBe("I'll inspect the worktree.")
    expect(record.primaryMessageId).toBe("assistant-1")
  })

  test("retains fragmented tool output from a later assistant message without mixing it into prose", () => {
    const record = harness.createRecord({})

    parse(record, {
      message_id: "assistant-1",
      choices: [{ index: 0, delta: { content: "I'll inspect the worktree." } }],
    })
    parse(record, {
      message_id: "assistant-tool",
      choices: [{ index: 0, delta: { content: '<function_calls><invoke id="call-1" name="bash">' } }],
    })
    parse(record, {
      message_id: "assistant-tool",
      choices: [{ index: 0, delta: { content: '<parameter name="command">git status</parameter></invoke></function_calls>' } }],
    })

    expect(record.finalText).toBe("I'll inspect the worktree.")
    expect(record.alternateAssistantTexts).toEqual({
      "assistant-tool":
        '<function_calls><invoke id="call-1" name="bash"><parameter name="command">git status</parameter></invoke></function_calls>',
    })
    expect(harness.serializeRecord(record).alternateAssistantTexts).toEqual(record.alternateAssistantTexts)
  })

  test("retains structured tool calls from a later assistant message", () => {
    const record = harness.createRecord({})

    parse(record, {
      message_id: "assistant-1",
      choices: [{ index: 0, delta: { content: "I'll inspect the worktree." } }],
    })
    parse(record, {
      message_id: "assistant-tool",
      choices: [
        {
          index: 0,
          delta: {
            tool_calls: [
              { index: 0, id: "call-1", function: { name: "bash", arguments: '{"command":"git status"}' } },
            ],
          },
          finish_reason: "tool_calls",
        },
      ],
    })

    expect(record.finalText).toBe("I'll inspect the worktree.")
    expect(record.toolCallParts["0"]).toEqual({
      id: "call-1",
      type: "function",
      name: "bash",
      arguments: '{"command":"git status"}',
    })
  })

  test("preserves exact OpenAI usage and clamps optional details", () => {
    const record = harness.createRecord({})

    parse(record, {
      usage: {
        prompt_tokens: 120,
        completion_tokens: 30,
        total_tokens: 999,
        prompt_tokens_details: { cached_tokens: 140 },
        completion_tokens_details: { reasoning_tokens: 12 },
      },
    })

    expect(record.usage).toEqual({
      scope: "request",
      source: "network",
      fidelity: "exact",
      promptTokens: 120,
      completionTokens: 30,
      totalTokens: 150,
      cachedTokens: 120,
      reasoningTokens: 12,
    })
    expect(harness.serializeRecord(record).usage).toEqual(record.usage)
    expect(harness.networkUsage({ prompt_tokens: -1, completion_tokens: 2 })).toBeNull()
  })
})

function parse(record: Recorder, payload: unknown) {
  harness.parseDataLine(record, JSON.stringify(payload))
}

async function loadRecorderHarness(): Promise<RecorderHarness> {
  const path = join(import.meta.dir, "injected", "pageRecorder.js")
  const source = await Bun.file(path).text()
  const instrumented = source.replace(
    /\}\)\(\);?\s*$/u,
    "globalThis.__recorderHarness = { createRecord, parseDataLine, serializeRecord, networkUsage };\n})()",
  )
  if (instrumented === source) throw new Error("Page recorder test instrumentation did not match the source")
  const window = {
    addEventListener() {},
    postMessage() {},
  }
  const context = vm.createContext({
    window,
    location: { href: "https://open-web-assistant-cs.wpp.ai/" },
    URL,
    Date,
    setTimeout,
    clearTimeout,
  })

  vm.runInContext(instrumented, context)
  const value: unknown = vm.runInContext("__recorderHarness", context)
  if (!isRecorderHarness(value)) throw new Error("Page recorder test harness was not installed")
  return value
}

function isRecorderHarness(value: unknown): value is RecorderHarness {
  if (!value || typeof value !== "object") return false
  return (
    typeof Reflect.get(value, "createRecord") === "function" &&
    typeof Reflect.get(value, "parseDataLine") === "function" &&
    typeof Reflect.get(value, "serializeRecord") === "function" &&
    typeof Reflect.get(value, "networkUsage") === "function"
  )
}
