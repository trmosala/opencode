import { afterEach, describe, expect, test } from "bun:test"
import { acquireThreadTurn, decideThreadMode, commitThread, resetThread } from "./sessionThreads.mjs"

const KEY = "sess-A::CM_Opus 4.8 - Extra High"
const tool = (description = "run") => ({
  function: { name: "bash", description, parameters: { type: "object" } },
})
const body = (...messages) => ({ model: "CM_Opus 4.8 - Extra High", tools: [tool()], messages })
const sys = (text = "you are opencode") => ({ role: "system", content: text })
const user = (text) => ({ role: "user", content: text })
const assistant = (text) => ({ role: "assistant", content: text })
const assistantToolCall = (id, command = "pwd") => ({
  role: "assistant",
  content: "",
  tool_calls: [{ id, function: { name: "bash", arguments: JSON.stringify({ command }) } }],
})
const toolResult = (id, text) => ({ role: "tool", tool_call_id: id, content: text })

afterEach(() => resetThread(KEY))

describe("decideThreadMode", () => {
  test("first turn (no mirror) is fresh", () => {
    expect(decideThreadMode(KEY, body(sys(), user("hello")), true)).toEqual({ mode: "fresh", sinceIndex: 0 })
  })

  test("clean append consumes the expected assistant echo and continues with the true delta", () => {
    const first = body(sys(), user("hello"))
    commitThread(KEY, first, assistant("answer"))
    const next = body(sys(), user("hello"), assistant("answer"), user("more"))
    expect(decideThreadMode(KEY, next, true)).toEqual({ mode: "continue", sinceIndex: 2 })
  })

  test("tool result continues without replaying the assistant tool call already in WPP", () => {
    const first = body(sys(), user("inspect"))
    commitThread(KEY, first, assistantToolCall("t1"))
    const next = body(sys(), user("inspect"), assistantToolCall("t1"), toolResult("t1", "ok"))
    expect(decideThreadMode(KEY, next, true)).toEqual({ mode: "continue", sinceIndex: 2 })
  })

  test("an unexpected assistant echo resyncs fresh", () => {
    const first = body(sys(), user("hello"))
    commitThread(KEY, first, assistant("answer"))
    const next = body(sys(), user("hello"), assistant("different"), user("more"))
    expect(decideThreadMode(KEY, next, true)).toEqual({ mode: "fresh", sinceIndex: 0 })
  })

  test("changed instructions resync fresh", () => {
    const first = body(sys(), user("hello"))
    commitThread(KEY, first, assistant("answer"))
    const next = body(sys("new instruction"), user("hello"), assistant("answer"), user("more"))
    expect(decideThreadMode(KEY, next, true)).toEqual({ mode: "fresh", sinceIndex: 0 })
  })

  test("changed tool schema resyncs fresh", () => {
    const first = body(sys(), user("hello"))
    commitThread(KEY, first, assistant("answer"))
    const next = body(sys(), user("hello"), assistant("answer"), user("more"))
    next.tools = [tool("changed")]
    expect(decideThreadMode(KEY, next, true)).toEqual({ mode: "fresh", sinceIndex: 0 })
  })

  test("edited history resyncs fresh", () => {
    const first = body(sys(), user("hello"))
    commitThread(KEY, first, assistant("answer"))
    const next = body(sys(), user("HELLO EDITED"), assistant("answer"), user("more"))
    expect(decideThreadMode(KEY, next, true)).toEqual({ mode: "fresh", sinceIndex: 0 })
  })

  test("changed tool-call arguments in the assistant echo resync fresh", () => {
    const first = body(sys(), user("inspect"))
    commitThread(KEY, first, assistantToolCall("t1", "pwd"))
    const next = body(sys(), user("inspect"), assistantToolCall("t1", "whoami"), toolResult("t1", "ok"))
    expect(decideThreadMode(KEY, next, true)).toEqual({ mode: "fresh", sinceIndex: 0 })
  })

  test("dead tab resyncs fresh", () => {
    const first = body(sys(), user("hello"))
    commitThread(KEY, first, assistant("answer"))
    const next = body(sys(), user("hello"), assistant("answer"), user("more"))
    expect(decideThreadMode(KEY, next, false)).toEqual({ mode: "fresh", sinceIndex: 0 })
  })

  test("no message after the expected assistant echo does not produce an empty delta", () => {
    const first = body(sys(), user("hello"))
    commitThread(KEY, first, assistant("answer"))
    expect(decideThreadMode(KEY, body(sys(), user("hello"), assistant("answer")), true)).toEqual({
      mode: "fresh",
      sinceIndex: 0,
    })
  })

  test("resetThread drops the mirror", () => {
    const first = body(sys(), user("hello"))
    commitThread(KEY, first, assistant("answer"))
    resetThread(KEY)
    const next = body(sys(), user("hello"), assistant("answer"), user("more"))
    expect(decideThreadMode(KEY, next, true)).toEqual({ mode: "fresh", sinceIndex: 0 })
  })
})

describe("acquireThreadTurn", () => {
  test("serializes the full lifecycle of turns for one session", async () => {
    const releaseFirst = await acquireThreadTurn(KEY)
    let secondAcquired = false
    const second = acquireThreadTurn(KEY).then((release) => {
      secondAcquired = true
      return release
    })

    await Promise.resolve()
    expect(secondAcquired).toBe(false)

    releaseFirst()
    const releaseSecond = await second
    expect(secondAcquired).toBe(true)
    releaseSecond()
  })

  test("does not serialize different sessions", async () => {
    const releaseFirst = await acquireThreadTurn(`${KEY}-one`)
    const releaseSecond = await acquireThreadTurn(`${KEY}-two`)
    releaseFirst()
    releaseSecond()
  })
})
