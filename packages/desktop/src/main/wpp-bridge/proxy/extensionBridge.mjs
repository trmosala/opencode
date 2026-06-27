const DEFAULT_EXTENSION_TIMEOUT_MS = Number(process.env.O1_CODE_EXTENSION_TIMEOUT_MS || process.env.O1_CODE_TIMEOUT_MS || 900000);
const DEFAULT_CLIENT_TTL_MS = Number(process.env.O1_CODE_CLIENT_TTL_MS || 10 * 60 * 1000);
const MAX_RECENT_JOBS = 20;

export class ExtensionBridge {
  constructor() {
    this.maxConcurrent = Math.max(1, Number(process.env.O1_CODE_MAX_TABS) || 5);
    this.pendingJobs = [];
    this.jobs = new Map();
    this.waiters = new Map();
    this.clients = new Map();
    this.counters = {
      enqueued: 0,
      leased: 0,
      succeeded: 0,
      failed: 0,
      expired: 0
    };
    this.recentJobs = [];
    // Live progress pub/sub for streaming. progressListeners maps a job id to the set of
    // subscriber callbacks (the SSE handler); lastProgress holds the most recent
    // { seq, finalText } frame per job so a subscriber that attaches slightly after the first
    // frame arrives can be replayed immediately (covers the enqueue->subscribe race).
    this.progressListeners = new Map();
    this.lastProgress = new Map();
  }

  enqueue(payload, options = {}) {
    this.cleanupExpiredJobs();

    const id = crypto.randomUUID();
    const timeoutMs = Number(options.timeoutMs || DEFAULT_EXTENSION_TIMEOUT_MS);
    const createdAtMs = Date.now();
    const job = {
      id,
      type: "ask",
      createdAt: new Date(createdAtMs).toISOString(),
      createdAtMs,
      timeoutMs,
      payload,
      state: "queued",
      leaseId: null,
      clientId: null,
      leasedAt: null,
      leasedAtMs: null,
      attempts: 0,
      completedAt: null,
      completedAtMs: null,
      durationMs: null,
      diagnostics: null,
      resultSummary: null
    };

    this.jobs.set(id, job);
    this.pendingJobs.push(job);
    this.counters.enqueued += 1;

    // Hand the job id to the caller synchronously, before the completion promise is returned,
    // so a streaming caller can subscribe to live progress keyed on this id without waiting for
    // the job to finish. Backward compatible: callers that pass no onEnqueued are unaffected.
    if (typeof options.onEnqueued === "function") {
      try {
        options.onEnqueued(id);
      } catch {
        // A subscriber failure must never block enqueueing the job.
      }
    }

    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        this.expireJob(id);
      }, timeoutMs);

      this.waiters.set(id, { resolve, reject, timeout });
    });
  }

  // Publish a cumulative progress frame for a job. Frames carry a monotonic seq and the full
  // text-so-far; out-of-order or duplicate frames (seq <= the stored seq) are dropped so the
  // best-effort POST transport from the extension self-heals against reordering. The
  // authoritative result still arrives via complete().
  pushProgress(jobId, frame = {}) {
    if (!jobId || !this.jobs.has(jobId)) {
      return { ok: true, matched: false };
    }

    const seq = Number(frame.seq);
    const finalText = typeof frame.finalText === "string" ? frame.finalText : "";

    if (!Number.isFinite(seq)) {
      return { ok: true, matched: false };
    }

    const previous = this.lastProgress.get(jobId);
    if (previous && seq <= previous.seq) {
      return { ok: true, matched: true, stale: true };
    }

    const next = { seq, finalText };
    this.lastProgress.set(jobId, next);

    const listeners = this.progressListeners.get(jobId);
    if (listeners) {
      for (const listener of listeners) {
        try {
          listener(next);
        } catch {
          // A subscriber failure must never interfere with progress fan-out.
        }
      }
    }

    return { ok: true, matched: true };
  }

  // Subscribe to live progress frames for a job. Immediately replays the latest stored frame
  // (if any) so a subscriber that attaches just after the first frame still sees it. Returns an
  // unsubscribe function.
  subscribeProgress(jobId, callback) {
    if (!jobId || typeof callback !== "function") {
      return () => {};
    }

    const listeners = this.progressListeners.get(jobId) || new Set();
    listeners.add(callback);
    this.progressListeners.set(jobId, listeners);

    const replay = this.lastProgress.get(jobId);
    if (replay) {
      try {
        callback(replay);
      } catch {
        // Ignore replay failures; future frames will still be delivered.
      }
    }

    return () => {
      const set = this.progressListeners.get(jobId);
      if (!set) {
        return;
      }
      set.delete(callback);
      if (set.size === 0) {
        this.progressListeners.delete(jobId);
      }
    };
  }

  teardownProgress(jobId) {
    this.progressListeners.delete(jobId);
    this.lastProgress.delete(jobId);
  }

  poll(clientId = "unknown") {
    this.cleanupExpiredJobs();
    this.cleanupStaleClients();
    this.touchClient(clientId);

    // Hand out jobs up to the concurrency cap so parallel sub-agents can run in their own
    // tabs. The extension still controls how many tabs it actually opens; this cap is the
    // safety ceiling. (Previously this was a single-job gate, which serialized everything.)
    if (this.inFlightCount() >= this.maxConcurrent) {
      return null;
    }

    const job = this.pendingJobs.shift() || null;
    if (!job) {
      return null;
    }

    this.leaseJob(job, clientId);
    return job;
  }

  complete(result) {
    this.cleanupExpiredJobs();
    const id = result?.id || result?.jobId;

    if (!id) {
      const error = new Error("Bridge result is missing job id.");
      error.statusCode = 400;
      throw error;
    }

    const waiter = this.waiters.get(id);
    const job = this.jobs.get(id);

    if (!waiter) {
      return { ok: true, matched: false };
    }

    clearTimeout(waiter.timeout);
    this.waiters.delete(id);
    this.jobs.delete(id);
    this.teardownProgress(id);

    if (result.ok === false) {
      this.finishJob(job, "failed", result);
      const error = new Error(result.error || "O1-Code extension job failed.");
      error.statusCode = result.statusCode || 502;
      error.type = result.type || "o1_code_extension_job_error";
      error.bridgeResult = result;
      waiter.reject(error);
    } else {
      this.finishJob(job, "succeeded", result);
      waiter.resolve(result);
    }

    return { ok: true, matched: true };
  }

  health() {
    this.cleanupExpiredJobs();
    this.cleanupStaleClients();
    const now = Date.now();
    const activeJobs = Array.from(this.jobs.values());

    return {
      ok: true,
      pendingJobs: activeJobs.filter((job) => job.state === "queued").length,
      inFlightJobs: activeJobs.filter((job) => job.state === "leased" || job.state === "running").length,
      jobs: activeJobs.map((job) => this.jobHealth(job, now)),
      recentJobs: this.recentJobs.map((job) => this.jobHealth(job, now)),
      counters: { ...this.counters },
      clients: Array.from(this.clients.entries()).map(([id, client]) => ({
        id,
        lastSeenAt: client.lastSeenAt,
        phase: client.phase || null,
        status: client.status || null,
        counters: client.counters || null
      }))
    };
  }

  cleanupExpiredJobs(now = Date.now()) {
    for (const job of Array.from(this.jobs.values())) {
      if (now - job.createdAtMs >= job.timeoutMs) {
        this.expireJob(job.id);
      }
    }
  }

  cleanupStaleClients(now = Date.now()) {
    for (const [id, lastSeenAt] of this.clients.entries()) {
      const lastSeenMs = Date.parse(typeof lastSeenAt === "string" ? lastSeenAt : lastSeenAt?.lastSeenAt);

      if (!Number.isFinite(lastSeenMs) || now - lastSeenMs >= DEFAULT_CLIENT_TTL_MS) {
        this.clients.delete(id);
      }
    }
  }

  expireJob(id) {
    const job = this.jobs.get(id);
    const waiter = this.waiters.get(id);

    this.pendingJobs = this.pendingJobs.filter((pendingJob) => pendingJob.id !== id);
    this.waiters.delete(id);
    this.jobs.delete(id);
    this.teardownProgress(id);
    this.finishJob(job, "expired");

    if (!waiter) {
      return;
    }

    clearTimeout(waiter.timeout);
    const timeoutMs = job?.timeoutMs || DEFAULT_EXTENSION_TIMEOUT_MS;
    const error = new Error(`Timed out waiting for O1-Code extension result after ${timeoutMs} ms.`);
    error.statusCode = 504;
    error.type = "o1_code_extension_timeout";
    waiter.reject(error);
  }

  touchClient(clientId = "unknown") {
    const existing = this.clients.get(clientId) || {};
    this.clients.set(clientId, {
      ...existing,
      lastSeenAt: new Date().toISOString()
    });
  }

  updateClientStatus(clientId = "unknown", status = {}) {
    const existing = this.clients.get(clientId) || {};
    const next = {
      ...existing,
      lastSeenAt: new Date().toISOString(),
      phase: status.phase || existing.phase || null,
      status: sanitizeClientStatus(status.status || existing.status || null),
      counters: sanitizeClientCounters(status.counters || existing.counters || null)
    };
    this.clients.set(clientId, next);
    return { ok: true, matched: Boolean(existing.lastSeenAt) };
  }
  activeJob() {
    return Array.from(this.jobs.values()).find((job) => job.state === "leased" || job.state === "running") || null;
  }

  inFlightCount() {
    let count = 0;
    for (const job of this.jobs.values()) {
      if (job.state === "leased" || job.state === "running") {
        count += 1;
      }
    }
    return count;
  }

  markRunning(id, diagnostics = null) {
    const job = this.jobs.get(id);
    if (!job) {
      return { ok: true, matched: false };
    }

    job.state = "running";
    job.diagnostics = compactDiagnostics(diagnostics);
    return { ok: true, matched: true };
  }

  leaseJob(job, clientId) {
    const now = Date.now();
    job.state = "leased";
    job.leaseId = crypto.randomUUID();
    job.clientId = clientId;
    job.leasedAtMs = now;
    job.leasedAt = new Date(now).toISOString();
    job.attempts += 1;
    this.counters.leased += 1;
    return job;
  }

  finishJob(job, state, result = null) {
    if (!job) {
      return;
    }

    const now = Date.now();
    job.state = state;
    job.completedAtMs = now;
    job.completedAt = new Date(now).toISOString();
    job.durationMs = Math.max(0, now - job.createdAtMs);
    job.diagnostics = compactDiagnostics(result?.diagnostics);
    job.resultSummary = summarizeResult(result);
    if (state === "succeeded") {
      this.counters.succeeded += 1;
    } else if (state === "failed") {
      this.counters.failed += 1;
    } else if (state === "expired") {
      this.counters.expired += 1;
    }
    this.rememberRecentJob(job);
  }

  rememberRecentJob(job) {
    const snapshot = {
      id: job.id,
      type: job.type,
      state: job.state,
      createdAt: job.createdAt,
      createdAtMs: job.createdAtMs,
      timeoutMs: job.timeoutMs,
      leaseId: job.leaseId,
      clientId: job.clientId,
      leasedAt: job.leasedAt,
      leasedAtMs: job.leasedAtMs,
      attempts: job.attempts,
      completedAt: job.completedAt,
      completedAtMs: job.completedAtMs,
      durationMs: job.durationMs,
      diagnostics: job.diagnostics,
      resultSummary: job.resultSummary
    };

    this.recentJobs = this.recentJobs.filter((recentJob) => recentJob.id !== job.id);
    this.recentJobs.unshift(snapshot);

    if (this.recentJobs.length > MAX_RECENT_JOBS) {
      this.recentJobs.length = MAX_RECENT_JOBS;
    }
  }

  jobHealth(job, now = Date.now()) {
    return {
      id: job.id,
      type: job.type,
      state: job.state,
      createdAt: job.createdAt,
      ageMs: Math.max(0, now - job.createdAtMs),
      timeoutMs: job.timeoutMs,
      expiresInMs: Math.max(0, job.createdAtMs + job.timeoutMs - now),
      leaseId: job.leaseId,
      clientId: job.clientId,
      leasedAt: job.leasedAt,
      leaseAgeMs: job.leasedAtMs ? Math.max(0, now - job.leasedAtMs) : null,
      attempts: job.attempts,
      completedAt: job.completedAt,
      durationMs: job.durationMs,
      diagnostics: job.diagnostics,
      resultSummary: job.resultSummary
    };
  }

  // Single entry point for a completion turn: enqueue the prompt, forward live progress frames to
  // onProgress (when given), await the authoritative result, and return it as one defined run
  // envelope. Owns the progress subscription end to end — subscribes on enqueue and unsubscribes
  // once the job settles — so callers never touch subscribeProgress and no late frame can land
  // after the turn is done.
  async run(prompt, options = {}) {
    const startedAt = new Date().toISOString();
    let unsubscribe = null;

    try {
      const result = await this.enqueue({
        prompt,
        images: options.images || [],
        target: options.target || process.env.O1_CODE_TARGET || "coding-agent",
        url: options.url || process.env.O1_CODE_TARGET_URL || null,
        // The agent is resolved per-model in openaiCompat (resolveModelProfile) and passed as
        // options.model; the literal default only covers callers that omit it.
        model: options.model || "OgilvyOneCoder",
        verboseRecorder: process.env.O1_CODE_VERBOSE_RECORDER === "1"
      }, {
        timeoutMs: options.timeoutMs,
        onEnqueued: typeof options.onProgress === "function"
          ? (id) => { unsubscribe = this.subscribeProgress(id, options.onProgress); }
          : undefined
      });

      return buildRunEnvelope(prompt, options, result, startedAt);
    } finally {
      if (unsubscribe) {
        unsubscribe();
      }
    }
  }
}

function sanitizeClientStatus(status) {
  if (!status || typeof status !== "object") {
    return null;
  }

  return {
    state: status.state || null,
    assistantOk: status.assistantOk ?? null,
    bridgeOk: status.bridgeOk ?? null,
    tabId: status.tabId ?? null,
    frameId: status.frameId ?? null,
    lastPollAt: status.lastPollAt || null,
    lastJobAt: status.lastJobAt || null,
    lastSuccessAt: status.lastSuccessAt || null,
    responseSource: status.responseSource || null,
    lastError: status.lastError || null
  };
}

function sanitizeClientCounters(counters) {
  if (!counters || typeof counters !== "object") {
    return null;
  }

  return {
    polls: Number(counters.polls) || 0,
    jobs: Number(counters.jobs) || 0,
    skippedPolls: Number(counters.skippedPolls) || 0,
    frameScans: Number(counters.frameScans) || 0,
    injections: Number(counters.injections) || 0,
    recorderArmFailures: Number(counters.recorderArmFailures) || 0,
    resultBytes: Number(counters.resultBytes) || 0,
    avgPollMs: Number(counters.avgPollMs) || 0,
    avgJobMs: Number(counters.avgJobMs) || 0
  };
}
function compactDiagnostics(diagnostics) {
  if (!diagnostics || typeof diagnostics !== "object") {
    return null;
  }

  return {
    phase: diagnostics.phase || null,
    thinking: diagnostics.thinking ?? null,
    thinkingText: diagnostics.thinkingText || "",
    responseSource: diagnostics.responseSource || null,
    finalTextLength: diagnostics.finalTextLength ?? null,
    staleTab: diagnostics.staleTab ?? null,
    expectedAgent: diagnostics.expectedAgent || null,
    selectedAgent: diagnostics.selectedAgent || null,
    wireModel: diagnostics.wireModel || null,
    agentSelection: diagnostics.agentSelection ? {
      ok: diagnostics.agentSelection.ok ?? null,
      pillFound: diagnostics.agentSelection.pillFound ?? null,
      label: diagnostics.agentSelection.label || null,
      beforeLabel: diagnostics.agentSelection.beforeLabel || null,
      afterLabel: diagnostics.agentSelection.afterLabel || null,
      pickerOpened: diagnostics.agentSelection.pickerOpened ?? null,
      searchFound: diagnostics.agentSelection.searchFound ?? null,
      optionFound: diagnostics.agentSelection.optionFound ?? null,
      groupExpanded: diagnostics.agentSelection.groupExpanded ?? null,
      groupExpansionMethod: diagnostics.agentSelection.groupExpansionMethod || null,
      groupCount: diagnostics.agentSelection.groupCount ?? null,
      groupToggleOpened: diagnostics.agentSelection.groupToggleOpened ?? null,
      optionText: diagnostics.agentSelection.optionText || null,
      activationMethod: diagnostics.agentSelection.activationMethod || null,
      failureReason: diagnostics.agentSelection.failureReason || null,
      pickerText: diagnostics.agentSelection.pickerText || null,
      rosterReadiness: diagnostics.agentSelection.rosterReadiness ?? null
    } : null,
    target: {      tabId: diagnostics.tabId ?? null,
      frameId: diagnostics.frameId ?? null,
      tabUrl: diagnostics.tabUrl || null,
      frameUrl: diagnostics.frameUrl || null,
      targetKind: diagnostics.targetKind || null
    },
    domMessage: diagnostics.domMessage ? {
      textLength: String(diagnostics.domMessage.text || "").length,
      key: diagnostics.domMessage.key || null,
      tag: diagnostics.domMessage.tag || null
    } : null,
    recorder: diagnostics.recorder ? {
      ready: diagnostics.recorder.ready ?? null,
      reset: diagnostics.recorder.reset ?? null,
      requestCount: diagnostics.recorder.requestCount ?? null,
      activeRecordCount: diagnostics.recorder.activeRecordCount ?? null,
      incompleteRecordCount: diagnostics.recorder.incompleteRecordCount ?? null
    } : null,
    assistantUi: diagnostics.assistantUi ? {
      error: diagnostics.assistantUi.error || null,
      warning: diagnostics.assistantUi.warning || null
    } : null
  };
}

function summarizeResult(result) {
  if (!result || typeof result !== "object") {
    return null;
  }

  const finalText = result.finalText || result.response?.finalText || "";
  const toolCallParts = result.toolCallParts || result.response?.toolCallParts || {};
  const response = result.response || {};

  return {
    ok: result.ok !== false,
    error: result.error || response.error || null,
    statusCode: result.statusCode || null,
    responseSource: result.responseSource || null,
    responseStatus: result.request?.responseStatus || null,
    finishReason: result.request?.finishReason || response.finishReason || null,
    finalTextChars: String(finalText || "").length,
    toolCallCount: Object.values(toolCallParts || {}).filter((part) => part?.name).length,
    recorder: result.recorder || null,
    counts: responseCounts(result.response)
  };
}

function responseCounts(response) {
  if (!response || typeof response !== "object") {
    return null;
  }

  const counts = response.counts && typeof response.counts === "object" ? response.counts : {};

  return {
    chunks: Number(counts.chunks) || (Array.isArray(response.chunks) ? response.chunks.length : 0),
    events: Number(counts.events) || (Array.isArray(response.events) ? response.events.length : 0),
    unparsed: Number(counts.unparsed) || (Array.isArray(response.unparsed) ? response.unparsed.length : 0),
    eventCount: Number(response.eventCount ?? counts.eventCount) || null,
    byteCount: Number(response.byteCount ?? counts.byteCount) || null
  };
}
export const extensionBridge = new ExtensionBridge();

// Shape the raw extension `complete()` result into the one run envelope callers consume. The
// single place the ambiguous finalText/toolCallParts location (top-level vs nested under
// response) is reconciled, so handleChatCompletions reads a defined shape instead of dual-reading.
function buildRunEnvelope(prompt, options, result, startedAt) {
  return {
    ok: true,
    transport: "extension",
    prompt,
    images: (options.images || []).map((image) => ({
      id: image.id,
      name: image.name,
      mimeType: image.mimeType,
      sizeBytes: image.sizeBytes
    })),
    timeoutMs: Number(options.timeoutMs || DEFAULT_EXTENSION_TIMEOUT_MS),
    timedOut: false,
    submitted: result.submitted || null,
    chatContext: result.chatContext || null,
    freshChat: result.freshChat || null,
    request: result.request || {
      endpoint: "extension://o1-code-bridge",
      method: "EXTENSION",
      responseStatus: result.ok === false ? 500 : 200,
      error: result.error || null
    },
    response: {
      finalText: result.finalText || result.response?.finalText || "",
      toolCallParts: result.toolCallParts || result.response?.toolCallParts || {},
      source: result.responseSource || null,
      chunks: result.response?.chunks || [],
      events: result.response?.events || [],
      unparsed: result.response?.unparsed || []
    },
    extension: {
      jobId: result.id || result.jobId,
      tabId: result.tabId,
      frameId: result.frameId,
      responseSource: result.responseSource || null,
      recorder: result.recorder || null,
      counts: responseCounts(result.response),
      startedAt,
      finishedAt: new Date().toISOString()
    },
    allRequests: []
  };
}
