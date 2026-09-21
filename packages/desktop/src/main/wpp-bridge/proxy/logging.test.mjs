import { describe, expect, test } from "bun:test"
import { runLogRecord } from "./logging.mjs"

describe("runLogRecord", () => {
  const record = {
    id: "run-1",
    request: {
      model: "CM_Opus 5 - Extra High",
      stream: true,
      messages: [
        { role: "system", content: "private runtime instruction" },
        { role: "user", content: "private user text" },
      ],
      tools: [{ function: { name: "read" } }],
    },
    prompt: "serialized private prompt",
    o1Code: {
      prompt: "nested private prompt",
      chatContext: { textareas: [{ value: "private composer value" }] },
      diagnostics: { domMessage: { text: "private DOM response" } },
      response: {
        finalText: "private assistant text",
        toolCallParts: { call1: { name: "read", arguments: "private tool arguments" } },
        chunks: [{ text: "private streamed chunk" }],
        events: [{ text: "private event text" }],
        unparsed: ["private unparsed payload"],
      },
    },
    response: {
      content: "private normalized response",
      tool_calls: [{ function: { name: "read", arguments: "private normalized arguments" } }],
    },
  }

  test("omits transcript payloads by default", () => {
    const out = runLogRecord(record, false)
    expect(out.request).toEqual({
      model: "CM_Opus 5 - Extra High",
      stream: true,
      messageCount: 2,
      messageRoles: ["system", "user"],
      toolCount: 1,
    })
    expect(out.prompt).toContain("omitted by default")
    expect(out.o1Code.prompt).toContain("omitted by default")
    expect(out.o1Code.response.finalText).toContain("omitted by default")
    expect(out.o1Code.response.chunks).toEqual({ omittedByDefault: true, count: 1 })
    expect(out.o1Code.response.events).toEqual({ omittedByDefault: true, count: 1 })
    expect(out.o1Code.response.unparsed).toEqual({ omittedByDefault: true, count: 1 })
    expect(out.response.content).toContain("omitted by default")
    expect(out.response.tool_calls[0].function.arguments).toContain("omitted by default")
    expect(JSON.stringify(out)).not.toContain("private runtime instruction")
    expect(JSON.stringify(out)).not.toContain("private user text")
    expect(JSON.stringify(out)).not.toContain("private assistant text")
    expect(JSON.stringify(out)).not.toContain("private tool arguments")
    expect(JSON.stringify(out)).not.toContain("private streamed chunk")
    expect(JSON.stringify(out)).not.toContain("private event text")
    expect(JSON.stringify(out)).not.toContain("private unparsed payload")
    expect(JSON.stringify(out)).not.toContain("private normalized response")
    expect(JSON.stringify(out)).not.toContain("private composer value")
    expect(JSON.stringify(out)).not.toContain("private DOM response")
  })

  test("retains payloads only when explicitly enabled", () => {
    expect(runLogRecord(record, true)).toBe(record)
  })
})
