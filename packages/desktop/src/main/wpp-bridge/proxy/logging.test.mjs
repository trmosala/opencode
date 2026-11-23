import { describe, expect, test } from "bun:test"
import { mkdtemp, readdir, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { runLogRecord, setRunLogDir, writeRunLog } from "./logging.mjs"

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
      chatContext: { textareas: [{ value: "private composer value", valuePreview: "private composer preview" }] },
      diagnostics: { domMessage: { text: "private DOM response" } },
      response: {
        finalText: "private assistant text",
        toolCallParts: { call1: { name: "read", arguments: "private tool arguments" } },
        chunks: [{ text: "private streamed chunk" }],
        events: [{ text: "private event text" }],
        unparsed: ["private unparsed payload"],
        alternateAssistantTexts: ["private alternate assistant text"],
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
    expect(JSON.stringify(out)).not.toContain("private composer preview")
    expect(JSON.stringify(out)).not.toContain("private DOM response")
    expect(out.o1Code.response.alternateAssistantTexts).toEqual({ omittedByDefault: true, count: 1 })
    expect(JSON.stringify(out)).not.toContain("private alternate assistant text")
  })

  test("retains payloads only when explicitly enabled", () => {
    expect(runLogRecord(record, true)).toBe(record)
  })
})

describe("writeRunLog", () => {
  const withEnv = async (values, fn) => {
    const previous = Object.fromEntries(Object.keys(values).map((key) => [key, process.env[key]]))
    for (const [key, value] of Object.entries(values)) {
      if (value === undefined) delete process.env[key]
      else process.env[key] = value
    }
    try {
      return await fn()
    } finally {
      for (const [key, value] of Object.entries(previous)) {
        if (value === undefined) delete process.env[key]
        else process.env[key] = value
      }
    }
  }

  test("has no cwd-relative default directory", async () => {
    setRunLogDir(null)
    const result = await withEnv({ O1_CODE_PROXY_LOGS: undefined, O1_CODE_PROXY_LOG_DIR: undefined }, () =>
      writeRunLog({ id: "run-default" }),
    )
    expect(result).toBe(null)
  })

  test("writes into the directory configured by the main process", async () => {
    const directory = await mkdtemp(join(tmpdir(), "wpp-run-log-"))
    setRunLogDir(directory)
    try {
      const result = await withEnv({ O1_CODE_PROXY_LOGS: undefined, O1_CODE_PROXY_LOG_DIR: undefined }, () =>
        writeRunLog({ id: "run-configured" }),
      )
      expect(result?.startsWith(directory)).toBe(true)
      expect(await readdir(directory)).toHaveLength(1)
    } finally {
      setRunLogDir(null)
      await rm(directory, { recursive: true, force: true })
    }
  })

  test("resolves null instead of rejecting when the directory is unwritable", async () => {
    const directory = await mkdtemp(join(tmpdir(), "wpp-run-log-"))
    const blocker = join(directory, "file")
    await Bun.write(blocker, "")
    try {
      const result = await withEnv({ O1_CODE_PROXY_LOGS: "1", O1_CODE_PROXY_LOG_DIR: join(blocker, "logs") }, () =>
        writeRunLog({ id: "run-unwritable" }),
      )
      expect(result).toBe(null)
    } finally {
      await rm(directory, { recursive: true, force: true })
    }
  })
})
