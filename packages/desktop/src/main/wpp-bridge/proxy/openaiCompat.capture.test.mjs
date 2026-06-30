import { afterEach, describe, expect, mock, test } from "bun:test";

mock.module("electron", () => ({ BrowserWindow: function BrowserWindow() {}, session: { fromPartition: () => ({}) } }));

const { handleChatCompletions, shouldRetryFreshReplay } = await import("./openaiCompat.mjs");
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

  // When the retry is exhausted AND the live WPP session probes as logged out, the bare capture
  // failure is reclassified as wpp_auth_required (and the SSO window is popped via markAuthRequired)
  // so the operator is told to log in rather than shown a recorder/capture error.
  test("reclassifies an exhausted failure as auth-required when the session is logged out", async () => {
    commitThread(KEY, body(user("hello")));
    const response = fakeResponse();
    let authMarked = null;
    const bridge = {
      hasSession: () => true,
      run: async () => {
        throw captureError("submit_or_ui_failure");
      },
      checkAuthState: async () => "WPP page is asking for sign-in",
      markAuthRequired: (reason) => {
        authMarked = reason;
      },
    };

    await withNoRunLogs(() => handleChatCompletions(
      { headers: { "x-session-affinity": "sess-A" } },
      response,
      body(user("hello"), user("more")),
      { bridge },
    ));

    expect(authMarked).toBe("WPP page is asking for sign-in");
    expect(response.statusCode).toBe(401);
    expect(JSON.parse(response.body).error).toMatchObject({
      type: "wpp_auth_required",
      retryCount: 1,
    });
  });

  // A logged-IN probe (null reason) must leave the original failure untouched — no false auth pop.
  test("leaves the original failure when the session probes as logged in", async () => {
    commitThread(KEY, body(user("hello")));
    const response = fakeResponse();
    let authMarked = false;
    const bridge = {
      hasSession: () => true,
      run: async () => {
        throw captureError("submit_or_ui_failure");
      },
      checkAuthState: async () => null,
      markAuthRequired: () => {
        authMarked = true;
      },
    };

    await withNoRunLogs(() => handleChatCompletions(
      { headers: { "x-session-affinity": "sess-A" } },
      response,
      body(user("hello"), user("more")),
      { bridge },
    ));

    expect(authMarked).toBe(false);
    expect(response.statusCode).toBe(502);
    expect(JSON.parse(response.body).error).toMatchObject({
      type: "o1_code_capture_failure",
      kind: "submit_or_ui_failure",
    });
  });

  // Pre-submit worker failures (recorder never armed; pinned thread lost) are duplicate-safe to
  // replay because no model request was sent — the worker pool discards the dead tab and throws,
  // and the proxy replays once on a fresh worker exactly like a capture failure.
  for (const type of ["o1_code_recorder_not_armed", "o1_code_thread_desync"]) {
    test(`retries a ${type} failure once as a fresh replay`, async () => {
      commitThread(KEY, body(user("hello")));
      const calls = [];
      const response = fakeResponse();
      const bridge = {
        hasSession: () => true,
        run: async (_prompt, options) => {
          calls.push(options);
          if (calls.length === 1) throw typedError(type);
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
      expect(calls[1].continueThread).toBe(false);
      expect(response.statusCode).toBe(200);
      expect(JSON.parse(response.body).choices[0].message.content).toBe("done");
    });
  }
});

describe("shouldRetryFreshReplay", () => {
  const opts = { streamSession: null, isCompaction: false };

  test("retries every fresh-replay-healable failure type", () => {
    for (const type of ["o1_code_capture_failure", "o1_code_recorder_not_armed", "o1_code_thread_desync"]) {
      expect(shouldRetryFreshReplay({ type }, opts)).toBe(true);
    }
  });

  test("does not retry an unrelated failure type", () => {
    expect(shouldRetryFreshReplay({ type: "o1_code_wrong_agent" }, opts)).toBe(false);
    expect(shouldRetryFreshReplay({ type: undefined }, opts)).toBe(false);
  });

  test("never retries compaction", () => {
    expect(shouldRetryFreshReplay({ type: "o1_code_capture_failure" }, { ...opts, isCompaction: true })).toBe(false);
  });

  test("never retries once prose has been streamed", () => {
    const streamSession = { hasStreamed: () => true };
    expect(shouldRetryFreshReplay({ type: "o1_code_recorder_not_armed" }, { streamSession, isCompaction: false })).toBe(false);
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

function typedError(type) {
  const error = new Error(type);
  error.statusCode = 502;
  error.type = type;
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
