import { afterEach, describe, expect, test } from "bun:test";
import { decideThreadMode, commitThread, resetThread } from "./sessionThreads.mjs";

const KEY = "sess-A::OgilvyOneCoder";

const body = (...messages) => ({ messages });
const sys = { role: "system", content: "you are opencode" };
const user = (text) => ({ role: "user", content: text });
const assistantToolCall = (id) => ({ role: "assistant", content: "", tool_calls: [{ id, function: { name: "bash" } }] });
const toolResult = (id, text) => ({ role: "tool", tool_call_id: id, content: text });

afterEach(() => resetThread(KEY));

describe("decideThreadMode", () => {
  test("first turn (no watermark) is fresh", () => {
    expect(decideThreadMode(KEY, body(sys, user("hello")), true)).toEqual({ mode: "fresh", sinceIndex: 0 });
  });

  test("clean append continues with delta after the committed non-system count", () => {
    commitThread(KEY, body(sys, user("hello")));
    const next = body(sys, user("hello"), assistantToolCall("t1"), toolResult("t1", "ok"), user("more"));
    expect(decideThreadMode(KEY, next, true)).toEqual({ mode: "continue", sinceIndex: 1 });
  });

  test("system messages are ignored — only non-system messages count toward the watermark", () => {
    commitThread(KEY, body(sys, user("hello")));
    // Inserting another system message must not shift the delta boundary.
    const next = body(sys, { role: "system", content: "reminder" }, user("hello"), user("more"));
    expect(decideThreadMode(KEY, next, true)).toEqual({ mode: "continue", sinceIndex: 1 });
  });

  test("prefix mismatch (edited/compacted history) resyncs fresh", () => {
    commitThread(KEY, body(sys, user("hello")));
    const rewritten = body(sys, user("HELLO EDITED"), user("more"));
    expect(decideThreadMode(KEY, rewritten, true)).toEqual({ mode: "fresh", sinceIndex: 0 });
  });

  test("dead tab (not alive) resyncs fresh even on a clean prefix", () => {
    commitThread(KEY, body(sys, user("hello")));
    const next = body(sys, user("hello"), user("more"));
    expect(decideThreadMode(KEY, next, false)).toEqual({ mode: "fresh", sinceIndex: 0 });
  });

  test("no new messages since the watermark is fresh (nothing to continue)", () => {
    commitThread(KEY, body(sys, user("hello")));
    expect(decideThreadMode(KEY, body(sys, user("hello")), true)).toEqual({ mode: "fresh", sinceIndex: 0 });
  });

  test("a blank session key never continues", () => {
    expect(decideThreadMode("", body(sys, user("hello")), true)).toEqual({ mode: "fresh", sinceIndex: 0 });
  });

  test("resetThread drops the watermark so the next turn is fresh", () => {
    commitThread(KEY, body(sys, user("hello")));
    resetThread(KEY);
    expect(decideThreadMode(KEY, body(sys, user("hello"), user("more")), true)).toEqual({ mode: "fresh", sinceIndex: 0 });
  });
});
