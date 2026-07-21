import { describe, expect, test } from "bun:test"
import { readFile } from "node:fs/promises"
import { join } from "node:path"
import vm from "node:vm"

type Recorder = {
  finalText: string
  primaryMessageId: string | null
}

type RecorderHarness = {
  createRecord: (request: Record<string, unknown>) => Recorder
  parseDataLine: (record: Recorder, data: string) => void
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
})

function parse(record: Recorder, payload: unknown) {
  harness.parseDataLine(record, JSON.stringify(payload))
}

async function loadRecorderHarness(): Promise<RecorderHarness> {
  const path = join(import.meta.dir, "injected", "pageRecorder.js")
  const source = await readFile(path, "utf8")
  const instrumented = source.replace(
    /\}\)\(\);\s*$/u,
    "globalThis.__recorderHarness = { createRecord, parseDataLine };\n})();",
  )
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
  return typeof Reflect.get(value, "createRecord") === "function" && typeof Reflect.get(value, "parseDataLine") === "function"
}
