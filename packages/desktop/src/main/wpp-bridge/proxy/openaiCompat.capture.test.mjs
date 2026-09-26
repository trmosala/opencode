import { afterEach, describe, expect, test } from "bun:test";

// openaiCompat -> extensionBridge -> worker-pool -> session.ts imports electron; the shared stub in
// packages/desktop/test/preload.ts supplies it before any test file links.

const {
  handleChatCompletions,
  shouldRetryFreshReplay,
  shouldRecoverIncompleteTask,
  shouldRecoverMissingRequiredToolCall,
} = await import("./openaiCompat.mjs");
const { commitThread, resetThread, threadContextUsage } = await import("./sessionThreads.mjs");
const { estimateTokens } = await import("./tokenEstimate.mjs");

const KEY = "sess-A::CM_Opus5.5-XHigh";

afterEach(() => {
  resetThread(KEY);
});

describe("Opus High routing compatibility", () => {
  for (const model of ["CM_Opus 5 - High", "CM_Opus5.5-High"]) {
    test(`routes ${model} to the renamed WPP agent`, async () => {
      const calls = [];
      const response = fakeResponse();
      const bridge = {
        hasSession: () => false,
        run: async (prompt, options) => {
          calls.push({ prompt: JSON.parse(prompt), options });
          return bridgeRun("done");
        },
      };
      try {
        await withNoRunLogs(() => handleChatCompletions(
          { headers: { "x-session-affinity": "sess-opus-high" } },
          response,
          { ...body(user("hello")), model },
          { bridge },
        ));

        expect(response.statusCode).toBe(200);
        expect(calls).toHaveLength(1);
        expect(calls[0].options.model).toBe("CM_Opus5.5-High");
        expect(calls[0].options.sessionKey).toBe("sess-opus-high::CM_Opus5.5-High");
        expect(calls[0].prompt.toolCallProtocol).toBe("CM_XML_TOOL_CALL_V1");
        expect(JSON.parse(response.body).model).toBe(model);
      } finally {
        resetThread("sess-opus-high::CM_Opus5.5-High");
        resetThread("sess-opus-high::CM_GPT-5.6-Sol_High");
      }
    });
  }
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

  test("retries protocol incompatibility and reclassifies an exhausted login failure", async () => {
    const response = fakeResponse();
    let authChecks = 0;
    let runs = 0;
    const bridge = {
      hasSession: () => false,
      run: async () => {
        runs += 1;
        const error = typedError("o1_code_protocol_incompatible");
        error.statusCode = 409;
        throw error;
      },
      checkAuthState: async () => {
        authChecks += 1;
        return "WPP page is on a login or identity-provider URL";
      },
    };

    await withNoRunLogs(() => handleChatCompletions(
      { headers: {} },
      response,
      body(user("hello")),
      { bridge },
    ));

    expect(runs).toBe(2);
    expect(authChecks).toBe(1);
    expect(response.statusCode).toBe(401);
    expect(JSON.parse(response.body).error.type).toBe("wpp_auth_required");
  });

  // Pre-submit worker failures (recorder never armed; pinned thread lost) are duplicate-safe to
  // replay because no model request was sent — the worker pool discards the dead tab and throws,
  // and the proxy replays once on a fresh worker exactly like a capture failure.
  for (const type of ["o1_code_recorder_not_armed", "o1_code_thread_desync", "o1_code_image_attachment_desync"]) {
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
    for (const type of [
      "o1_code_capture_failure",
      "o1_code_recorder_not_armed",
      "o1_code_thread_desync",
      "o1_code_image_attachment_desync",
      "o1_code_incomplete_tool_call",
    ]) {
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

  test("retries an empty failed attempt even when an earlier attempt streamed prose", () => {
    const streamSession = { hasStreamed: () => true };
    const error = { type: "o1_code_capture_failure", attemptStreamed: false };
    expect(shouldRetryFreshReplay(error, { streamSession, isCompaction: false })).toBe(true);
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

  test("recovers a GPT announcement after tool progress without reopening an Opus final answer", () => {
    const messages = [
      user("Review the codebase with the available local tools."),
      { role: "assistant", content: null, tool_calls: [{ id: "call-1", type: "function", function: { name: "bash", arguments: "{}" } }] },
      { role: "tool", tool_call_id: "call-1", content: "clean" },
    ];
    const announcement = bridgeRun("I’ll create the report next.\nCM_TASK_COMPLETE_V1");
    const gpt = { ...toolBody(...messages), model: "CM_GPT-5.6 Sol - High" };

    expect(shouldRecoverMissingRequiredToolCall(gpt, announcement)).toBe(true);
    expect(shouldRecoverMissingRequiredToolCall(toolBody(...messages), announcement)).toBe(false);
    expect(shouldRecoverMissingRequiredToolCall(gpt, bridgeRun("Review complete.\nCM_TASK_COMPLETE_V1"))).toBe(false);
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

  test("buffers and discards an announcement-only response before tool recovery", async () => {
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
    requestBody.model = "CM_GPT-5.6 Sol - High";
    requestBody.stream = true;

    await withNoRunLogs(() => handleChatCompletions({ headers: {} }, response, requestBody, { bridge }));

    expect(calls).toBe(2);
    expect(progressHandlers[0]).toBeUndefined();
    expect(progressHandlers[1]).toBeUndefined();
    expect(response.body).not.toContain("I am inspecting the workspace.");
    expect(response.body).not.toContain("stop here");
    expect(response.body).toContain('"name":"bash"');
    expect(response.body).toContain('"finish_reason":"tool_calls"');
  });

  test("preserves live tool-turn progress for Opus", async () => {
    const response = fakeResponse();
    let progressHandler;
    const bridge = {
      hasSession: () => false,
      run: async (_prompt, options) => {
        progressHandler = options.onProgress;
        options.onProgress?.({ finalText: "I’m inspecting the workspace. Next step." });
        return bridgeRun(
          'I’m inspecting the workspace. Next step.\n<function_calls><invoke id="call-1" name="bash"><parameter name="command">git status</parameter></invoke></function_calls>',
        );
      },
    };
    const requestBody = toolBody(user("Inspect the workspace."));
    requestBody.stream = true;

    await withNoRunLogs(() => handleChatCompletions({ headers: {} }, response, requestBody, { bridge }));

    expect(progressHandler).toBeFunction();
    expect(response.body).toContain('"name":"bash"');
  });

  test("streams a visible preamble and its tool call in the same assistant turn", async () => {
    const response = fakeResponse();
    const bridge = {
      hasSession: () => false,
      run: async () => bridgeRun(
        'I’ll inspect the workspace now.\n<function_calls><invoke id="call-1" name="bash"><parameter name="command">git status --short</parameter></invoke></function_calls>',
      ),
    };
    const requestBody = toolBody(user("Inspect the workspace."));
    requestBody.stream = true;

    await withNoRunLogs(() => handleChatCompletions({ headers: {} }, response, requestBody, { bridge }));

    const content = response.body
      .split("\n")
      .filter((line) => line.startsWith("data: {") && !line.includes('"error"'))
      .map((line) => JSON.parse(line.slice(6)).choices?.[0]?.delta?.content || "")
      .join("");
    expect(content).toBe("I’ll inspect the workspace now.");
    expect(response.body).toContain('"name":"bash"');
    expect(response.body).toContain('"finish_reason":"tool_calls"');
    expect(response.body).not.toContain("<function_calls>");
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

describe("incomplete task recovery", () => {
  test("rejects an XML intention as a completed task", () => {
    expect(shouldRecoverIncompleteTask(
      toolBody(user("Inspect the workspace.")),
      bridgeRun("I’ll inspect the repository and identify the relevant code."),
    )).toBe(true);
    expect(shouldRecoverIncompleteTask(
      toolBody(user("Inspect the workspace.")),
      bridgeRun("Inspection complete.\nCM_TASK_COMPLETE_V1"),
    )).toBe(false);
  });

  test("rejects a forward-looking local action even when it carries the completion marker", () => {
    expect(shouldRecoverIncompleteTask(
      { ...toolBody(user("Inspect the workspace.")), model: "CM_GPT-5.6 Sol - High" },
      bridgeRun("I'll inspect the repository and run the tests now.\nCM_TASK_COMPLETE_V1"),
    )).toBe(true);
  });

  test("gates forward-looking marker rejection to phase-capable GPT profiles", () => {
    const response = bridgeRun("I’ll create the handoff now.\nCM_TASK_COMPLETE_V1");
    expect(shouldRecoverIncompleteTask(
      { ...toolBody(user("Prepare the handoff.")), model: "CM_GPT-5.6 Sol - High" },
      response,
    )).toBe(true);
    expect(shouldRecoverIncompleteTask(toolBody(user("Prepare the handoff.")), response)).toBe(false);
  });

  test("fresh-replays an incomplete XML call instead of returning it as prose", async () => {
    const response = fakeResponse();
    let calls = 0;
    const bridge = {
      hasSession: () => false,
      run: async () => {
        calls += 1;
        if (calls === 1) {
          return bridgeRun('<function_calls><invoke id="call-1" name="bash"><parameter name="command">git status');
        }
        return bridgeRun(
          '<function_calls><invoke id="call-2" name="bash"><parameter name="command">git status</parameter></invoke></function_calls>',
        );
      },
    };

    await withNoRunLogs(() => handleChatCompletions(
      { headers: {} },
      response,
      { ...toolBody(user("Inspect the workspace.")), model: "CM_GPT-5.6 Sol - High" },
      { bridge },
    ));

    expect(calls).toBe(2);
    expect(JSON.parse(response.body).choices[0].finish_reason).toBe("tool_calls");
  });

  test("does not reopen handoff language or optional follow-up", () => {
    expect(shouldRecoverIncompleteTask(
      toolBody(user("Prepare the patch.")),
      bridgeRun("The patch is ready. I'll leave deployment to you.\nCM_TASK_COMPLETE_V1"),
    )).toBe(false);
    expect(shouldRecoverIncompleteTask(
      toolBody(user("Prepare the patch.")),
      bridgeRun("The patch is ready. Let me know if you'd like another review.\nCM_TASK_COMPLETE_V1"),
    )).toBe(false);
  });

  test("continues once when an XML response stops at intention", async () => {
    const calls = [];
    commitThread(KEY, toolBody(user("hello")), assistant("previous"));
    const response = fakeResponse();
    const bridge = {
      hasSession: () => true,
      run: async (prompt, options) => {
        calls.push({ prompt: JSON.parse(prompt), options });
        if (calls.length === 1) return bridgeRun("I’ll inspect the repository now.");
        return bridgeRun(
          '<function_calls><invoke id="call-1" name="bash"><parameter name="command">git status --short</parameter></invoke></function_calls>',
        );
      },
    };

    await withNoRunLogs(() => handleChatCompletions(
      { headers: { "x-session-affinity": "sess-A" } },
      response,
      toolBody(user("hello"), assistant("previous"), user("Inspect the workspace.")),
      { bridge },
    ));

    expect(calls).toHaveLength(2);
    expect(calls[1].prompt.resumeIncomplete).toBe(true);
    expect(calls[1].prompt.tools).toEqual([
      { name: "bash", description: "run a command", parameters: { type: "object" } },
    ]);
    expect(JSON.parse(response.body).choices[0].finish_reason).toBe("tool_calls");
  });

  test("returns the deliberate task-incomplete error after two XML marker omissions", async () => {
    const response = fakeResponse();
    const bridge = {
      hasSession: () => false,
      run: async () => bridgeRun("I’ll inspect the repository now."),
    };

    await withNoRunLogs(() => handleChatCompletions(
      { headers: {} },
      response,
      toolBody(user("Inspect the workspace.")),
      { bridge },
    ));

    expect(response.statusCode).toBe(502);
    expect(JSON.parse(response.body).error.type).toBe("o1_code_task_incomplete");
  });

  test("streams a typed error instead of completing an announcement-only assistant turn", async () => {
    const response = fakeResponse();
    const bridge = {
      hasSession: () => false,
      run: async () => bridgeRun("I’ll inspect the repository now."),
    };
    const requestBody = toolBody(user("Inspect the workspace."));
    requestBody.stream = true;

    await withNoRunLogs(() => handleChatCompletions({ headers: {} }, response, requestBody, { bridge }));

    expect(response.body).toContain('"type":"o1_code_task_incomplete"');
    expect(response.body).not.toContain('"finish_reason":"stop"');
    expect(response.body).not.toContain('"delta":{"content":"The WPP agent returned');
  });
});

describe("handleChatCompletions token usage", () => {
  test("uses a confirmed changed WPP token pill as the context total", async () => {
    commitThread(KEY, body(user("hello")), assistant("previous"))
    const response = fakeResponse()
    const bridge = {
      hasSession: () => true,
      run: async () =>
        bridgeRun("done", {
          usage: {
            scope: "context",
            source: "dom-pill",
            fidelity: "confirmed",
            totalTokens: 117219,
          },
        }),
    }

    await withNoRunLogs(() =>
      handleChatCompletions(
        { headers: { "x-session-affinity": "sess-A" } },
        response,
        body(user("hello"), assistant("previous"), user("more")),
        { bridge },
      ),
    )

    expect(response.statusCode).toBe(200)
    const usage = JSON.parse(response.body).usage
    expect(usage.total_tokens).toBe(117219)
    expect(usage.completion_tokens).toBeGreaterThan(0)
    expect(usage.completion_tokens).toBeLessThanOrEqual(usage.total_tokens)
    expect(usage.prompt_tokens + usage.completion_tokens).toBe(usage.total_tokens)
  })

  test("falls back to the heuristic prompt tokens when no pill is present", async () => {
    commitThread(KEY, body(user("hello")), assistant("previous"))
    const response = fakeResponse()
    const bridge = {
      hasSession: () => true,
      run: async () => bridgeRun("done"),
    }

    await withNoRunLogs(() =>
      handleChatCompletions(
        { headers: { "x-session-affinity": "sess-A" } },
        response,
        body(user("hello"), assistant("previous"), user("more")),
        { bridge },
      ),
    )

    const promptTokens = JSON.parse(response.body).usage.prompt_tokens
    expect(Number.isFinite(promptTokens)).toBe(true)
    expect(promptTokens).toBeGreaterThan(0)
    expect(promptTokens).not.toBe(117219)
  })

  test("prefers exact network usage for non-streaming responses", async () => {
    const response = fakeResponse()
    const bridge = {
      hasSession: () => false,
      run: async () =>
        bridgeRun("done", {
          usage: {
            scope: "request",
            source: "network",
            fidelity: "exact",
            promptTokens: 120,
            completionTokens: 30,
            totalTokens: 999,
            cachedTokens: 40,
            reasoningTokens: 12,
          },
        }),
    }

    await withNoRunLogs(() => handleChatCompletions({ headers: {} }, response, body(user("hello")), { bridge }))

    expect(JSON.parse(response.body).usage).toEqual({
      prompt_tokens: 120,
      completion_tokens: 30,
      total_tokens: 150,
      prompt_tokens_details: { cached_tokens: 40 },
      completion_tokens_details: { reasoning_tokens: 12 },
    })
  })

  test("streams finish reason, exact usage-only chunk and DONE in order", async () => {
    const response = fakeResponse()
    const requestBody = body(user("hello"))
    requestBody.stream = true
    requestBody.stream_options = { include_usage: true }
    const bridge = {
      hasSession: () => false,
      run: async () =>
        bridgeRun("done", {
          usage: {
            scope: "request",
            source: "network",
            fidelity: "exact",
            promptTokens: 120,
            completionTokens: 30,
            cachedTokens: 40,
            reasoningTokens: 12,
          },
        }),
    }

    await withNoRunLogs(() => handleChatCompletions({ headers: {} }, response, requestBody, { bridge }))

    const finish = response.body.indexOf('"finish_reason":"stop"')
    const usage = response.body.indexOf('"choices":[],"usage"')
    const done = response.body.indexOf("data: [DONE]")
    expect(finish).toBeGreaterThanOrEqual(0)
    expect(usage).toBeGreaterThan(finish)
    expect(done).toBeGreaterThan(usage)
    expect(response.body).toContain('"prompt_tokens_details":{"cached_tokens":40}')
    expect(response.body).toContain('"completion_tokens_details":{"reasoning_tokens":12}')
  })

  test("continued fallback includes only the matching session's retained context", async () => {
    const bridge = {
      hasSession: () => true,
      run: async (_prompt, options) =>
        options.continueThread
          ? bridgeRun("second")
          : bridgeRun("first", {
              usage: {
                scope: "context",
                source: "dom-pill",
                fidelity: "confirmed",
                totalTokens: 400,
              },
            }),
    }
    const firstResponse = fakeResponse()
    await withNoRunLogs(() =>
      handleChatCompletions({ headers: { "x-session-affinity": "sess-A" } }, firstResponse, body(user("hello")), {
        bridge,
      }),
    )
    const secondResponse = fakeResponse()
    await withNoRunLogs(() =>
      handleChatCompletions(
        { headers: { "x-session-affinity": "sess-A" } },
        secondResponse,
        body(user("hello"), assistant("first"), user("more")),
        { bridge },
      ),
    )

    expect(JSON.parse(secondResponse.body).usage.prompt_tokens).toBeGreaterThanOrEqual(400)
  })

  test("fresh replay does not reuse retained context from the discarded worker", async () => {
    commitThread(KEY, body(user("hello")), assistant("previous"), {
      totalTokens: 400,
      source: "dom-pill",
      fidelity: "confirmed",
    })
    let calls = 0
    const response = fakeResponse()
    const bridge = {
      hasSession: () => true,
      run: async () => {
        calls++
        if (calls === 1) throw captureError("recorder_parser_miss")
        return bridgeRun("done")
      },
    }

    await withNoRunLogs(() =>
      handleChatCompletions(
        { headers: { "x-session-affinity": "sess-A" } },
        response,
        body(user("hello"), assistant("previous"), user("more")),
        { bridge },
      ),
    )

    expect(JSON.parse(response.body).usage.prompt_tokens).toBeLessThan(400)
  })

  for (const stream of [false, true]) {
    for (const mode of ["continue", "fresh", "replay", "measured-replay"]) {
      test(`incomplete recovery accounts for the current thread: ${mode}, stream=${stream}`, async () => {
        const prior = toolBody(user("hello"))
        commitThread(KEY, prior, assistant("previous"), {
          totalTokens: 200000,
          source: "dom-pill",
          fidelity: "confirmed",
        })
        const calls = []
        const incomplete = "The answer is ready."
        const final = "The result is verified."
        const replay = mode.endsWith("replay")
        const response = fakeResponse()
        const requestBody = {
          ...toolBody(user("hello"), assistant("previous"), user("Summarize the result.")),
          stream,
          stream_options: { include_usage: true },
        }
        const bridge = {
          hasSession: () => mode !== "fresh",
          run: async (prompt, options) => {
            calls.push({ prompt, continued: options.continueThread })
            if (replay && calls.length === 1) throw captureError("recorder_parser_miss")
            if (JSON.parse(prompt).resumeIncomplete) return bridgeRun(`${final}\nCM_TASK_COMPLETE_V1`)
            return bridgeRun(incomplete, mode === "measured-replay" ? {
              usage: { scope: "context", source: "dom-pill", fidelity: "confirmed", totalTokens: 4000 },
            } : {})
          },
        }

        await withNoRunLogs(() => handleChatCompletions(
          { headers: { "x-session-affinity": "sess-A" } },
          response,
          requestBody,
          { bridge },
        ))

        expect(response.statusCode).toBe(200)
        expect(calls.map((call) => call.continued)).toEqual(
          replay ? [true, false, true] : [mode === "continue", true],
        )
        const usage = stream
          ? response.body.split("\n")
              .filter((line) => line.startsWith("data: {"))
              .map((line) => JSON.parse(line.slice(6)))
              .find((chunk) => chunk.usage)?.usage
          : JSON.parse(response.body).usage
        const baseline = mode === "measured-replay"
          ? 4000
          : (mode === "continue" ? 200000 : 0)
            + estimateTokens(calls[replay ? 1 : 0].prompt) + estimateTokens(incomplete)
        expect(usage.prompt_tokens).toBe(baseline + estimateTokens(calls.at(-1).prompt))
        expect(usage.completion_tokens).toBe(estimateTokens(final))
        expect(usage.total_tokens).toBe(usage.prompt_tokens + usage.completion_tokens)
        expect(threadContextUsage(KEY)?.totalTokens).toBe(usage.total_tokens)
      })
    }
  }

  test("failed recovery clears retained usage instead of committing its intermediate result", async () => {
    commitThread(KEY, toolBody(user("hello")), assistant("previous"), {
      totalTokens: 200000,
      source: "dom-pill",
      fidelity: "confirmed",
    })
    const response = fakeResponse()
    const bridge = {
      hasSession: () => true,
      run: async () => bridgeRun("The answer is ready.", {
        usage: { scope: "context", source: "dom-pill", fidelity: "confirmed", totalTokens: 210000 },
      }),
    }

    await withNoRunLogs(() => handleChatCompletions(
      { headers: { "x-session-affinity": "sess-A" } },
      response,
      toolBody(user("hello"), assistant("previous"), user("Summarize the result.")),
      { bridge },
    ))

    expect(response.statusCode).toBe(502)
    expect(threadContextUsage(KEY)).toBeUndefined()
  })

  test("worker replacement does not reuse retained context from the missing pinned tab", async () => {
    commitThread(KEY, body(user("hello")), assistant("previous"), {
      totalTokens: 400,
      source: "dom-pill",
      fidelity: "confirmed",
    })
    const response = fakeResponse()
    const bridge = {
      hasSession: () => false,
      run: async () => bridgeRun("done"),
    }

    await withNoRunLogs(() =>
      handleChatCompletions(
        { headers: { "x-session-affinity": "sess-A" } },
        response,
        body(user("hello"), assistant("previous"), user("more")),
        { bridge },
      ),
    )

    expect(JSON.parse(response.body).usage.prompt_tokens).toBeLessThan(400)
  })
})

describe("handleChatCompletions image inputs", () => {
  test("forwards images only from the latest user turn", async () => {
    const calls = [];
    const response = fakeResponse();
    const bridge = {
      hasSession: () => false,
      run: async (_prompt, options) => {
        calls.push(options);
        return bridgeRun("done");
      },
    };
    const first = user([{ type: "text", text: "first" }, imagePart()]);
    const latest = user([
      { type: "text", text: "latest" },
      imagePart(),
      imagePart(),
      imagePart(),
      imagePart(),
      imagePart(),
    ]);

    await withNoRunLogs(() =>
      handleChatCompletions({ headers: {} }, response, body(first, assistant("previous"), latest), { bridge }),
    );

    expect(calls).toHaveLength(1);
    expect(calls[0].images).toHaveLength(5);
    expect(calls[0].images.map((image) => image.id)).toEqual([
      "image_1",
      "image_2",
      "image_3",
      "image_4",
      "image_5",
    ]);
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
  return { model: "CM_Opus5.5-XHigh", stream: false, messages };
}

function toolBody(...messages) {
  return {
    ...body(...messages),
    tools: [{ type: "function", function: { name: "bash", description: "run a command", parameters: { type: "object" } } }],
  };
}

function user(content) {
  return { role: "user", content };
}

function assistant(content) {
  return { role: "assistant", content };
}

function imagePart() {
  return {
    type: "image_url",
    image_url: {
      url: "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=",
    },
  };
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
