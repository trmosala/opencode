import { describe, expect, test } from "bun:test";
import { serializeChatCompletionRequest } from "./messageSerializer.mjs";

// The disclosure preamble must reach every WPP-backed profile. See messageSerializer.mjs.
const PREAMBLE_MARK = "relayed by a local proxy";

const framed = (model) => ({
  model,
  tools: [{ function: { name: "bash", description: "run", parameters: {} } }],
  messages: [
    { role: "system", content: "you are opencode" },
    { role: "user", content: "do the thing" },
  ],
});

describe("serialized session preamble", () => {
  test("present for xml profile (o1-code) and names the OgilvyOneCoder agent", () => {
    const out = serializeChatCompletionRequest(framed("o1-code"));
    expect(out).toContain(PREAMBLE_MARK);
    expect(out).toContain("(the OgilvyOneCoder agent)");
  });

  test("present for builder profile, names the OgilvyOneCoder_Builder agent, and uses XML tools", () => {
    const out = serializeChatCompletionRequest(framed("o1-code-builder"));
    expect(out).toContain(PREAMBLE_MARK);
    expect(out).toContain("(the OgilvyOneCoder_Builder agent)");
    expect(out).toContain("<function_calls>");
    expect(out).not.toContain('"type":"tool_call"');
  });

  test("absent for a bare follow-up (no system / tools / tool calls)", () => {
    const out = serializeChatCompletionRequest({ model: "o1-code", messages: [{ role: "user", content: "hi" }] });
    expect(out).not.toContain(PREAMBLE_MARK);
    expect(out).toBe("hi");
  });
});
