import { afterEach, describe, expect, mock, test } from "bun:test";

mock.module("electron", () => ({ BrowserWindow: function BrowserWindow() {}, session: { fromPartition: () => ({}) } }));

const { handleChatCompletions } = await import("./openaiCompat.mjs");
const { commitThread, resetThread } = await import("./sessionThreads.mjs");

const KEY = "sess-A::OgilvyOneCoder";

afterEach(() => {
  resetThread(KEY);
});

describe("handleChatCompletions capture retry", () => {
  test("retries a capture failure once as a fresh replay", async () => {
    commitThread(KEY, body(user("hello")));
    const calls = [];
    const response = fakeResponse();
    const bridge = {
      hasSession: () => true,
      run: async (_prompt, options) => {
        calls.push(options);
        if (calls.length === 1) throw captureError("recorder_parser_miss");
        return bridgeRun("done");
      },
    };

    await withNoRunLogs(() => handleChatCompletions(
      { headers: { "x-session-affinity": "sess-A" } },
      response,
      body(user("hello"), user("more")),
      { bridge },
    ));

    expect(calls).toHaveLength(2);
    expect(calls[0].continueThread).toBe(true);
    expect(calls[1].continueThread).toBe(false);
    expect(response.statusCode).toBe(200);
    expect(response.headers["x-o1-code-response-source"]).toBe("network");
    expect(JSON.parse(response.body).choices[0].message.content).toBe("done");
  });

  test("surfaces a typed capture failure after one failed retry", async () => {
    commitThread(KEY, body(user("hello")));
    const response = fakeResponse();
    const bridge = {
      hasSession: () => true,
      run: async () => {
        throw captureError("submit_or_ui_failure");
      },
    };

    await withNoRunLogs(() => handleChatCompletions(
      { headers: { "x-session-affinity": "sess-A" } },
      response,
      body(user("hello"), user("more")),
      { bridge },
    ));

    expect(response.statusCode).toBe(502);
    expect(JSON.parse(response.body).error).toMatchObject({
      type: "o1_code_capture_failure",
      kind: "submit_or_ui_failure",
      retryCount: 1,
    });
  });
});

describe("handleChatCompletions token usage", () => {
  test("maps WPP's cumulative token pill onto prompt_tokens", async () => {
    commitThread(KEY, body(user("hello")));
    const response = fakeResponse();
    const bridge = {
      hasSession: () => true,
      run: async () => bridgeRun("done", { usage: { cumulativeTokens: 117219, source: "dom-pill", lowFidelity: true } }),
    };

    await withNoRunLogs(() => handleChatCompletions(
      { headers: { "x-session-affinity": "sess-A" } },
      response,
      body(user("hello"), user("more")),
      { bridge },
    ));

    expect(response.statusCode).toBe(200);
    expect(JSON.parse(response.body).usage.prompt_tokens).toBe(117219);
  });

  test("falls back to the heuristic prompt tokens when no pill is present", async () => {
    commitThread(KEY, body(user("hello")));
    const response = fakeResponse();
    const bridge = {
      hasSession: () => true,
      run: async () => bridgeRun("done"),
    };

    await withNoRunLogs(() => handleChatCompletions(
      { headers: { "x-session-affinity": "sess-A" } },
      response,
      body(user("hello"), user("more")),
      { bridge },
    ));

    const promptTokens = JSON.parse(response.body).usage.prompt_tokens;
    expect(Number.isFinite(promptTokens)).toBe(true);
    expect(promptTokens).toBeGreaterThan(0);
    expect(promptTokens).not.toBe(117219);
  });
});

function body(...messages) {
  return { model: "o1-code", stream: false, messages };
}

function user(content) {
  return { role: "user", content };
}

function bridgeRun(content, extraResponse = {}) {
  return {
    response: {
      finalText: content,
      toolCallParts: {},
      source: "network",
      capture: {
        responseSourceAccepted: "network",
        lowFidelity: false,
        verdict: "network",
      },
      ...extraResponse,
    },
  };
}

function captureError(kind) {
  const error = new Error(kind);
  error.statusCode = 502;
  error.type = "o1_code_capture_failure";
  error.kind = kind;
  error.capture = { verdict: kind };
  error.diagnostics = { capture: error.capture };
  return error;
}

function fakeResponse() {
  return {
    headers: {},
    statusCode: null,
    body: "",
    setHeader(name, value) {
      this.headers[name.toLowerCase()] = value;
    },
    writeHead(statusCode, headers = {}) {
      this.statusCode = statusCode;
      for (const [key, value] of Object.entries(headers)) this.setHeader(key, value);
    },
    write(chunk) {
      this.body += chunk;
    },
    end(chunk = "") {
      this.body += chunk;
    },
  };
}

async function withNoRunLogs(fn) {
  const previous = process.env.O1_CODE_PROXY_LOGS;
  process.env.O1_CODE_PROXY_LOGS = "0";
  try {
    return await fn();
  } finally {
    if (previous == null) delete process.env.O1_CODE_PROXY_LOGS;
    else process.env.O1_CODE_PROXY_LOGS = previous;
  }
}
