import { afterEach, describe, expect, mock, test } from "bun:test";

mock.module("electron", () => ({ BrowserWindow: function BrowserWindow() {}, session: { fromPartition: () => ({}) } }));

const { handleChatCompletions, shouldRetryFreshReplay, shouldRecoverMissingRequiredToolCall, shouldRecoverIncompleteTask } = await import("./openaiCompat.mjs");
const { commitThread, resetThread } = await import("./sessionThreads.mjs");

const KEY = "sess-A::CM_Opus 4.8 - Extra High";
const SOL_KEY = "sess-A::CM_GPT-5.5 - Medium";

afterEach(() => {
  resetThread(KEY);
  resetThread(SOL_KEY);
});

describe("handleChatCompletions capture retry", () => {
  test("retries a capture failure once as a fresh replay", async () => {
    commitThread(KEY, body(user("hello")), assistant("previous"));
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
      body(user("hello"), assistant("previous"), user("more")),
      { bridge },
    ));

    expect(calls).toHaveLength(2);
    expect(calls[0].continueThread).toBe(true);
    expect(calls[1].continueThread).toBe(false);
    expect(response.statusCode).toBe(200);
    expect(response.headers["x-o1-code-response-source"]).toBe("network");
    expect(JSON.parse(response.body).choices[0].message.content).toBe("done");
  });

  test("validates required tool use after a successful fresh replay", async () => {
    const calls = [];
    const response = fakeResponse();
    const bridge = {
      hasSession: () => false,
      run: async (_prompt, options) => {
        calls.push(options);
        if (calls.length === 1) throw captureError("recorder_parser_miss");
        if (calls.length === 2) return bridgeRun("The workspace looks fine.");
        return bridgeRun(
          '<function_calls><invoke id="call-1" name="bash"><parameter name="command">git status</parameter></invoke></function_calls>',
        );
      },
    };

    await withNoRunLogs(() => handleChatCompletions(
      { headers: {} },
      response,
      toolBody(user("Inspect the workspace with the available local tools.")),
      { bridge },
    ));

    expect(calls).toHaveLength(3);
    expect(calls[1].continueThread).toBe(false);
    expect(calls[2].continueThread).toBe(false);
    expect(JSON.parse(response.body).choices[0].finish_reason).toBe("tool_calls");
  });

  test("validates task completion after a successful fresh replay", async () => {
    const calls = [];
    const response = fakeResponse();
    const bridge = {
      hasSession: () => true,
      run: async (_prompt, options) => {
        calls.push(options);
        if (calls.length === 1) throw captureError("recorder_parser_miss");
        if (calls.length === 2) return bridgeRun("I inspected the baseline.");
        return bridgeRun("The review is complete.\nCM_TASK_COMPLETE_V1");
      },
    };

    await withNoRunLogs(() => handleChatCompletions(
      { headers: { "x-session-affinity": "sess-A" } },
      response,
      solToolBody(user("Review the codebase.")),
      { bridge },
    ));

    expect(calls).toHaveLength(3);
    expect(calls[1].continueThread).toBe(false);
    expect(calls[2].continueThread).toBe(true);
    expect(JSON.parse(response.body).choices[0].message.content).toBe("The review is complete.");
  });

  test("surfaces a typed capture failure after one failed retry", async () => {
    commitThread(KEY, body(user("hello")), assistant("previous"));
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
      body(user("hello"), assistant("previous"), user("more")),
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
    commitThread(KEY, body(user("hello")), assistant("previous"));
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
      body(user("hello"), assistant("previous"), user("more")),
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
    commitThread(KEY, body(user("hello")), assistant("previous"));
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
      body(user("hello"), assistant("previous"), user("more")),
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
      commitThread(KEY, body(user("hello")), assistant("previous"));
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
        body(user("hello"), assistant("previous"), user("more")),
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

describe("required tool-call recovery", () => {
  test("uses the request contract rather than the terminal prose", () => {
    const explicitPrompt = toolBody(user("Review the codebase with the available local tools."));
    const requiredChoice = { ...toolBody(user("inspect the workspace")), tool_choice: "required" };
    expect(shouldRecoverMissingRequiredToolCall(explicitPrompt, bridgeRun("Here is an answer from memory."))).toBe(true);
    expect(shouldRecoverMissingRequiredToolCall(requiredChoice, bridgeRun("Everything looks fine."))).toBe(true);
    expect(shouldRecoverMissingRequiredToolCall(toolBody(user("Explain dependency injection")), bridgeRun("Here is the explanation."))).toBe(false);
    expect(shouldRecoverMissingRequiredToolCall(body(user("Use the local tools.")), bridgeRun("No tools configured."))).toBe(false);
    expect(shouldRecoverMissingRequiredToolCall(explicitPrompt, bridgeRun("No tool call."), { isCompaction: true })).toBe(false);
  });

  test("does not recover a response that already contains a tool call", () => {
    const run = bridgeRun('<function_calls><invoke id="call-1" name="bash"><parameter name="command">git status</parameter></invoke></function_calls>');
    expect(shouldRecoverMissingRequiredToolCall(toolBody(user("Use the local tools to inspect the workspace.")), run)).toBe(false);
  });

  test("allows a terminal findings answer after tool progress in the active turn", () => {
    const request = toolBody(
      user("Review the codebase with the available local tools."),
      { role: "assistant", content: null, tool_calls: [{ id: "call-1", type: "function", function: { name: "bash", arguments: "{}" } }] },
      { role: "tool", tool_call_id: "call-1", content: "clean" },
    );
    expect(shouldRecoverMissingRequiredToolCall(request, bridgeRun("No findings."))).toBe(false);
  });

  test("discards the no-tool answer and replays once with targeted tool recovery", async () => {
    const calls = [];
    const response = fakeResponse();
    const bridge = {
      hasSession: () => false,
      run: async (prompt, options) => {
        calls.push({ prompt: JSON.parse(prompt), options });
        if (calls.length === 1) return bridgeRun("Here is a confident answer without inspecting anything.");
        return bridgeRun('<function_calls><invoke id="call-1" name="bash"><parameter name="command">git status --short</parameter></invoke></function_calls>');
      },
    };

    await withNoRunLogs(() => handleChatCompletions(
      { headers: {} },
      response,
      toolBody(user("Inspect the workspace with the available local tools.")),
      { bridge },
    ));

    expect(calls).toHaveLength(2);
    expect(calls[0].prompt.instructions[0]).not.toContain("tool-routing step for a local coding session");
    expect(calls[1].prompt.mode).toBe("fresh");
    expect(calls[1].prompt.instructions[0]).toContain("tool-routing step for a local coding session");
    expect(calls[1].prompt.messages).toEqual([{ role: "user", content: "Inspect the workspace with the available local tools." }]);
    expect(calls[1].options.continueThread).toBe(false);
    const completion = JSON.parse(response.body).choices[0];
    expect(completion.finish_reason).toBe("tool_calls");
    expect(completion.message.content).toBeNull();
    expect(completion.message.tool_calls[0].function.name).toBe("bash");
  });

  test("streams safe commentary while the terminal no-tool sentence stays quarantined", async () => {
    const response = fakeResponse();
    let calls = 0;
    const progressHandlers = [];
    const bridge = {
      hasSession: () => false,
      run: async (_prompt, options) => {
        calls += 1;
        progressHandlers.push(options.onProgress);
        if (calls === 1) {
          const failed = "I am inspecting the workspace. I will stop here without making a tool call.";
          options.onProgress?.({ finalText: failed });
          return bridgeRun(failed);
        }
        return bridgeRun('<function_calls><invoke id="call-2" name="bash"><parameter name="command">git diff --stat</parameter></invoke></function_calls>');
      },
    };
    const requestBody = toolBody(user("Inspect the workspace with the available local tools."));
    requestBody.stream = true;

    await withNoRunLogs(() => handleChatCompletions({ headers: {} }, response, requestBody, { bridge }));

    expect(calls).toBe(2);
    expect(progressHandlers[0]).toBeFunction();
    expect(progressHandlers[1]).toBeUndefined();
    expect(response.body).toContain("I am inspecting the workspace. ");
    expect(response.body).not.toContain("stop here");
    expect(response.body).toContain('"name":"bash"');
    expect(response.body).toContain('"finish_reason":"tool_calls"');
  });

  test("returns a typed error when the bounded replay also omits the required tool call", async () => {
    const response = fakeResponse();
    const bridge = {
      hasSession: () => false,
      run: async () => bridgeRun("A terminal answer with no tool call."),
    };

    await withNoRunLogs(() => handleChatCompletions(
      { headers: {} },
      response,
      toolBody(user("Inspect the workspace with the available local tools.")),
      { bridge },
    ));

    expect(response.statusCode).toBe(502);
    expect(JSON.parse(response.body).error.type).toBe("o1_code_required_tool_not_called");
  });
});

describe("task completion marker", () => {
  test("accepts tool calls and marked terminal answers, but recovers unmarked prose", () => {
    const request = solToolBody(user("Review the codebase."));
    expect(shouldRecoverIncompleteTask(request, bridgeRun('{"type":"tool_call","tool":"bash","args":{"command":"git status"}}'))).toBe(false);
    expect(shouldRecoverIncompleteTask(request, bridgeRun("Review complete.\nCM_TASK_COMPLETE_V1"))).toBe(false);
    expect(shouldRecoverIncompleteTask(request, bridgeRun("I inspected one file and stopped."))).toBe(true);
  });

  test("rejects a completion marker contradicted by an explicit incomplete-task claim", () => {
    const request = solToolBody(user("Review the codebase."));
    expect(shouldRecoverIncompleteTask(
      request,
      bridgeRun("I'm unable to complete the codebase review because the tool session ended.\nCM_TASK_COMPLETE_V1"),
    )).toBe(true);
    expect(shouldRecoverIncompleteTask(
      request,
      bridgeRun("A complete review still requires further source inspection.\nCM_TASK_COMPLETE_V1"),
    )).toBe(true);
    expect(shouldRecoverIncompleteTask(
      request,
      bridgeRun("Finding: the cache invalidation implementation is incomplete.\nCM_TASK_COMPLETE_V1"),
    )).toBe(false);
  });

  test("replays a self-contained request when completion recovery is unpinned", async () => {
    const calls = [];
    const response = fakeResponse();
    const bridge = {
      hasSession: () => false,
      run: async (prompt, options) => {
        calls.push({ prompt: JSON.parse(prompt), options });
        if (calls.length === 1) return bridgeRun("I inspected the baseline.");
        return bridgeRun("The review is complete.\nCM_TASK_COMPLETE_V1");
      },
    };
    await withNoRunLogs(() => handleChatCompletions(
      { headers: {} }, response, solToolBody(user("Review the codebase.")), { bridge },
    ));
    expect(calls).toHaveLength(2);
    expect(calls[1].prompt).toMatchObject({
      mode: "fresh",
      messages: [{ role: "user", content: "Review the codebase." }],
    });
    expect(calls[1].options.continueThread).toBe(false);
    expect(JSON.parse(response.body).choices[0].message.content).toBe("The review is complete.");
  });

  test("continues the pinned thread once, strips the marker, and returns the completed answer", async () => {
    const calls = [];
    const response = fakeResponse();
    const bridge = {
      hasSession: () => true,
      run: async (prompt, options) => {
        calls.push({ prompt: JSON.parse(prompt), options });
        if (calls.length === 1) return bridgeRun("I inspected the baseline.");
        return bridgeRun("The review is complete.\nCM_TASK_COMPLETE_V1");
      },
    };
    await withNoRunLogs(() => handleChatCompletions(
      { headers: { "x-session-affinity": "sess-A" } },
      response,
      solToolBody(user("Review the codebase.")),
      { bridge },
    ));
    expect(calls).toHaveLength(2);
    expect(calls[1].prompt).toMatchObject({ mode: "continue", resumeIncomplete: true, messages: [] });
    expect(calls[1].options.continueThread).toBe(true);
    expect(JSON.parse(response.body).choices[0].message.content).toBe("The review is complete.");
  });

  test("returns a typed error after a second unmarked terminal answer", async () => {
    const response = fakeResponse();
    let authChecks = 0;
    const bridge = {
      hasSession: () => false,
      run: async () => bridgeRun("Still incomplete."),
      checkAuthState: async () => {
        authChecks += 1;
        return "WPP page is on a login or identity-provider URL";
      },
    };
    await withNoRunLogs(() => handleChatCompletions(
      { headers: {} }, response, solToolBody(user("Review the codebase.")), { bridge },
    ));
    expect(authChecks).toBe(0);
    expect(response.statusCode).toBe(502);
    expect(JSON.parse(response.body).error.type).toBe("o1_code_task_incomplete");
  });
});

describe("handleChatCompletions token usage", () => {
  test("maps WPP's cumulative token pill onto prompt_tokens", async () => {
    commitThread(KEY, body(user("hello")), assistant("previous"));
    const response = fakeResponse();
    const bridge = {
      hasSession: () => true,
      run: async () => bridgeRun("done", { usage: { cumulativeTokens: 117219, source: "dom-pill", lowFidelity: true } }),
    };

    await withNoRunLogs(() => handleChatCompletions(
      { headers: { "x-session-affinity": "sess-A" } },
      response,
      body(user("hello"), assistant("previous"), user("more")),
      { bridge },
    ));

    expect(response.statusCode).toBe(200);
    expect(JSON.parse(response.body).usage.prompt_tokens).toBe(117219);
  });

  test("falls back to the heuristic prompt tokens when no pill is present", async () => {
    commitThread(KEY, body(user("hello")), assistant("previous"));
    const response = fakeResponse();
    const bridge = {
      hasSession: () => true,
      run: async () => bridgeRun("done"),
    };

    await withNoRunLogs(() => handleChatCompletions(
      { headers: { "x-session-affinity": "sess-A" } },
      response,
      body(user("hello"), assistant("previous"), user("more")),
      { bridge },
    ));

    const promptTokens = JSON.parse(response.body).usage.prompt_tokens;
    expect(Number.isFinite(promptTokens)).toBe(true);
    expect(promptTokens).toBeGreaterThan(0);
    expect(promptTokens).not.toBe(117219);
  });
});

describe("handleChatCompletions session serialization", () => {
  test("calculates the second delta only after the first turn commits", async () => {
    let releaseFirst;
    let markFirstStarted;
    const firstGate = new Promise((resolve) => { releaseFirst = resolve; });
    const firstStarted = new Promise((resolve) => { markFirstStarted = resolve; });
    const calls = [];
    const bridge = {
      hasSession: () => true,
      run: async (prompt, options) => {
        calls.push({ prompt, options });
        if (calls.length === 1) {
          markFirstStarted();
          await firstGate;
          return bridgeRun("first answer");
        }
        return bridgeRun("second answer");
      },
    };
    const firstResponse = fakeResponse();
    const secondResponse = fakeResponse();
    const previousLogs = process.env.O1_CODE_PROXY_LOGS;
    process.env.O1_CODE_PROXY_LOGS = "0";

    const first = handleChatCompletions(
      { headers: { "x-session-affinity": "sess-A" } },
      firstResponse,
      body(user("hello")),
      { bridge },
    );
    await firstStarted;

    const second = handleChatCompletions(
      { headers: { "x-session-affinity": "sess-A" } },
      secondResponse,
      body(user("hello"), assistant("first answer"), user("more")),
      { bridge },
    );
    await Promise.resolve();
    expect(calls).toHaveLength(1);

    releaseFirst();
    try {
      await Promise.all([first, second]);
    } finally {
      if (previousLogs == null) delete process.env.O1_CODE_PROXY_LOGS;
      else process.env.O1_CODE_PROXY_LOGS = previousLogs;
    }

    expect(calls).toHaveLength(2);
    expect(calls[1].options.continueThread).toBe(true);
    expect(JSON.parse(calls[1].prompt).messages).toEqual([{ role: "user", content: "more" }]);
  });
});

function body(...messages) {
  return { model: "CM_Opus 4.8 - Extra High", stream: false, messages };
}

function toolBody(...messages) {
  return {
    ...body(...messages),
    tools: [{ type: "function", function: { name: "bash", description: "run a command", parameters: { type: "object" } } }],
  };
}

function solToolBody(...messages) {
  return {
    ...toolBody(...messages),
    model: "CM_GPT-5.5 - Medium",
  };
}

function user(content) {
  return { role: "user", content };
}

function assistant(content) {
  return { role: "assistant", content };
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
