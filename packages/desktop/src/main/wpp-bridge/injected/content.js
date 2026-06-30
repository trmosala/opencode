(() => {
const ASSISTANT_HOSTS = new Set([
  "open-web-assistant-cs.wpp.ai",
  "open-web-deeplink-cs.wpp.ai"
]);
const CONTENT_SCRIPT_VERSION = "2026-06-27-electron-transport-1";
const INSTALL_KEY = `__o1CodeBridgeContentInstalled_${CONTENT_SCRIPT_VERSION}`;
const CONTENT_SOURCE = "o1-code-bridge-content";
const PAGE_SOURCE = "o1-code-bridge-page";
// Electron transport: jobs arrive from the main process as CONTROLLER_SOURCE frames; results
// and progress leave as BRIDGE_OUT_SOURCE frames. A main-world relay (installed via the same
// CDP addScriptToEvaluateOnNewDocument path as pageRecorder's probe) bridges these postMessage
// frames to/from a CDP binding. Replaces the MV3 chrome.runtime messaging + progress Port.
const CONTROLLER_SOURCE = "o1-code-bridge-controller";
const BRIDGE_OUT_SOURCE = "o1-code-bridge-out";
const MAX_RECORDER_RUNS = 5;
const SETUP_TIMEOUT_MS = 120000;
// A WPP "Unable to complete the request." toast can flash transiently right after submit on
// image turns while the UI is still generating (thinking). Only treat such a fatal toast as
// terminal once it has persisted this long with no generation in progress — otherwise the
// bridge bails ~200ms after submit and reports failure for a turn that actually succeeds.
const FATAL_UI_ERROR_DEBOUNCE_MS = 6000;
// Retry handling for transient WPP assistant UI errors ("Unable to complete the request.").
// On a fresh, content-less fatal toast we start a fresh thread and re-submit, up to
// MAX_ASSISTANT_UI_RETRIES times, ASSISTANT_UI_RETRY_BACKOFF_MS apart, bounded by the job's
// remaining time budget. If every attempt still fails we surface ASSISTANT_UNAVAILABLE_MESSAGE
// to OpenCode so the operator sees a clear, actionable message rather than a raw 502.
const MAX_ASSISTANT_UI_RETRIES = 3;
const ASSISTANT_UI_RETRY_BACKOFF_MS = 10000;
const ASSISTANT_UNAVAILABLE_MESSAGE = "Possible Rate Limit/System error, please try again in a few minutes";
const MESSAGE_BUBBLE_SELECTOR = [
  "[data-message-id]",
  "[data-message-author-role]",
  "[data-testid*='message']",
  "[class*='message-bubble']",
  "[class*='chat-message']",
  "[role='listitem']"
].join(",");
// Conversation transcript container — a sibling of the composer, holding the message list. Used to
// scope emptiness checks away from the `.chat-input` wrapper. Heuristic; widen if WPP markup shifts.
const MESSAGE_CONTAINER_SELECTOR = [
  "[class*='messages-container']",
  "[class*='chat-messages']",
  "[data-testid='conversation-layout']"
].join(",");
const networkRecords = new Map();
const progressDispatchers = new Map();
const recorderStatus = {
  ready: false,
  resets: new Set(),
  requests: new Map(),
  // Verbose-only diagnostic: every request observed in this frame per run, unfiltered (see
  // emitObservedRequest in pageRecorder.js). Lets a failing image turn show whether the model
  // request fired as a non-recordable shape vs never fired here. Empty unless O1_CODE_VERBOSE_RECORDER=1.
  observed: new Map(),
  runIds: []
};
const MAX_OBSERVED_PER_RUN = 100;

if (!globalThis[INSTALL_KEY]) {
  globalThis[INSTALL_KEY] = true;

  window.addEventListener("message", (event) => {
    const data = event.data;
    if (!data) {
      return;
    }

    if (data.source === PAGE_SOURCE) {
      if (event.source !== window) {
        return;
      }

      if (data.type === "O1_CODE_BRIDGE_NETWORK_RECORD") {
        const record = data.record;
        if (record?.runId && record?.id) {
          networkRecords.set(record.id, record);
          forwardProgressRecord(record);
        }
        return;
      }

      if (data.type === "O1_CODE_BRIDGE_RECORDER_STATUS") {
        updateRecorderStatus(data);
      }

      return;
    }

    if (data.source === CONTROLLER_SOURCE) {
      if (!ASSISTANT_HOSTS.has(location.hostname)) {
        return;
      }
      handleControllerMessage(data);
    }
  });
}

// Inbound job/inspect requests from the main process. Each carries a requestId the main side
// uses to match the BRIDGE_OUT_SOURCE reply (the postMessage equivalent of MV3's sendResponse).
function handleControllerMessage(message) {
  // Response to a page-initiated main-process action (e.g. trusted image paste). Matched by
  // requestId to the awaiting requestMainAction() promise.
  if (message.type === "O1_CODE_BRIDGE_MAIN_RESPONSE") {
    const waiter = pendingMainRequests.get(message.requestId);
    if (waiter) {
      pendingMainRequests.delete(message.requestId);
      if (message.error) waiter.reject(new Error(message.error));
      else waiter.resolve(message.result);
    }
    return;
  }

  if (message.type === "O1_CODE_BRIDGE_INSPECT_CHAT") {
    emitToController({
      type: "O1_CODE_BRIDGE_INSPECT_RESULT",
      requestId: message.requestId,
      result: inspectChatState()
    });
    return;
  }

  if (message.type !== "O1_CODE_BRIDGE_RUN_JOB") {
    return;
  }

  runJob(message.job)
    .then((result) => emitToController({
      type: "O1_CODE_BRIDGE_JOB_RESULT",
      requestId: message.requestId,
      result
    }))
    .catch((error) => emitToController({
      type: "O1_CODE_BRIDGE_JOB_RESULT",
      requestId: message.requestId,
      result: {
        ok: false,
        error: error.message,
        statusCode: error.statusCode,
        type: error.type,
        diagnostics: error.diagnostics || buildBridgeDiagnostics({
          phase: "message-handler-error",
          prompt: String(message.job?.payload?.prompt || "")
        })
      }
    }));
}

// Page-initiated requests to the main process (the inverse of handleControllerMessage's job flow).
// content.js can only do untrusted DOM work; a real image paste needs a TRUSTED event, which only
// the Electron main process can synthesize (clipboard.writeImage + webContents.paste). This RPC
// lets the page ask main to do that and await the outcome. Matched by requestId.
const pendingMainRequests = new Map();

function requestMainAction(action, payload, timeoutMs = 30000) {
  const requestId = `main-${Date.now()}-${Math.random().toString(16).slice(2)}`;
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      pendingMainRequests.delete(requestId);
      reject(new Error(`Timed out waiting for main action "${action}" after ${timeoutMs} ms.`));
    }, timeoutMs);
    pendingMainRequests.set(requestId, {
      resolve: (result) => { clearTimeout(timer); resolve(result); },
      reject: (error) => { clearTimeout(timer); reject(error); }
    });
    emitToController({ type: "O1_CODE_BRIDGE_MAIN_REQUEST", requestId, action, payload });
  });
}

function emitToController(payload) {
  window.postMessage({ source: BRIDGE_OUT_SOURCE, ...payload }, "*");
}

async function runJob(job) {
  try {
    return await runJobWithProgress(job, job?.id);
  } finally {
    closeProgressJob(job?.id);
  }
}

async function runJobWithProgress(job, jobId) {
  if (!ASSISTANT_HOSTS.has(location.hostname)) {
    throw new Error(`O1-Code bridge content script is in the wrong frame: ${location.href}`);
  }

  const prompt = String(job?.payload?.prompt || "");
  const verboseRecorder = job?.payload?.verboseRecorder === true;
  const expectedAgent = String(job?.payload?.model || "OgilvyOneCoder").trim();
  // Continue the pinned thread: the proxy sent only the delta turn and the tab already holds prior
  // context, so we must NOT click New Chat (that wipes it) nor reselect the agent (already set).
  const continueThread = job?.payload?.continueThread === true;

  if (!prompt.trim()) {
    throw new Error("Bridge job prompt is empty.");
  }

  const freshChat = continueThread ? await continueExistingChat() : await startFreshChat();
  const ignoredAssistantErrorText = inspectAssistantUi().error?.text || null;
  await dismissAssistantUiErrors();
  const capture = beginNetworkCapture({ verboseRecorder });
  registerProgressRun(capture.runId, jobId);
  await waitForRecorderReset(capture.runId, 1500);
  const jobTimeoutMs = Number(job.timeoutMs || SETUP_TIMEOUT_MS);
  const textarea = await waitForTextarea(SETUP_TIMEOUT_MS);
  const attachments = await attachImages(job?.payload?.images || [], textarea, SETUP_TIMEOUT_MS);

  // Guarantee the OgilvyOneCoder agent is selected. "New Chat" can reset the
  // picker to the default base model, so this must run after startFreshChat and before
  // submitting. OgilvyOneCoder is an Agent (not a base model) under the "Agents and Models"
  // picker — selection state is read from the composer pill label, which is the authoritative
  // signal (the network model field reports the agent's underlying base model).
  const agentSelection = continueThread
    ? { ok: true, label: expectedAgent, skipped: true }
    : await ensureAgentSelected(expectedAgent, textarea);

  // Trust agentSelection.ok as authoritative: ensureAgentSelected already confirms selection
  // internally (old UI: pill label matches; new UI: the name-matched option was clicked and the
  // picker dismissed). Re-checking the pill label here would reject the new UI, whose model button is
  // icon-only ("(unknown)") even when the correct agent is selected.
  if (!continueThread && !agentSelection.ok) {
    const selectedLabel = agentSelection.label || agentSelection.afterLabel || agentSelection.beforeLabel || "(unknown)";
    // Diagnostic dump: surface what the agent scan actually saw so the next real failure is
    // self-describing instead of guessed-at (the picker lives in a cross-origin iframe we can't
    // inspect from outside). `options` is each visible option's text — it reveals whether the
    // matched node carries the trailing "Assistant" subtitle that trips matchesAgentName's
    // end-boundary check. ponytail: read-only fields already captured by finish()/captureRosterReadiness.
    const roster = agentSelection.rosterReadiness || {};
    const selectionFailure = agentSelection.failureReason
      ? ` The extension tried to switch agents but failed at: ${agentSelection.failureReason}.`
        + ` [diag searchFound=${agentSelection.searchFound} groupCount=${agentSelection.groupCount}`
        + ` groupExpanded=${agentSelection.groupExpanded} toggleOpened=${agentSelection.groupToggleOpened}`
        + ` optionFound=${agentSelection.optionFound}`
        + ` options=${JSON.stringify(roster.optionSample || [])}`
        + ` picker="${(roster.subtreeSignature || agentSelection.pickerText || "").slice(0, 200)}"]`
      : "";
    const error = new Error(
      `Wrong model/agent selected: composer shows "${selectedLabel}" but `
      + `"${expectedAgent}" is required. Select the ${expectedAgent} agent in the Creative Studio `
      + `chat (it carries the OpenCode harness system prompt) and retry.${selectionFailure}`
    );
    // ponytail: 400 so the client treats this as non-retryable. Auto-switch already retries 12x
    // internally and fresh mode resets the picker each attempt, so an outer retry never self-heals
    // — it just backs off forever. Flip to a retryable class if the picker is later made transient.
    error.statusCode = 400;
    error.type = "o1_code_wrong_agent";
    error.diagnostics = buildBridgeDiagnostics({
      phase: "wrong-agent",
      runId: capture.runId,
      textarea,
      prompt,
      ignoredAssistantErrorText,
      expectedAgent,
      selectedAgent: selectedLabel,
      agentSelection
    });
    throw error;
  }
  // Gate submission on an actual "upload ready" signal rather than a fixed sleep: submit as soon
  // as the upload registers (thumbnail decoded / progress cleared), with a timeout fallback.
  if (attachments.attached > 0) {
    // ponytail: readiness ceiling is a DOM-poll heuristic. If the composer DOM stops exposing
    // upload state (thumbnail decode / progress affordance), switch to the pageRecorder network
    // signal — it already wraps fetch + XHR in the MAIN world and can observe the upload request.
    await waitForAttachmentReady(textarea, 15000);
  }
  const beforeAssistantMessage = latestAssistantMessageSnapshot(textarea);
  const beforeSubmitDiagnostics = buildBridgeDiagnostics({
    phase: "before-submit",
    runId: capture.runId,
    textarea,
    prompt,
    ignoredAssistantErrorText,
    domMessage: beforeAssistantMessage
  });
  const submitted = await submitPrompt(textarea, prompt, SETUP_TIMEOUT_MS);
  const afterSubmitDiagnostics = buildBridgeDiagnostics({
    phase: "after-submit",
    runId: capture.runId,
    textarea,
    prompt,
    submitted,
    ignoredAssistantErrorText
  });
  let networkResponse = await waitForNetworkResponse({
    runId: capture.runId,
    timeoutMs: jobTimeoutMs,
    textarea,
    prompt,
    ignoredAssistantErrorText,
    beforeAssistantMessage
  });

  if (!networkResponse && textareaStillContainsPrompt(textarea, prompt)) {
    submitWithEnter(textarea);
    submitted.retry = {
      reason: "no-network-request-and-prompt-still-in-composer",
      method: "enter"
    };
    networkResponse = await waitForNetworkResponse({
      runId: capture.runId,
      timeoutMs: jobTimeoutMs,
      textarea,
      prompt,
      ignoredAssistantErrorText,
      beforeAssistantMessage
    });
  }

  // safe-inert: until the retry loop lands, treat a fatal-UI-error signal as "no response"
  // so it follows the existing loud-fail path (502 + toast text via networkCaptureError)
  // instead of returning an empty ok:true. Dormant in normal turns — only a fresh,
  // content-less "Unable to complete the request" toast produces this signal. The
  // { fatalUiError } scaffolding + ASSISTANT_* constants are intentionally left in place
  // as the foundation for the deferred retry loop. See ASSISTANT_UI_RETRY_HANDOFF.md.
  if (networkResponse?.fatalUiError) {
    networkResponse = null;
  }

  if (!networkResponse) {
    const error = new Error(networkCaptureError(capture.runId, { ignoredAssistantErrorText }));
    error.diagnostics = buildBridgeDiagnostics({
      phase: "no-network-response",
      runId: capture.runId,
      textarea,
      prompt,
      submitted,
      ignoredAssistantErrorText
    });
    error.diagnostics.beforeSubmit = beforeSubmitDiagnostics;
    error.diagnostics.afterSubmit = afterSubmitDiagnostics;
    throw error;
  }

  const responseSource = networkResponse.responseSource || "network";
  const finalText = networkResponse.finalText || "";
  const toolCallParts = networkResponse.toolCallParts || {};
  const wireModel = networkResponse.model || null;
  const assistantUi = inspectAssistantUi();

  return {
    ok: true,
    finalText,
    toolCallParts,
    responseSource,
    expectedAgent,
    selectedAgent: agentSelection.label || null,
    model: wireModel,
    recorder: {
      ready: recorderStatus.ready,
      reset: recorderStatus.resets.has(capture.runId),
      requestCount: recorderStatus.requests.get(capture.runId)?.length || 0
    },
    freshChat,
    submitted: {
      ...submitted,
      attachments
    },
    diagnostics: {
      beforeSubmit: beforeSubmitDiagnostics,
      afterSubmit: afterSubmitDiagnostics,
      completed: buildBridgeDiagnostics({
        phase: responseSource === "dom" ? "dom-fallback" : "completed",
        runId: capture.runId,
        textarea,
        prompt,
        submitted,
        ignoredAssistantErrorText,
        responseSource,
        finalTextLength: finalText.length,
        expectedAgent,
        selectedAgent: agentSelection.label,
        wireModel,
        domMessage: networkResponse.dom || latestAssistantMessageSnapshot(textarea)
      })
    },
    chatContext: {
      href: location.href,
      title: document.title,
      origin: location.origin,
      assistantUi,
      textareas: Array.from(document.querySelectorAll("textarea")).map((el, index) => ({
        index: index + 1,
        value: el.value || "",
        placeholder: el.getAttribute("placeholder") || "",
        disabled: el.disabled,
        readOnly: el.readOnly,
        visible: isVisible(el)
      }))
    },
    request: {
      endpoint: networkResponse.url,
      method: responseSource === "dom" ? "EXTENSION_DOM" : "EXTENSION_NETWORK",
      responseStatus: networkResponse.responseStatus,
      responseHeaders: networkResponse.responseHeaders || null,
      finishReason: networkResponse.finishReason || null,
      error: networkResponse.error || null
    },
    response: {
      finalText,
      toolCallParts,
      finishReason: networkResponse.finishReason || null,
      responseStatus: networkResponse.responseStatus || null,
      // WPP's real (cumulative) token count, scraped from the conversation pill, or null when the
      // pill is absent/unparseable. The proxy maps cumulativeTokens onto prompt_tokens and falls
      // back to the chars/token heuristic when this is null. See scrapeTokenPill for the contract.
      usage: scrapeTokenPill(),
      eventCount: Number(networkResponse.eventCount) || 0,
      byteCount: Number(networkResponse.byteCount) || 0,
      counts: networkResponse.counts || {
        chunks: Number(networkResponse.chunkCount) || (Array.isArray(networkResponse.chunks) ? networkResponse.chunks.length : 0),
        events: Number(networkResponse.eventCount) || (Array.isArray(networkResponse.events) ? networkResponse.events.length : 0),
        unparsed: Number(networkResponse.unparsedCount) || (Array.isArray(networkResponse.unparsed) ? networkResponse.unparsed.length : 0),
        eventCount: Number(networkResponse.eventCount) || 0,
        byteCount: Number(networkResponse.byteCount) || 0
      },
      ...(verboseRecorder ? {
        chunks: networkResponse.chunks || [],
        events: networkResponse.events || [],
        unparsed: networkResponse.unparsed || []
      } : {})
    }
  };
}

function registerProgressRun(runId, jobId) {
  if (!runId || !jobId) {
    return null;
  }

  const state = { jobId, lastSeq: 0 };
  progressDispatchers.set(runId, state);
  return state;
}

function closeProgressJob(jobId) {
  if (!jobId) {
    return;
  }

  for (const [runId, state] of progressDispatchers.entries()) {
    if (state.jobId === jobId) {
      progressDispatchers.delete(runId);
    }
  }
}

function forwardProgressRecord(record) {
  const state = progressDispatchers.get(record?.runId);
  if (!state) {
    return;
  }

  const frame = nextProgressFrame(record, state.lastSeq);
  if (!frame) {
    return;
  }

  state.lastSeq = frame.seq;
  // Progress is best-effort; the authoritative final result still travels through the
  // BRIDGE_OUT_SOURCE job-result frame regardless of whether progress frames are consumed.
  emitToController({ type: "O1_CODE_BRIDGE_JOB_PROGRESS", jobId: state.jobId, frame });
}

function nextProgressFrame(record, lastSeq = 0) {
  const finalText = typeof record?.finalText === "string" ? record.finalText : "";
  const seq = Number(record?.eventCount ?? record?.counts?.eventCount ?? 0);

  if (!finalText || !Number.isFinite(seq) || seq <= Number(lastSeq || 0)) {
    return null;
  }

  return { seq, finalText };
}
function updateRecorderStatus(data) {
  if (data.status === "ready") {
    recorderStatus.ready = true;
    return;
  }

  if (data.status === "reset" && data.runId) {
    recorderStatus.ready = true;
    rememberRecorderRun(data.runId);
    recorderStatus.resets.add(data.runId);
    return;
  }

  if (data.status === "request" && data.runId) {
    recorderStatus.ready = true;
    rememberRecorderRun(data.runId);
    const requests = recorderStatus.requests.get(data.runId) || [];
    requests.push({
      url: data.url || "",
      method: data.method || "GET"
    });
    recorderStatus.requests.set(data.runId, requests);
  }

  if (data.status === "observed" && data.runId) {
    recorderStatus.ready = true;
    rememberRecorderRun(data.runId);
    const observed = recorderStatus.observed.get(data.runId) || [];
    observed.push({
      url: data.url || "",
      method: data.method || "GET",
      httpStatus: data.httpStatus ?? null
    });
    if (observed.length > MAX_OBSERVED_PER_RUN) {
      observed.splice(0, observed.length - MAX_OBSERVED_PER_RUN);
    }
    recorderStatus.observed.set(data.runId, observed);
  }
}

function rememberRecorderRun(runId) {
  recorderStatus.runIds = recorderStatus.runIds.filter((id) => id !== runId);
  recorderStatus.runIds.push(runId);

  while (recorderStatus.runIds.length > MAX_RECORDER_RUNS) {
    const staleRunId = recorderStatus.runIds.shift();
    recorderStatus.resets.delete(staleRunId);
    recorderStatus.requests.delete(staleRunId);
    recorderStatus.observed.delete(staleRunId);
  }
}

function beginNetworkCapture({ verboseRecorder = false } = {}) {
  const runId = crypto.randomUUID();

  for (const [id, record] of networkRecords.entries()) {
    if (record?.done || record?.runId !== runId) {
      networkRecords.delete(id);
    }
  }

  window.postMessage({
    source: CONTENT_SOURCE,
    type: "O1_CODE_BRIDGE_RECORDER_RESET",
    runId,
    verboseRecorder
  }, "*");

  return { runId };
}

async function waitForRecorderReset(runId, timeoutMs) {
  const startedAt = Date.now();

  while (Date.now() - startedAt < timeoutMs) {
    if (recorderStatus.resets.has(runId)) {
      return;
    }

    await wait(50);
  }

  throw new Error("Network recorder did not arm before prompt submission. Reload the extension and refresh the O1-Code assistant page.");
}

// Continue the pinned thread instead of starting a new one. The proxy only sends this mode when it
// believes the tab still holds prior context, but a tab can be reaped/crashed and respawned empty
// between turns. If the transcript is empty we cannot continue (the delta has no context to build
// on), so fail with a typed error: the proxy drops the watermark and the next turn replays fresh.
async function continueExistingChat() {
  if (isTranscriptEmpty()) {
    const error = new Error(
      "Thread continuity lost: the pinned WPP tab is empty, so the delta turn has no prior context. "
      + "A full resync is required."
    );
    error.statusCode = 409;
    error.type = "o1_code_thread_desync";
    throw error;
  }

  return { ok: true, clicked: false, reason: "continue-thread" };
}

async function startFreshChat() {
  const controls = Array.from(document.querySelectorAll("button, [role='button'], a"));
  const control = controls.find((el) => /new\s+(chat|conversation)/i.test(labelFor(el)));

  if (control) {
    control.click();
    await wait(1500);
    return { ok: true, clicked: true };
  }

  // Fresh mode replays the full conversation into a NEW chat. If we cannot start one, we
  // must not submit that full history into a thread that already holds history — that would
  // duplicate context. Tolerate a missing control only when the thread is already empty
  // (e.g. the very first turn); otherwise fail loudly so the failure is visible rather than
  // silently corrupting the conversation.
  if (isTranscriptEmpty()) {
    return { ok: true, clicked: false, reason: "already-empty" };
  }

  throw new Error(
    "No New Chat control was found and the existing thread is not empty. Open a fresh "
    + "O1-Code chat."
  );
}

// Best-effort emptiness check. Scope to the transcript, NOT chatRootFor(textarea): in the WPP
// assistant DOM that resolves to the `.chat-input` composer wrapper, which is a SIBLING of the
// message list, so it never contains bubbles and would report every populated thread as empty
// (spurious o1_code_thread_desync on every continue turn). Search an explicit messages container
// when present, else fall back to the whole document. Returning true only when NO message-like
// node is found is the conservative side for the "already-empty" tolerance above.
function isTranscriptEmpty() {
  const root = transcriptRootFor();
  const bubbles = Array.from(root.querySelectorAll(MESSAGE_BUBBLE_SELECTOR)).filter(isVisible);

  return bubbles.length === 0;
}

function transcriptRootFor() {
  return document.querySelector(MESSAGE_CONTAINER_SELECTOR) || document;
}

// Baseline of composer thumbnails captured pre-attach so waitForAttachmentReady can tell a
// freshly-rendered upload thumbnail apart from any image already present in the composer.
let attachmentBaselineImages = null;

async function attachImages(images, textarea, timeoutMs) {
  if (!Array.isArray(images) || images.length === 0) {
    return { requested: 0, attached: 0 };
  }

  // Snapshot composer thumbnails before attaching so waitForAttachmentReady can distinguish a
  // freshly-decoded upload thumbnail from any image already present in the composer/transcript.
  attachmentBaselineImages = composerImageFingerprints(textarea);
  const baselineChips = composerAttachmentChipCount(textarea);

  // PRIMARY: a TRUSTED paste, driven by the Electron main process. WPP routes a real (isTrusted)
  // paste through its image/vision pipeline — the model receives actual pixels. A programmatic
  // input[type=file] upload (the fallback below) is treated as a generic *file*: it uploads to
  // WPP's bucket but the agent only gets a file reference (no vision), which is the bug this fixes.
  // Only the main process can synthesize a trusted paste (clipboard.writeImage + webContents.paste),
  // so we focus the composer and hand off via requestMainAction. See controller-injection.ts.
  let pasteResult = null;
  try {
    textarea.focus();
    pasteResult = await requestMainAction("pasteImages", {
      images: images.map((image) => ({ name: image.name, mimeType: image.mimeType, data: image.data }))
    }, Math.max(20000, Math.min(Number(timeoutMs) || 60000, 60000)));
  } catch (error) {
    pasteResult = { ok: false, error: error.message };
  }

  const pastedOk = pasteResult && Array.isArray(pasteResult.pasted)
    ? pasteResult.pasted.filter((entry) => entry && entry.ok).length
    : 0;

  if (pastedOk > 0) {
    // Wait until the pasted upload chips register (count rose past baseline) so we don't submit
    // before WPP has taken the attachment. waitForAttachmentReady (chip-aware) then gates submit.
    await waitForAttachmentChips(textarea, baselineChips + pastedOk, Math.min(Number(timeoutMs) || 15000, 15000));
    return {
      requested: images.length,
      attached: pastedOk,
      method: "paste",
      names: images.map((image) => image.name)
    };
  }

  // FALLBACK: legacy file-input upload. Better than dropping the turn, but WPP treats it as a file
  // (no vision) — surfaced as method:"file-input" so the verdict/log shows when we degraded.
  const input = await waitForImageFileInput(textarea, Math.min(timeoutMs, 5000));

  if (!input) {
    throw new Error("Image input requested, but neither a trusted paste nor an O1-Code attachment file input was available."
      + (pasteResult?.error ? ` Paste failed: ${pasteResult.error}` : ""));
  }

  if (typeof DataTransfer === "undefined" || typeof File === "undefined") {
    throw new Error("Image input requested, but this browser context cannot construct upload files.");
  }

  const transfer = new DataTransfer();

  for (const image of images) {
    transfer.items.add(fileFromImageInput(image));
  }

  input.files = transfer.files;
  if (input.files.length < images.length) {
    throw new Error("Image input requested, but the O1-Code assistant file input did not accept all selected files.");
  }

  input.dispatchEvent(new Event("input", { bubbles: true }));
  input.dispatchEvent(new Event("change", { bubbles: true }));

  await wait(500);

  return {
    requested: images.length,
    attached: transfer.files.length,
    method: "file-input",
    pasteError: pasteResult?.error || null,
    names: images.map((image) => image.name)
  };
}

// Count the composer's file-attachment chips (WPP renders every attachment — including pasted
// images — as a named "file-upload-list-item", not an inline <img>). Used to detect that a paste
// registered (count rose past the pre-attach baseline).
function composerAttachmentChipCount(textarea) {
  const root = chatRootFor(textarea);
  return root.querySelectorAll("[class*='file-upload-list-item'], [class*='file-upload-name']").length;
}

async function waitForAttachmentChips(textarea, targetCount, timeoutMs) {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    if (composerAttachmentChipCount(textarea) >= targetCount && !hasUploadProgressIndicator(textarea)) {
      return true;
    }
    await wait(150);
  }
  return false;
}

// Matches upload-progress affordances by class/label/title text. Paired with the explicit
// [aria-busy]/[role=progressbar]/<progress> selector check in hasUploadProgressIndicator.
const UPLOAD_PROGRESS_LABEL = /progress|spinner|loading|uploading|busy/i;

// Fingerprint the images currently in the composer root (by resolved src). Captured pre-attach
// into attachmentBaselineImages so a freshly-rendered upload thumbnail is distinguishable from
// images that were already present.
function composerImageFingerprints(textarea) {
  const root = chatRootFor(textarea);

  return new Set(
    Array.from(root.querySelectorAll("img"))
      .map((img) => img.currentSrc || img.getAttribute("src") || "")
      .filter(Boolean)
  );
}

// True once a composer thumbnail that was NOT present pre-attach has finished decoding
// (complete && naturalWidth>0) — i.e. the upload rendered, not just a placeholder chip.
function hasFreshDecodedThumbnail(textarea) {
  const root = chatRootFor(textarea);
  const baseline = attachmentBaselineImages || new Set();

  return Array.from(root.querySelectorAll("img")).some((img) => {
    const key = img.currentSrc || img.getAttribute("src") || "";
    if (!key || baseline.has(key)) {
      return false;
    }

    return img.complete && img.naturalWidth > 0;
  });
}

// True while any upload-progress affordance (spinner/progress bar/aria-busy/"uploading" text)
// is visible in the composer root. SVG className is an object, so read the class attribute.
function hasUploadProgressIndicator(textarea) {
  const root = chatRootFor(textarea);

  if (root.querySelector("[aria-busy='true'], [role='progressbar'], progress")) {
    return true;
  }

  return Array.from(root.querySelectorAll("[class], [aria-label], [title]")).some((el) => {
    if (!isVisible(el)) {
      return false;
    }

    const signature = [
      el.getAttribute("class"),
      el.getAttribute("aria-label"),
      el.getAttribute("title")
    ].filter(Boolean).join(" ");

    return UPLOAD_PROGRESS_LABEL.test(signature);
  });
}

// "Ready" = the attachment has registered AND no upload-progress affordance remains. WPP renders a
// pasted/uploaded image as a named file-upload chip (NOT an inline <img>), so accept EITHER a freshly
// decoded thumbnail OR a present file chip — keying only on the thumbnail made this always miss and
// burn the full timeout. Requiring no progress affordance still waits out an in-flight upload.
function isAttachmentReady(textarea) {
  const hasAttachment = hasFreshDecodedThumbnail(textarea) || composerAttachmentChipCount(textarea) > 0;
  return hasAttachment && !hasUploadProgressIndicator(textarea);
}

// Poll for the upload-ready signal, returning as soon as it holds across two consecutive ticks
// (so we don't race a transient first paint before the upload settles), or false on timeout.
// ponytail: DOM-poll heuristic — switch to the pageRecorder network signal (it wraps fetch+XHR
// in the MAIN world) if the composer DOM stops exposing upload state.
async function waitForAttachmentReady(textarea, timeoutMs = 15000) {
  const startedAt = Date.now();
  let stableTicks = 0;

  while (Date.now() - startedAt < timeoutMs) {
    if (isAttachmentReady(textarea)) {
      stableTicks += 1;
      if (stableTicks >= 2) {
        return true;
      }
    } else {
      stableTicks = 0;
    }

    await wait(150);
  }

  return false;
}

async function waitForImageFileInput(textarea, timeoutMs) {
  const startedAt = Date.now();
  let clickedAttach = false;

  while (Date.now() - startedAt < timeoutMs) {
    const input = findImageFileInput(textarea);
    if (input) {
      return input;
    }

    if (!clickedAttach) {
      const control = findAttachmentControl(textarea);
      if (control) {
        control.click();
        clickedAttach = true;
      }
    }

    await wait(150);
  }

  return null;
}

function findImageFileInput(textarea) {
  const root = chatRootFor(textarea);
  const roots = root === document ? [root] : [root, document];
  const inputs = roots.flatMap((candidateRoot) => Array.from(candidateRoot.querySelectorAll("input[type='file']")));

  return inputs.find((input) => {
    const accept = String(input.getAttribute("accept") || "").toLowerCase();
    return !accept || accept.includes("image") || accept.includes(".png") || accept.includes(".jpg") || accept.includes(".jpeg") || accept.includes(".webp");
  }) || null;
}

const ATTACH_BUTTON_LABEL = /\b(attach|attachment|upload|add|image|file)\b/i;

function findAttachmentControl(textarea) {
  const root = chatRootFor(textarea);
  const controls = Array.from(root.querySelectorAll("button, [role='button'], label"));

  return controls.find((control) =>
    isVisible(control)
    && !control.disabled
    && control.getAttribute("aria-disabled") !== "true"
    && ATTACH_BUTTON_LABEL.test(labelFor(control))
    && !STOP_BUTTON_LABEL.test(labelFor(control))
    && !/send|submit|microphone/i.test(labelFor(control))
  ) || null;
}

function fileFromImageInput(image) {
  const bytes = base64ToBytes(image.data || "");
  const blob = new Blob([bytes], { type: image.mimeType || "application/octet-stream" });

  return new File([blob], image.name || "o1-code-image", {
    type: image.mimeType || "application/octet-stream",
    lastModified: Date.now()
  });
}

function base64ToBytes(base64) {
  const binary = atob(String(base64 || ""));
  const bytes = new Uint8Array(binary.length);

  for (let index = 0; index < binary.length; index += 1) {
    bytes[index] = binary.charCodeAt(index);
  }

  return bytes;
}

async function waitForTextarea(timeoutMs) {
  const startedAt = Date.now();

  while (Date.now() - startedAt < timeoutMs) {
    const textarea = Array.from(document.querySelectorAll("textarea"))
      .find((el) => !el.disabled && !el.readOnly && isVisible(el) && /send|message/i.test(labelFor(el)));

    if (textarea) {
      return textarea;
    }

    await wait(250);
  }

  throw new Error("No enabled O1-Code chat textarea found.");
}

const STOP_BUTTON_LABEL = /\b(stop|cancel|abort|pause)\b/i;

async function submitPrompt(textarea, prompt, timeoutMs = 120000) {
  await waitForChatReady(textarea, submitWaitMs(timeoutMs));
  assertChatIdleForSubmit(textarea);

  textarea.focus();
  setNativeValue(textarea, prompt);
  textarea.dispatchEvent(new InputEvent("beforeinput", {
    bubbles: true,
    cancelable: true,
    inputType: "insertText",
    data: prompt
  }));
  textarea.dispatchEvent(new InputEvent("input", {
    bubbles: true,
    inputType: "insertText",
    data: prompt
  }));
  textarea.dispatchEvent(new Event("change", { bubbles: true }));

  const form = textarea.closest("form");
  const sendButton = await waitForSendButton(textarea, 3000);

  // ponytail: one local Stop button guard prevents duplicate bridge jobs from stomping an active turn.
  assertChatIdleForSubmit(textarea);

  if (sendButton) {
    sendButton.click();
  } else if (form?.requestSubmit) {
    form.requestSubmit();
  } else {
    submitWithEnter(textarea);
  }

  return {
    href: location.href,
    kind: "textarea",
    source: "extension-content-script",
    valueLength: textarea.value.length,
    sendButtonFound: Boolean(sendButton)
  };
}

function submitWaitMs(timeoutMs) {
  const budget = Number(timeoutMs ?? 120000);
  return Math.min(budget, Math.max(5000, Math.floor(budget / 2)));
}

function assertChatIdleForSubmit(textarea) {
  if (!findStopButton(textarea)) {
    return;
  }

  const error = new Error("O1-Code chat is still generating a previous response.");
  error.statusCode = 409;
  error.type = "o1_code_chat_busy";
  throw error;
}

async function waitForSendButton(textarea, timeoutMs) {
  const startedAt = Date.now();

  while (Date.now() - startedAt < timeoutMs) {
    const sendButton = findSendButton(textarea);
    if (sendButton) {
      return sendButton;
    }

    await wait(100);
  }

  return null;
}

function findSendAffordance(textarea, { enabledOnly = true } = {}) {
  const root = chatRootFor(textarea);
  const buttons = Array.from(root.querySelectorAll("button, [role='button']"));
  let candidates = buttons.filter((button) => isVisible(button) && !STOP_BUTTON_LABEL.test(labelFor(button)));

  if (enabledOnly) {
    candidates = candidates.filter((button) => !button.disabled && button.getAttribute("aria-disabled") !== "true");
  }

  return candidates.find((button) => /send/i.test(labelFor(button)))
    || candidates.find((button) => button.querySelector("svg, img") && !/add|settings|attach|microphone/i.test(labelFor(button)))
    || null;
}

function findSendButton(textarea) {
  return findSendAffordance(textarea, { enabledOnly: true });
}

function findStopButton(textarea) {
  const root = chatRootFor(textarea);
  const buttons = Array.from(root.querySelectorAll("button, [role='button']"));

  return buttons.find((button) =>
    isVisible(button)
    && !button.disabled
    && button.getAttribute("aria-disabled") !== "true"
    && STOP_BUTTON_LABEL.test(labelFor(button))
  ) || null;
}

// Tokens that identify the model/agent pill in the composer toolbar. The pill shows the
// currently selected base model ("Gemini 3.5 Flash", "GPT-…", "Claude …") or agent
// ("OgilvyOneCoder"). Matched by visible text rather than generated class names.
const MODEL_PILL_TOKENS = /OgilvyOneCoder|Ogilvy\s*One|Gemini|GPT|Claude|Sonnet|Opus|Haiku|Flash|OpenAI|Anthropic|Google/i;
const MODEL_SEARCH_PLACEHOLDER = /search/i;
const INTERACTIVE_SELECTOR = "button, [role='button'], [role='option'], [role='menuitem'], [role='listitem'], [role='combobox'], [aria-expanded], a, [tabindex]";
const MODEL_PICKER_ROOT_SELECTOR = [
  "[role='dialog']",
  "[role='listbox']",
  "[role='menu']",
  "[role='tree']",
  "[aria-modal='true']",
  "[data-testid*='model' i]",
  "[data-testid*='agent' i]",
  "[class*='popover' i]",
  "[class*='dropdown' i]",
  "[class*='menu' i]"
].join(",");
const MODEL_OPTION_SELECTOR = [
  "button",
  "[role='button']",
  "[role='option']",
  "[role='menuitem']",
  "[role='listitem']",
  "li",
  "p",
  "span",
  "div"
].join(",");

function escapeRegExp(value) {
  return String(value || "").replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function elementText(el) {
  return String(el?.innerText || el?.textContent || "").trim();
}

function normalizeAgentText(value) {
  return String(value || "").replace(/\s+/g, "").toLowerCase();
}

function isAgentNameChar(value) {
  return /[a-z0-9_]/i.test(value || "");
}

function nextNonWhitespace(value, offset) {
  for (let index = offset; index < value.length; index += 1) {
    if (!/\s/.test(value[index])) {
      return value[index];
    }
  }

  return "";
}

function previousNonWhitespace(value, offset) {
  for (let index = offset - 1; index >= 0; index -= 1) {
    if (!/\s/.test(value[index])) {
      return value[index];
    }
  }

  return "";
}

function matchesAgentName(value, expectedAgent) {
  const source = String(value || "");
  const target = normalizeAgentText(expectedAgent);

  if (!source || !target) {
    return false;
  }

  for (let start = 0; start < source.length; start += 1) {
    const previous = previousNonWhitespace(source, start);
    if (previous && isAgentNameChar(previous)) {
      continue;
    }

    let sourceIndex = start;
    let targetIndex = 0;

    while (sourceIndex < source.length && targetIndex < target.length) {
      const targetChar = target[targetIndex];

      if (targetChar === "_") {
        if (!/[\s_-]/.test(source[sourceIndex])) {
          break;
        }
        while (sourceIndex < source.length && /[\s_-]/.test(source[sourceIndex])) {
          sourceIndex += 1;
        }
        targetIndex += 1;
        continue;
      }

      if (/\s/.test(source[sourceIndex])) {
        sourceIndex += 1;
        continue;
      }

      if (source[sourceIndex].toLowerCase() !== targetChar) {
        break;
      }

      sourceIndex += 1;
      targetIndex += 1;
    }

    if (targetIndex !== target.length) {
      continue;
    }

    const trailing = source.slice(sourceIndex);
    if (target === "ogilvyonecoder" && /^[_\-\s]*builder\b/i.test(trailing)) {
      continue;
    }

    const next = nextNonWhitespace(source, sourceIndex);
    if (!next || !isAgentNameChar(next)) {
      return true;
    }
  }

  return false;
}
// The WPP picker is rendered inside web components, so plain querySelectorAll on the frame
// document misses it. Walk open shadow roots as well. Scoped to the current (assistant)
// frame's document — the content script already runs inside that frame.
function deepQueryAll(selector, root = document) {
  const out = [];
  const visit = (node) => {
    if (!node) {
      return;
    }

    let matches = [];
    try {
      if (node.matches?.(selector)) {
        matches.push(node);
      }
      if (node.querySelectorAll) {
        matches.push(...Array.from(node.querySelectorAll(selector)));
      }
    } catch {
      matches = [];
    }
    out.push(...matches);

    let hosts = [];
    try {
      hosts = node.querySelectorAll ? node.querySelectorAll("*") : [];
    } catch {
      hosts = [];
    }
    for (const el of hosts) {
      if (el.shadowRoot) {
        visit(el.shadowRoot);
      }
    }
  };

  visit(root);
  return out;
}

function agentLabelMatches(label, expectedAgent) {
  const a = normalizeAgentText(label);
  const b = normalizeAgentText(expectedAgent);
  return Boolean(a && b && (a === b || matchesAgentName(label, expectedAgent)));
}

function composedParent(el) {
  if (!el) {
    return null;
  }

  if (el.assignedSlot) {
    return el.assignedSlot;
  }

  if (el.parentElement) {
    return el.parentElement;
  }

  const root = el.getRootNode?.();
  if (root?.host) {
    return root.host;
  }

  if (el.parentNode?.host) {
    return el.parentNode.host;
  }

  return el.parentNode || null;
}

function composedClosest(el, selector) {
  let current = el || null;

  while (current) {
    if (current.matches?.(selector)) {
      return current;
    }
    current = composedParent(current);
  }

  return null;
}

function clickableFor(el) {
  return composedClosest(el, INTERACTIVE_SELECTOR) || el;
}

function composerRootFor(textarea) {
  if (!textarea) {
    return null;
  }

  return textarea.closest?.("[data-testid*='composer' i], [class*='composer' i], form, .chat-input")
    || textarea.parentElement
    || chatRootFor(textarea);
}

// Find the composer model/agent pill: the smallest visible clickable element whose short
// label looks like a model/agent name. Smallest-text wins so we pick the pill itself, not a
// large container that happens to include the label.
function findModelPill(expectedAgent, textarea = null) {
  // New WPP UI: the trigger is a text-less icon button [data-testid="chat-model-button"]. Match it by
  // testid first — the old text-token match (model/agent name) can never fit an empty-text button,
  // which is what produced the "(unknown)" / model-pill-not-found agent-selection failures.
  const modelButton = deepQueryAll("[data-testid='chat-model-button']", document).find(isVisible);
  if (modelButton) return modelButton;

  const tokens = new RegExp(`${escapeRegExp(expectedAgent)}|${MODEL_PILL_TOKENS.source}`, "i");
  const roots = [composerRootFor(textarea), document].filter(Boolean);
  const seenRoots = new Set();
  const candidates = [];

  for (const root of roots) {
    if (seenRoots.has(root)) {
      continue;
    }
    seenRoots.add(root);

    for (const el of deepQueryAll("button, [role='button'], [role='combobox'], [aria-haspopup], p, span, div", root)) {
      const clickable = clickableFor(el);
      if (!isVisible(el) || (clickable && !isVisible(clickable))) {
        continue;
      }
      const text = elementText(clickable) || elementText(el);
      if (text.length > 0 && text.length < 80 && tokens.test(text)) {
        candidates.push({
          element: clickable || el,
          text,
          interactiveRank: (clickable || el).matches?.("button, [role='button'], [role='combobox'], [aria-haspopup]") ? 0 : 1
        });
      }
    }

    if (candidates.length > 0 && textarea) {
      break;
    }
  }

  candidates.sort((left, right) => left.interactiveRank - right.interactiveRank || left.text.length - right.text.length);

  return candidates[0]?.element || null;
}

function searchLabelFor(el) {
  return [
    el.getAttribute?.("placeholder"),
    el.getAttribute?.("aria-label"),
    el.getAttribute?.("title"),
    el.getAttribute?.("name"),
    el.id,
    elementText(el)
  ].filter(Boolean).join(" ");
}

function findAgentSearchInput(root = document) {
  return deepQueryAll("input, textarea", root).find((el) =>
    isVisible(el)
    && !el.disabled
    && el.getAttribute?.("aria-disabled") !== "true"
    && MODEL_SEARCH_PLACEHOLDER.test(searchLabelFor(el))
  ) || null;
}

function findModelPickerRoot(expectedAgent = "") {
  const target = normalizeAgentText(expectedAgent);
  const candidates = deepQueryAll(MODEL_PICKER_ROOT_SELECTOR)
    .filter(isVisible)
    .map((el) => {
      const text = elementText(el);
      const label = labelFor(el);
      const searchable = Boolean(findAgentSearchInput(el));
      const normalized = normalizeAgentText(`${text} ${label}`);
      return {
        element: el,
        text,
        searchable,
        hasTarget: Boolean(target && normalized.includes(target)),
        hasPickerTerms: /model|agent|gemini|gpt|claude|sonnet|flash|ogilvy/i.test(`${text} ${label}`)
      };
    })
    .filter((candidate) => candidate.searchable || candidate.hasTarget || candidate.hasPickerTerms)
    .sort((left, right) => {
      if (left.hasTarget !== right.hasTarget) return left.hasTarget ? -1 : 1;
      if (left.searchable !== right.searchable) return left.searchable ? -1 : 1;
      return left.text.length - right.text.length;
    });

  return candidates[0]?.element || null;
}

function optionScore(text, expectedAgent, interactive) {
  const normalized = normalizeAgentText(text);
  const target = normalizeAgentText(expectedAgent);
  let score = 10;

  if (normalized === target) {
    score = 0;
  } else if (agentLabelMatches(text, expectedAgent)) {
    score = 1;
  }

  if (interactive?.matches?.("button, [role='button'], [role='option'], [role='menuitem']")) {
    score -= 0.5;
  }

  return score;
}

function findAgentOption(rootOrExpectedAgent, maybeExpectedAgent = null) {
  const expectedAgent = maybeExpectedAgent || rootOrExpectedAgent;
  const root = maybeExpectedAgent ? rootOrExpectedAgent : (findModelPickerRoot(expectedAgent) || document);
  const candidates = deepQueryAll(MODEL_OPTION_SELECTOR, root || document)
    .filter((el) => {
      if (!isVisible(el)) {
        return false;
      }
      const text = elementText(el);
      return text.length > 0 && text.length < 300 && agentLabelMatches(text, expectedAgent);
    })
    .map((el) => {
      const interactive = clickableFor(el);
      const sourceText = elementText(el);
      const interactiveText = elementText(interactive);
      const text = agentLabelMatches(interactiveText, expectedAgent) ? interactiveText : sourceText;
      return {
        element: interactive || el,
        source: el,
        text,
        score: optionScore(text, expectedAgent, interactive || el)
      };
    })
    .sort((left, right) => left.score - right.score || left.text.length - right.text.length);

  return candidates[0] || null;
}

function findAgentOptionCard(expectedAgent) {
  return findAgentOption(expectedAgent)?.element || null;
}
// The visible group label ("Project Agents (1)") is often a slotted text node inside a WPP
// web component, while the actual expand control (the element carrying aria-expanded, or a
// chevron/icon button) is a separate node. Clicking the label does not always bubble to the
// component's toggle handler, so resolve the real toggle: prefer the nearest self-or-ancestor
// (across shadow boundaries) carrying aria-expanded, then any interactive ancestor, then a
// chevron/toggle control within the label's row. Fall back to the label itself.
function groupToggleFor(headerEl) {
  let node = headerEl;
  for (let depth = 0; depth < 6 && node; depth += 1) {
    if (node.getAttribute && node.getAttribute("aria-expanded") != null) {
      return node;
    }
    node = composedParent(node);
  }

  const interactive = clickableFor(headerEl);
  if (interactive && interactive !== headerEl) {
    return interactive;
  }

  const row = composedParent(headerEl) || headerEl;
  const chevron = deepQueryAll(
    "button, [role='button'], [aria-expanded], [class*='chevron' i], [class*='expand' i], [class*='toggle' i]",
    row
  )
    .map((el) => clickableFor(el) || el)
    .find((el) => el && el !== headerEl && isVisible(el));

  return chevron || headerEl;
}

// The picker groups the target under a collapsible section. WPP has shipped this section under
// several labels — "Project Agents (1)", "Project Models", "Base Models (4)" — so match on
// either "agent(s)" or "model(s)", not just "agents". A bare token alone is too weak (an option
// description could contain "model"), so a header only qualifies if it ALSO carries a real
// disclosure signal: a resolved aria-expanded toggle, a "(N)" count, or a "Project Agents/Models"
// title. This keeps us from clicking an ordinary option by mistake.
const GROUP_SECTION_RE = /\b(agents?|models?)\b/i;
const GROUP_TITLE_RE = /\bproject\s+(agents?|models?)\b/i;
const GROUP_COUNT_RE = /\(\s*\d+\s*\)/;

function looksLikeGroupHeader(text) {
  const trimmed = String(text || "").trim();
  return trimmed.length > 0 && trimmed.length <= 60 && GROUP_SECTION_RE.test(trimmed);
}

function findExpandableAgentGroups(root = document, expectedAgent = "") {
  const target = normalizeAgentText(expectedAgent);
  const seenToggle = new Set();
  const toggles = [];

  const pushToggle = (toggle) => {
    if (!toggle || seenToggle.has(toggle) || !isVisible(toggle)) {
      return;
    }
    if (String(toggle.getAttribute?.("aria-expanded") || "").toLowerCase() === "true") {
      // Already open — skip, the option (if any) is already revealed.
      return;
    }
    seenToggle.add(toggle);
    toggles.push(toggle);
  };

  // Signal 1: explicitly-collapsed disclosures. An element carrying aria-expanded="false" is an
  // unambiguous collapse control regardless of its label text, so expand any that does not itself
  // name the target option. This alone catches a "Project Models" group whose chevron carries the
  // attribute even when the visible label text does not match our patterns.
  for (const el of deepQueryAll("[aria-expanded='false']", root || document)) {
    if (!isVisible(el)) {
      continue;
    }
    if (target && normalizeAgentText(elementText(el)).includes(target)) {
      continue;
    }
    pushToggle(el);
  }

  // Signal 2: section headers found by text. The visible label and the real toggle are often
  // different nodes (slotted text vs. a sibling chevron), so resolve the toggle via groupToggleFor
  // and require a genuine disclosure signal before clicking.
  const headers = deepQueryAll("button, [role='button'], [aria-expanded], [tabindex], div, p, span, li", root || document)
    .filter((el) => {
      if (!el || !isVisible(el)) {
        return false;
      }
      const text = elementText(el);
      if (normalizeAgentText(text).includes(target)) {
        return false;
      }
      return looksLikeGroupHeader(text);
    })
    .sort((left, right) => elementText(left).length - elementText(right).length);

  for (const header of headers) {
    const text = elementText(header);
    const toggle = groupToggleFor(header);
    const hasDisclosure = toggle?.getAttribute?.("aria-expanded") != null;
    if (!hasDisclosure && !GROUP_COUNT_RE.test(text) && !GROUP_TITLE_RE.test(text)) {
      continue;
    }
    pushToggle(toggle);
  }

  return toggles;
}

function isExpanded(el) {
  return String(el?.getAttribute?.("aria-expanded") || "").toLowerCase() === "true";
}

async function expandAgentGroups(root, expectedAgent, optionProbe = () => null) {
  const groups = findExpandableAgentGroups(root, expectedAgent);
  let method = "";
  let anyToggleOpened = false;

  for (const group of groups) {
    // Treat the toggle's own aria-expanded flipping to "true" as success in addition to the
    // option appearing: the WPP picker can render the revealed option lazily or in a sibling
    // subtree, so the option may not be queryable the instant the group opens. Stopping here
    // (rather than escalating to pointer/keyboard on an already-open group) avoids re-collapsing.
    const opened = () => Boolean(optionProbe()) || isExpanded(group);
    method = await activateElement(group, opened, { timeoutMs: 1200, intervalMs: 100 });
    if (isExpanded(group)) {
      anyToggleOpened = true;
    }
    if (optionProbe()) {
      return { expanded: true, anyToggleOpened: true, method, count: groups.length };
    }
  }

  return { expanded: Boolean(optionProbe()), anyToggleOpened, method, count: groups.length };
}

function safeEvent(type, ctorName, init = {}) {
  const EventCtor = globalThis[ctorName] || globalThis.Event;
  if (!EventCtor) {
    return null;
  }

  try {
    return new EventCtor(type, init);
  } catch {
    try {
      return new EventCtor(type);
    } catch {
      return null;
    }
  }
}

function dispatchIfPossible(el, event) {
  if (event && typeof el?.dispatchEvent === "function") {
    el.dispatchEvent(event);
  }
}

function dispatchPointerActivation(el) {
  const shared = {
    bubbles: true,
    cancelable: true,
    composed: true,
    view: window,
    button: 0,
    buttons: 1
  };

  for (const type of ["pointerover", "pointerenter", "mouseover", "mouseenter", "pointerdown", "mousedown", "pointerup", "mouseup", "click"]) {
    const ctor = type.startsWith("pointer") ? "PointerEvent" : "MouseEvent";
    dispatchIfPossible(el, safeEvent(type, ctor, shared));
  }
}

function dispatchKeyboardActivation(el) {
  for (const type of ["keydown", "keyup"]) {
    dispatchIfPossible(el, safeEvent(type, "KeyboardEvent", {
      bubbles: true,
      cancelable: true,
      composed: true,
      key: "Enter",
      code: "Enter"
    }));
  }
}

async function waitForProbe(probe, timeoutMs = 1000, intervalMs = 100) {
  const startedAt = Date.now();

  while (Date.now() - startedAt <= timeoutMs) {
    try {
      if (await probe()) {
        return true;
      }
    } catch {
      // Probe failures mean the DOM is still transitioning; keep polling.
    }
    await wait(intervalMs);
  }

  return false;
}

async function activateElement(el, successProbe = () => false, options = {}) {
  const target = clickableFor(el);
  if (!target) {
    return "none";
  }

  target.scrollIntoView?.({ block: "center", inline: "nearest" });
  target.focus?.({ preventScroll: true });

  if (typeof target.click === "function") {
    target.click();
    if (await waitForProbe(successProbe, options.timeoutMs || 1000, options.intervalMs || 100)) {
      return "click";
    }
  }

  dispatchPointerActivation(target);
  if (await waitForProbe(successProbe, options.timeoutMs || 1000, options.intervalMs || 100)) {
    return "pointer";
  }

  dispatchKeyboardActivation(target);
  if (await waitForProbe(successProbe, options.timeoutMs || 1000, options.intervalMs || 100)) {
    return "keyboard";
  }

  return "none";
}

function dispatchInputValue(input, value) {
  input.focus?.();
  setNativeValue(input, value);
  dispatchIfPossible(input, safeEvent("beforeinput", "InputEvent", {
    bubbles: true,
    cancelable: true,
    composed: true,
    inputType: "insertText",
    data: value
  }));
  dispatchIfPossible(input, safeEvent("input", "InputEvent", {
    bubbles: true,
    cancelable: true,
    composed: true,
    inputType: "insertText",
    data: value
  }));
  dispatchIfPossible(input, safeEvent("change", "Event", {
    bubbles: true,
    cancelable: true,
    composed: true
  }));
}

function samplePickerText(root) {
  if (!root) {
    return "";
  }

  const parts = [elementText(root)];
  for (const el of deepQueryAll("input, textarea, button, [role='button'], [role='option'], [role='menuitem']", root)) {
    parts.push(searchLabelFor(el), labelFor(el), elementText(el));
  }

  return Array.from(new Set(parts.map((part) => String(part || "").trim()).filter(Boolean)))
    .join(" | ")
    .replace(/\s+/g, " ")
    .slice(0, 500);
}

// Shadow-piercing, picker-scoped variant of hasUploadProgressIndicator: is a loading affordance
// (spinner / progress bar / aria-busy / "loading" text) currently visible inside the picker? This
// is the candidate progress signal for the empty roster phase — instrumentation confirms whether a
// cold WPP picker actually renders one before we key the readiness gate off it.
function hasRosterLoadingAffordance(root) {
  if (!root) {
    return false;
  }

  if (deepQueryAll("[aria-busy='true'], [role='progressbar'], progress", root).some(isVisible)) {
    return true;
  }

  return deepQueryAll("[class], [aria-label], [title]", root).some((el) => {
    if (!isVisible(el)) {
      return false;
    }

    const signature = [
      el.getAttribute?.("class"),
      el.getAttribute?.("aria-label"),
      el.getAttribute?.("title")
    ].filter(Boolean).join(" ");

    return UPLOAD_PROGRESS_LABEL.test(signature);
  });
}

// Diagnostic-only (instrumentation step): snapshot the agent roster at failure time so a real
// cold/slow-link failure reveals which progress signal a still-loading picker exposes — a climbing
// option count, a loading affordance, or neither. The idle-based readiness gate keys off whichever
// the evidence proves real; capturing first avoids guessing the signal blind (the fixed-budget
// mistake). ponytail: capture only, no behavior change — the gate lands once we have one failure back.
function captureRosterReadiness(pickerRoot, expectedAgent) {
  const scope = pickerRoot || findModelPickerRoot(expectedAgent) || document;
  const options = deepQueryAll(MODEL_OPTION_SELECTOR, scope).filter(isVisible);

  return {
    optionCount: options.length,
    optionSample: options.slice(0, 8).map((el) => elementText(el).slice(0, 40)).filter(Boolean),
    loadingAffordance: hasRosterLoadingAffordance(scope),
    subtreeSignature: samplePickerText(scope).slice(0, 300)
  };
}

function visibleRosterOptionCount(root) {
  return deepQueryAll(MODEL_OPTION_SELECTOR, root || document)
    .filter((el) => isVisible(el) && elementText(el).length > 0)
    .length;
}

function hasRelevantAgentGroup(root = document, expectedAgent = "") {
  const target = normalizeAgentText(expectedAgent);
  return deepQueryAll("button, [role='button'], [aria-expanded], [tabindex], div, p, span, li", root || document)
    .some((el) => {
      if (!el || !isVisible(el)) {
        return false;
      }
      const text = elementText(el);
      if (target && normalizeAgentText(text).includes(target)) {
        return false;
      }
      if (!looksLikeGroupHeader(text)) {
        return false;
      }
      const toggle = groupToggleFor(el);
      return toggle?.getAttribute?.("aria-expanded") != null
        || GROUP_COUNT_RE.test(text)
        || GROUP_TITLE_RE.test(text);
    });
}

function rosterReady(root, expectedAgent) {
  return Boolean(findAgentOption(document, expectedAgent))
    || visibleRosterOptionCount(root) > 0
    || hasRelevantAgentGroup(document, expectedAgent);
}

async function waitForRosterReady(pickerRoot, expectedAgent) {
  const intervalMs = 250;
  const noProgressTicks = 32;
  const maxTicks = 240;
  let scope = findModelPickerRoot(expectedAgent) || pickerRoot || document;
  let lastOptionCount = visibleRosterOptionCount(scope);
  let lastSignature = samplePickerText(scope);
  let idleTicks = 0;

  for (let tick = 0; tick < maxTicks; tick += 1) {
    scope = findModelPickerRoot(expectedAgent) || pickerRoot || document;
    if (rosterReady(scope, expectedAgent)) {
      return { ok: true, failureReason: "" };
    }

    await wait(intervalMs);

    const optionCount = visibleRosterOptionCount(scope);
    const signature = samplePickerText(scope);
    const progressed = optionCount !== lastOptionCount
      || hasRosterLoadingAffordance(scope)
      || signature !== lastSignature;

    if (progressed) {
      idleTicks = 0;
      lastOptionCount = optionCount;
      lastSignature = signature;
    } else {
      idleTicks += 1;
    }

    if (idleTicks >= noProgressTicks) {
      return { ok: false, failureReason: "agent-roster-empty" };
    }
  }

  return { ok: false, failureReason: "agent-roster-loading-timeout" };
}

// Ensure the OgilvyOneCoder agent is selected before submitting. This is intentionally
// fail-closed: if the extension cannot prove the composer pill changed to the required agent,
// the prompt is not submitted.
// The mode popover shown after clicking the new chat-model-button (model-select__mode-menu), or null.
function findModeMenu() {
  return deepQueryAll("[data-testid='model-select-mode-menu'], [class*='model-select__mode-menu']", document)
    .find(isVisible) || null;
}

// New WPP UI step: the model-button popover lists routing modes (Auto / Premium) and, below a
// divider, a "Select model or agent" navigation row (with a › chevron) that opens the searchable,
// grouped agent list. Click that row so the rest of ensureAgentSelected can search + pick the agent.
// "Select model or agent" is NOT one of the routing-mode options, so target it by its text, not the
// model-select-mode-option-* testids (those are Auto/Premium). Returns the activation method, or ""
// when the searchable picker is already open. Best-effort: never throws.
async function chooseModelOrAgentMode() {
  const deadline = Date.now() + 2500;
  const isSelectRow = (el) => /^\s*select model or agent\s*$/i.test(elementText(el));
  while (Date.now() < deadline) {
    if (findAgentSearchInput(document)) return "";
    // Smallest-text-subtree match resolves the actual label row over its wrapper ancestors.
    const rows = deepQueryAll("button, [role='menuitem'], [role='option'], [role='button'], a, li, div", document)
      .filter((el) => isVisible(el) && isSelectRow(el))
      .sort((left, right) => left.querySelectorAll("*").length - right.querySelectorAll("*").length);
    const row = rows[0];
    if (row) {
      const target = clickableFor(row) || row;
      const method = await activateElement(target, () => Boolean(findAgentSearchInput(document)), { timeoutMs: 1600 });
      return method || "clicked";
    }
    await wait(150);
  }
  return "";
}

async function ensureAgentSelected(expectedAgent, textarea) {
  const state = {
    ok: false,
    pillFound: false,
    label: "",
    beforeLabel: "",
    afterLabel: "",
    pickerOpened: false,
    searchFound: false,
    optionFound: false,
    groupExpanded: false,
    groupExpansionMethod: "",
    groupCount: 0,
    groupToggleOpened: false,
    optionText: "",
    activationMethod: "",
    failureReason: "",
    pickerText: "",
    rosterReadiness: null
  };
  const readPill = () => elementText(findModelPill(expectedAgent, textarea));
  const finish = (ok, failureReason = "", pickerRoot = null) => {
    state.afterLabel = readPill();
    state.label = state.afterLabel || state.beforeLabel || "";
    state.pillFound = Boolean(findModelPill(expectedAgent, textarea));
    state.ok = ok;
    state.failureReason = failureReason;
    if (pickerRoot) {
      state.pickerText = samplePickerText(pickerRoot);
    }
    if (!ok) {
      state.rosterReadiness = state.rosterReadiness || captureRosterReadiness(pickerRoot, expectedAgent);
    }
    return { ...state };
  };
  const pill = findModelPill(expectedAgent, textarea);

  state.pillFound = Boolean(pill);
  state.beforeLabel = pill ? elementText(pill) : "";
  state.label = state.beforeLabel;

  if (!pill) {
    return finish(false, "model-pill-not-found");
  }

  if (agentLabelMatches(state.beforeLabel, expectedAgent)) {
    return finish(true, "", null);
  }

  const openMethod = await activateElement(pill, () =>
    Boolean(findModelPickerRoot(expectedAgent) || findAgentSearchInput(document) || findModeMenu()),
  { timeoutMs: 1600 });
  state.activationMethod = `open:${openMethod}`;

  // New WPP UI inserts a MODE step: clicking the model button opens a popover (model-select__mode-menu)
  // offering "Auto" vs "Select model or agent" rather than the picker directly. Choose the
  // model/agent option to reveal the searchable, grouped list the rest of this function expects.
  const modeMethod = await chooseModelOrAgentMode();
  if (modeMethod) state.activationMethod += `;mode:${modeMethod}`;

  let pickerRoot = findModelPickerRoot(expectedAgent);
  state.pickerOpened = Boolean(pickerRoot || findAgentSearchInput(document));
  if (!state.pickerOpened) {
    return finish(false, "model-picker-not-opened");
  }

  const searchRoot = pickerRoot || document;
  const search = findAgentSearchInput(searchRoot) || findAgentSearchInput(document);
  state.searchFound = Boolean(search);
  if (search) {
    dispatchInputValue(search, expectedAgent);
    await wait(600);
    pickerRoot = findModelPickerRoot(expectedAgent) || pickerRoot;
  }

  const roster = await waitForRosterReady(pickerRoot || document, expectedAgent);
  if (!roster.ok) {
    return finish(false, roster.failureReason, pickerRoot);
  }

  let option = null;
  const optionProbe = () => findAgentOption(document, expectedAgent);
  // Search for the target option and collapsible groups from the document, not the narrowed picker
  // root: WPP can render the list (and the option itself) as a sibling of the dialog that
  // findModelPickerRoot resolves, so a root-scoped search can miss it entirely.
  let groupExpansion = await expandAgentGroups(document, expectedAgent, optionProbe);
  state.groupExpanded = groupExpansion.expanded;
  state.groupExpansionMethod = groupExpansion.method;
  state.groupCount = groupExpansion.count;
  state.groupToggleOpened = groupExpansion.anyToggleOpened;

  for (let attempt = 0; attempt < 12; attempt += 1) {
    pickerRoot = findModelPickerRoot(expectedAgent) || pickerRoot;
    option = findAgentOption(document, expectedAgent);
    if (option) {
      break;
    }
    // The picker can render or re-render its groups after the search debounce, so a group that
    // was not present (or not yet collapsed) on the first pass may appear now. Keep trying to
    // expand until the option surfaces.
    if (!groupExpansion.expanded) {
      groupExpansion = await expandAgentGroups(document, expectedAgent, optionProbe);
      state.groupCount = Math.max(state.groupCount, groupExpansion.count);
      state.groupToggleOpened = state.groupToggleOpened || groupExpansion.anyToggleOpened;
      if (groupExpansion.expanded) {
        state.groupExpanded = true;
        state.groupExpansionMethod = groupExpansion.method;
      }
    }
    await wait(250);
  }

  state.optionFound = Boolean(option);
  state.optionText = option?.text || "";
  state.pickerText = samplePickerText(pickerRoot);
  if (!option) {
    // Make the live failure self-describing: distinguish "no collapsible group was even found"
    // from "a group opened but the option still never appeared" from "the toggle never opened".
    const reason = state.groupCount === 0
      ? "agent-option-not-found-no-collapsed-group"
      : state.groupToggleOpened
        ? "agent-option-not-found-after-group-expanded"
        : "agent-option-not-found-group-did-not-open";
    return finish(false, reason, pickerRoot);
  }

  // New WPP UI: once an agent is chosen the model button shows only an icon — no name text, no
  // tooltip — so we CANNOT confirm selection by pill text (agentLabelMatches would never pass). The
  // option was matched by name via findAgentOption(expectedAgent), so clicking it selects the right
  // agent; confirm the click APPLIED by the picker dismissing (search input + mode menu gone and the
  // option no longer visible). Fall back to pill-text match for the old UI where the name is shown.
  const selectionApplied = () =>
    agentLabelMatches(readPill(), expectedAgent)
    || (!findAgentSearchInput(document) && !findModeMenu() && !isVisible(option.element));

  const optionMethod = await activateElement(option.element, selectionApplied, { timeoutMs: 2500 });
  state.activationMethod = `${state.activationMethod};option:${optionMethod}`;

  for (let attempt = 0; attempt < 12; attempt += 1) {
    if (selectionApplied()) {
      return finish(true, "", pickerRoot);
    }
    await wait(250);
  }

  return finish(false, "agent-picker-did-not-dismiss-after-option-activation", pickerRoot);
}

function chatRootFor(textarea) {
  return textarea.closest(".chat-input")
    || textarea.closest("[data-testid='conversation-layout']")
    || textarea.closest("main, section")
    || document;
}

function isChatReadyForNextMessage(textarea) {
  if (!textarea) {
    return true;
  }

  if (findStopButton(textarea)) {
    return false;
  }

  if (findSendAffordance(textarea, { enabledOnly: false })) {
    return true;
  }

  return !textarea.disabled && !textarea.readOnly && isVisible(textarea);
}

function inspectChatState() {
  const textarea = Array.from(document.querySelectorAll("textarea"))
    .find((el) => isVisible(el));

  if (!textarea) {
    return {
      ok: false,
      reason: "no-textarea",
      ready: false,
      state: "missing"
    };
  }

  const stopButton = findStopButton(textarea);
  const sendEnabled = findSendAffordance(textarea, { enabledOnly: true });
  const sendPresent = findSendAffordance(textarea, { enabledOnly: false });
  const ready = isChatReadyForNextMessage(textarea);

  let state = "unknown";

  if (stopButton) {
    state = "generating";
  } else if (sendPresent && !sendEnabled) {
    state = "idle-empty-input";
  } else if (sendEnabled) {
    state = "idle-ready-to-send";
  } else if (ready) {
    state = "idle";
  } else {
    state = "stuck";
  }

  return {
    ok: true,
    ready,
    state,
    stopVisible: Boolean(stopButton),
    sendEnabled: Boolean(sendEnabled),
    sendPresent: Boolean(sendPresent),
    textareaDisabled: textarea.disabled,
    textareaReadOnly: textarea.readOnly,
    textareaValueLength: textarea.value.length,
    href: location.href
  };
}

async function waitForChatReady(textarea, timeoutMs) {
  const startedAt = Date.now();

  while (Date.now() - startedAt < timeoutMs) {
    if (isChatReadyForNextMessage(textarea)) {
      return true;
    }

    await wait(150);
  }

  return false;
}

function submitWithEnter(textarea) {
  for (const type of ["keydown", "keypress", "keyup"]) {
    textarea.dispatchEvent(new KeyboardEvent(type, {
      key: "Enter",
      code: "Enter",
      bubbles: true,
      cancelable: true
    }));
  }
}

function textareaStillContainsPrompt(textarea, prompt) {
  return normalizePromptText(textarea?.value) === normalizePromptText(prompt);
}

function normalizePromptText(value) {
  return String(value || "").replace(/\s+/g, " ").trim();
}

async function waitForNetworkResponse({ runId, timeoutMs, textarea, prompt = "", ignoredAssistantErrorText = null, beforeAssistantMessage = null }) {
  const startedAt = Date.now();
  const discoveryTimeoutMs = 3000;
  const noNetworkDomFallbackMs = 30000;
  const baseTimeoutMs = Math.max(discoveryTimeoutMs, SETUP_TIMEOUT_MS);
  const maxTimeoutMs = Math.max(baseTimeoutMs, Number(timeoutMs || SETUP_TIMEOUT_MS));
  const idleCompleteMs = 6000;
  const domStableMs = 3000;
  const assistantUiCheckMs = 1000;
  const uiRoot = textarea ? chatRootFor(textarea) : undefined;
  let observedNetwork = false;
  let assistantUi = { error: null, warning: null };
  let thinking = false;
  let lastAssistantUiCheckAt = 0;
  let domCandidateKey = "";
  let domCandidateStableSince = 0;
  // Debounce state for the fatal-toast bail: the text of the fatal error currently being timed
  // and when it was first seen. Reset whenever the error clears, its text changes, or the UI is
  // generating — so a transient toast during streaming never accrues debounce time.
  let fatalErrorText = "";
  let fatalErrorFirstSeenAt = 0;

  while (Date.now() < responseWaitDeadline(startedAt, baseTimeoutMs, maxTimeoutMs, textarea, thinking)) {
    const nowMs = Date.now();
    const record = pickNetworkRecord(runId);
    const chatReady = isChatReadyForNextMessage(textarea);
    const domCandidate = latestAssistantMessageSnapshot(textarea);
    const domCandidateChanged = isNewAssistantMessage(domCandidate, beforeAssistantMessage);
    const nextDomKey = domCandidateChanged ? domCandidate.key : "";

    if (nextDomKey && nextDomKey === domCandidateKey) {
      domCandidateStableSince ||= nowMs;
    } else {
      domCandidateKey = nextDomKey;
      domCandidateStableSince = nextDomKey ? nowMs : 0;
    }

    // The visible-text scan forces layout, so run it ~1/sec rather than every tick. The
    // captured network record is the primary completion signal; the UI scan is a fallback.
    // `thinking` (stop button / "thinking" text / in-flight record) is computed on the same
    // throttled cadence — it gates the fatal-toast bail below.
    if (Date.now() - lastAssistantUiCheckAt >= assistantUiCheckMs) {
      assistantUi = inspectAssistantUi(uiRoot);
      thinking = Boolean(
        (textarea && findStopButton(textarea))
        || matchThinkingText(visiblePageText(uiRoot))
        || hasIncompleteNetworkRecord(runId)
      );
      lastAssistantUiCheckAt = Date.now();
    }

    if (shouldReturnCapturedRecordDespiteAssistantUiError(record, assistantUi.error)) {
      return record;
    }

    // Track how long the current fatal toast has persisted. Reset the timer whenever it clears,
    // its text changes, or the UI is generating — so a toast that flashes during streaming on an
    // image turn never reaches the bail (the real response arrives and is captured above instead).
    if (assistantUi.error?.severity === "fatal" && !thinking) {
      if (assistantUi.error.text !== fatalErrorText) {
        fatalErrorText = assistantUi.error.text;
        fatalErrorFirstSeenAt = nowMs;
      }
    } else {
      fatalErrorText = "";
      fatalErrorFirstSeenAt = 0;
    }

    if (shouldTreatAssistantUiErrorAsFatal(assistantUi.error, ignoredAssistantErrorText, {
      thinking,
      persistedMs: fatalErrorFirstSeenAt ? nowMs - fatalErrorFirstSeenAt : 0,
      debounceMs: FATAL_UI_ERROR_DEBOUNCE_MS
    })) {
      // Don't throw here anymore. Return a typed signal so runJob can decide whether to
      // retry (fresh thread) within the remaining time budget. The salvage path above
      // (shouldReturnCapturedRecordDespiteAssistantUiError) already handled the case where
      // we captured complete content despite the toast, so reaching here means content-less.
      return { fatalUiError: true, text: assistantUi.error.text };
    }

    if (record) {
      observedNetwork = true;
    }

    // A record errors when the WPP app aborts/retries its SSE fetch — transient, and marked done.
    // A record that captured a complete answer before erroring is returned by the normal completion
    // path below (it fires on record.done), so there's nothing to salvage here. The error flag is
    // only terminal for an EMPTY errored request: no content, the model has stopped generating, and
    // we're past the discovery window — then the run is genuinely dead, so fail fast.
    if (record?.error
        && !recordHasCapturedContent(record)
        && !thinking
        && nowMs - startedAt > discoveryTimeoutMs) {
      return null;
    }

    if (record && recordHasCapturedContent(record)) {
      if (shouldReturnCapturedRecord(record, {
        nowMs,
        idleCompleteMs,
        chatReady
      })) {
        return record;
      }

      if (shouldReturnStuckCapturedRecord(record, {
        nowMs,
        idleCompleteMs,
        chatReady,
        textarea
      })) {
        return record;
      }
    }

    if (shouldReturnDomFallback({
      candidate: domCandidate,
      before: beforeAssistantMessage,
      nowMs,
      stableSinceMs: domCandidateStableSince,
      domStableMs,
      chatReady,
      textarea,
      record
    })) {
      return domRecordFromSnapshot(domCandidate);
    }

    if (!observedNetwork && nowMs - startedAt > discoveryTimeoutMs) {
      if (textareaStillContainsPrompt(textarea, prompt) || nowMs - startedAt > noNetworkDomFallbackMs) {
        return null;
      }
    }

    await wait(400);
  }

  return null;
}

function responseWaitDeadline(startedAt, baseTimeoutMs, maxTimeoutMs, textarea, thinking = false) {
  let deadline = startedAt + baseTimeoutMs;

  // Keep the wait alive while the model is still generating. Gate on the broad `thinking` signal
  // (stop button OR "Working"/thinking text OR an in-flight network record), not just
  // isChatReadyForNextMessage — that returns "ready" the instant findStopButton flickers during a
  // DOM re-render, which would collapse the deadline to the base window and bail mid-generation
  // (e.g. a long Opus thinking phase that streams reasoning but no content yet). The maxTimeoutMs
  // cap below still bounds a genuinely stuck thinking state to the job timeout.
  if (thinking || (textarea && !isChatReadyForNextMessage(textarea))) {
    deadline = Math.max(deadline, Date.now() + 15000);
  }

  return Math.min(deadline, startedAt + maxTimeoutMs);
}

function shouldReturnCapturedRecord(record, { nowMs, idleCompleteMs, chatReady }) {
  if (!recordHasCapturedContent(record)) {
    return false;
  }

  if (record.done || record.finishReason) {
    return true;
  }

  if (!chatReady) {
    return false;
  }

  return recordCanCompleteOnIdle(record, nowMs, idleCompleteMs);
}

function shouldReturnStuckCapturedRecord(record, { nowMs, idleCompleteMs, chatReady, textarea }) {
  if (chatReady || !textarea || findStopButton(textarea)) {
    return false;
  }

  const updatedAt = Date.parse(record?.updatedAt || record?.startedAt || "");
  const networkIdleMs = Number.isFinite(updatedAt) ? nowMs - updatedAt : 0;

  return networkIdleMs > idleCompleteMs * 5
    && recordHasCapturedContent(record)
    && !recordLooksLikeIncompleteToolCall(record);
}

function shouldReturnCapturedRecordDespiteAssistantUiError(record, error) {
  return error?.severity === "fatal"
    && recordHasCapturedContent(record)
    && !recordLooksLikeIncompleteToolCall(record);
}

// A fatal toast is terminal only if it is NOT a stale carryover, the UI is NOT currently
// generating (thinking), and it has persisted past the debounce window. The defaults preserve
// the original two-arg behavior (no thinking, already persisted) for callers that don't supply
// the live signals.
function shouldTreatAssistantUiErrorAsFatal(
  error,
  ignoredAssistantErrorText = null,
  { thinking = false, persistedMs = Infinity, debounceMs = 0 } = {}
) {
  return error?.severity === "fatal"
    && (!ignoredAssistantErrorText || error.text !== ignoredAssistantErrorText)
    && !thinking
    && persistedMs >= debounceMs;
}

function shouldReturnDomFallback({ candidate, before, nowMs, stableSinceMs, domStableMs, chatReady, textarea, record }) {
  if (!chatReady || !textarea) {
    return false;
  }

  if (typeof textarea.closest === "function" && findStopButton(textarea)) {
    return false;
  }

  if (!isNewAssistantMessage(candidate, before)) {
    return false;
  }

  if (!stableSinceMs || nowMs - stableSinceMs < domStableMs) {
    return false;
  }

  if (record && recordHasCapturedContent(record) && recordLooksLikeIncompleteToolCall(record)) {
    return false;
  }

  return !isIncompleteToolCallText(candidate.text)
    && !looksLikeIncompleteAnthropicToolCall(candidate.text);
}

function domRecordFromSnapshot(snapshot) {
  // DOM fallback is inherently lower fidelity than the network recorder: assistant text is read via
  // innerText (render-aware, collapses whitespace), so tool-call code/heredocs may not survive
  // byte-for-byte. Use the whitespace-preserving rawText for the payload, and flag the result
  // lowFidelity so the proxy/harness never silently trusts it for byte-sensitive edits.
  try {
    console.warn("[o1-code] assistant response recovered via DOM fallback (low fidelity); network capture missed this turn.");
  } catch {}
  return {
    id: `dom_${Date.now()}`,
    runId: null,
    url: "extension://o1-code-dom-fallback",
    method: "DOM_FALLBACK",
    responseSource: "dom",
    lowFidelity: true,
    responseStatus: 200,
    finalText: snapshot.rawText || snapshot.text,
    finishReason: "stop",
    toolCallParts: {},
    done: true,
    eventCount: 0,
    byteCount: 0,
    counts: {
      chunks: 0,
      events: 0,
      unparsed: 0,
      eventCount: 0,
      byteCount: 0
    },
    dom: snapshot
  };
}

function latestAssistantMessageSnapshot(textarea = findVisibleTextarea()) {
  if (typeof document === "undefined") {
    return null;
  }

  const root = textarea ? chatRootFor(textarea) : document;
  const candidates = assistantMessageCandidates(root, textarea)
    .map((el) => messageSnapshotForElement(el, textarea))
    .filter(Boolean)
    .sort((left, right) => left.order - right.order || left.text.length - right.text.length);

  return candidates.at(-1) || null;
}

function assistantMessageCandidates(root, textarea) {
  const selector = [
    "[data-message-author-role='assistant']",
    "[data-testid*='assistant' i]",
    "[data-testid*='message' i]",
    "[class*='assistant' i]",
    "[class*='message' i]",
    "[class*='markdown' i]",
    "[class*='prose' i]",
    "article",
    "[role='article']",
    "[role='listitem']"
  ].join(",");
  const scoped = Array.from(root?.querySelectorAll?.(selector) || []);

  if (scoped.length > 0) {
    return scoped;
  }

  return Array.from(root?.querySelectorAll?.("article, section, div, p") || [])
    .filter((el) => !textarea || precedesTextarea(el, textarea));
}

function messageSnapshotForElement(el, textarea) {
  if (!el || !isVisible(el) || isComposerElement(el, textarea)) {
    return null;
  }

  const rawSource = el.innerText || el.textContent || "";
  const text = normalizeAssistantMessageText(rawSource);
  // Whitespace-preserving copy for the actual payload. `text` above is normalized only so snapshot
  // comparison/dedup/stability detection stays stable; it must NOT be the payload, because its
  // trailing-whitespace strip and blank-line collapse mutate whitespace-significant tool-call code.
  const rawText = preserveAssistantPayloadText(rawSource);

  if (!isUsableAssistantMessageText(text)) {
    return null;
  }

  const nested = Array.from(el.querySelectorAll?.("[data-message-author-role='assistant'], [data-testid*='message' i], [class*='markdown' i], [class*='prose' i], article, [role='article'], [role='listitem']") || [])
    .map((child) => normalizeAssistantMessageText(child.innerText || child.textContent || ""))
    .filter((childText) => childText && childText !== text);

  if (nested.some((childText) => text.includes(childText) && childText.length / text.length > 0.7)) {
    return null;
  }

  return {
    key: messageElementKey(el, text),
    text,
    rawText,
    order: documentOrder(el),
    tag: el.tagName ? el.tagName.toLowerCase() : "",
    id: el.id || null,
    className: typeof el.className === "string" ? el.className.slice(0, 120) : ""
  };
}

// COMPARE-ONLY normalization. The trailing-whitespace strip and blank-line collapse here exist to
// keep snapshot diffing stable across render flicker; they are LOSSY and must never touch the
// payload that the harness executes (see preserveAssistantPayloadText / snapshot.rawText).
function normalizeAssistantMessageText(value) {
  return String(value || "")
    .replace(/\u00a0/g, " ")
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

// PAYLOAD normalization. Whitespace-preserving: only collapses non-breaking spaces (a render
// artifact) and strips edge newlines. Keeps trailing spaces and blank lines intact so the model's
// tool-call code/heredocs survive DOM extraction byte-for-byte as far as innerText allows. Still
// inherently lower fidelity than the network recorder (innerText is render-aware) \u2014 callers flag it.
function preserveAssistantPayloadText(value) {
  return String(value || "")
    .replace(/\u00a0/g, " ")
    .replace(/^\n+|\n+$/g, "");
}

function isUsableAssistantMessageText(text) {
  if (text.length < 20) {
    return false;
  }

  if (/^(chat|new chat|show recent|send a message|settings|tools)$/i.test(text)) {
    return false;
  }

  return !/\b(Send a message|New Chat|Show recent|Add files|Settings|Tools)\b/i.test(text.slice(-300));
}

function isComposerElement(el, textarea) {
  if (!textarea) {
    return false;
  }

  return el === textarea
    || el.contains?.(textarea)
    || textarea.closest("form")?.contains(el)
    || textarea.closest(".chat-input")?.contains(el);
}

function precedesTextarea(el, textarea) {
  if (!textarea || el === textarea || el.contains?.(textarea)) {
    return false;
  }

  return Boolean(el.compareDocumentPosition(textarea) & 4);
}

function documentOrder(el) {
  const all = Array.from(document.querySelectorAll("body *"));
  return all.indexOf(el);
}

function messageElementKey(el, text) {
  return [
    el.getAttribute?.("data-message-id") || "",
    el.id || "",
    documentOrder(el),
    text
  ].join("|");
}

function isNewAssistantMessage(candidate, before) {
  if (!candidate?.text) {
    return false;
  }

  if (!before?.text) {
    return true;
  }

  return candidate.key !== before.key && candidate.text !== before.text;
}

function recordCanCompleteOnIdle(record, nowMs = Date.now(), idleCompleteMs = 6000) {
  const updatedAt = Date.parse(record?.updatedAt || record?.startedAt || "");

  return Number.isFinite(updatedAt)
    && nowMs - updatedAt > idleCompleteMs
    && recordHasCapturedContent(record)
    && !recordLooksLikeIncompleteToolCall(record);
}

function recordHasCapturedContent(record) {
  if (String(record?.finalText || "").trim().length > 0) {
    return true;
  }

  for (const part of Object.values(record?.toolCallParts || {})) {
    if (part?.name) {
      return true;
    }
  }

  return false;
}

function recordLooksLikeIncompleteToolCall(record) {
  const text = String(record?.finalText || "").trim();

  if (isIncompleteToolCallText(text) || looksLikeIncompleteAnthropicToolCall(text)) {
    return true;
  }

  for (const part of Object.values(record?.toolCallParts || {})) {
    if (part?.name && !isCompleteJson(part.arguments || "")) {
      return true;
    }
  }

  return (record?.events || []).some((event) =>
    (event.toolCalls || []).some((toolCall) => {
      const args = toolCall?.function?.arguments ?? toolCall?.arguments;

      return typeof args === "string"
        && args.trim().startsWith("{")
        && !isCompleteJson(args);
    })
  );
}

function isCompleteJson(value) {
  try {
    JSON.parse(value);
    return true;
  } catch {
    return false;
  }
}

function networkCaptureError(runId, { ignoredAssistantErrorText = null } = {}) {
  const requestCount = recorderStatus.requests.get(runId)?.length || 0;
  const assistantUi = inspectAssistantUi();
  const assistantError = assistantUi.error && assistantUi.error.text !== ignoredAssistantErrorText
    ? ` Assistant UI reported: ${assistantUi.error.text}`
    : "";

  if (!recorderStatus.ready) {
    return `Network recorder is not ready. Reload the extension and refresh the O1-Code assistant page.${assistantError}`;
  }

  if (!recorderStatus.resets.has(runId)) {
    return `Network recorder did not acknowledge this run.${assistantError}`;
  }

  if (requestCount === 0) {
    return `Network recorder captured no O1-Code model request for this prompt.${assistantError}`;
  }

  return `Network recorder saw ${requestCount} request(s), but no completed model response.${assistantError}`;
}

function pickNetworkRecord(runId) {
  const records = Array.from(networkRecords.values())
    .filter((record) => record.runId === runId && record.method === "POST");

  // Prefer a record that actually captured the model response (text or tool calls) over a
  // bare POST that merely completed — otherwise a contentless "done" record sorting last
  // could mask the real model stream.
  const withContent = records.filter((record) => recordHasCapturedContent(record));
  if (withContent.length > 0) {
    return withContent.at(-1);
  }

  const streamed = records.filter((record) =>
    Number(record.eventCount) > 0 ||
    Number(record.byteCount) > 0 ||
    record.done ||
    record.finishReason ||
    record.error
  );

  return streamed.at(-1) || records.at(-1) || null;
}

function labelFor(el) {
  if (!el) {
    return "";
  }

  return [
    el.getAttribute?.("aria-label"),
    el.getAttribute?.("title"),
    el.getAttribute?.("placeholder"),
    el.innerText,
    el.textContent
  ].filter(Boolean).join(" ").trim();
}

function isVisible(el) {
  const style = getComputedStyle(el);
  const rect = el.getBoundingClientRect();

  return style.visibility !== "hidden"
    && style.display !== "none"
    && rect.width > 0
    && rect.height > 0;
}

function inspectAssistantUi(root) {
  const text = visiblePageText(root);

  return {
    error: findAssistantUiError(text),
    warning: findAssistantUiWarning(text)
  };
}

// Scrape WPP's conversation token-count pill (e.g. "19,547 tokens"). WPP's model-completion SSE
// does NOT carry token usage (verified across many captured streams — the only fields are
// model/content/messageId/toolCalls/finishReason), so this DOM pill is the only surface exposing
// WPP's own count. It is a CUMULATIVE conversation total, not per-turn; the proxy maps it onto
// prompt_tokens (treating the latest message as current context occupancy, matching overflow.ts)
// which also preserves the existing over-estimate safety bias. Whitespace/format-fragile by
// nature, so the result is marked lowFidelity and any miss falls back to the chars/token
// heuristic upstream.
//
// Strictness is deliberate: we accept ONLY an element whose entire trimmed text is
// "<number> tokens" with nothing else. This rejects used/limit displays like
// "19,547 / 200,000 tokens" (we will not guess which half is the live count) and assistant reply
// prose that merely mentions "tokens" — a miss is safe (heuristic fallback), a wrong number is not.
//
// The live pill is `<span class="cs-message-tokens" data-testid="message-tokens"><svg/>N tokens</span>`
// (the SVG icon contributes no text, so textContent is exactly "N tokens"). We query that precise
// hook first and only fall back to a generic strict scan if WPP drops the testid/class.
const TOKEN_PILL_TEXT = /^([\d][\d,]*)\s*tokens?$/i;
const TOKEN_PILL_SELECTOR = "[data-testid='message-tokens'], .cs-message-tokens";

function scrapeTokenPill(root = document) {
  if (typeof document === "undefined") {
    return null;
  }

  const best = pickTokenPill(deepQueryAll(TOKEN_PILL_SELECTOR, root))
    || pickTokenPill(deepQueryAll("*", root));

  if (!best) {
    return null;
  }

  return {
    cumulativeTokens: best.value,
    raw: best.text,
    source: "dom-pill",
    lowFidelity: true
  };
}

function pickTokenPill(elements) {
  let best = null;

  for (const el of elements) {
    let text;
    try {
      text = String(el.textContent || "").trim();
    } catch {
      continue;
    }

    if (text.length > 24) {
      continue;
    }

    const match = text.match(TOKEN_PILL_TEXT);
    if (!match) {
      continue;
    }

    // Ignore numbers rendered inside the message transcript (assistant prose / code blocks).
    if (el.closest?.(MESSAGE_BUBBLE_SELECTOR)) {
      continue;
    }

    if (!isVisible(el)) {
      continue;
    }

    const value = Number(match[1].replace(/,/g, ""));
    if (!Number.isFinite(value) || value <= 0) {
      continue;
    }

    // Prefer the deepest/most-specific match: the pill's leaf element over any wrapper that
    // happens to contain only the pill, so `raw` reflects the actual pill node.
    const depth = el.querySelectorAll ? el.querySelectorAll("*").length : 0;
    if (!best || depth < best.depth) {
      best = { value, text, depth };
    }
  }

  return best;
}

function buildBridgeDiagnostics({
  phase = "unknown",
  runId = null,
  textarea = null,
  prompt = "",
  submitted = null,
  ignoredAssistantErrorText = null,
  domMessage = null,
  responseSource = null,
  finalTextLength = null,
  expectedAgent = null,
  selectedAgent = null,
  wireModel = null,
  agentSelection = null
} = {}) {
  const candidateTextarea = textarea || findVisibleTextarea();
  const assistantUi = inspectAssistantUi();
  const stopButton = candidateTextarea ? findStopButton(candidateTextarea) : null;
  const sendEnabled = candidateTextarea ? findSendAffordance(candidateTextarea, { enabledOnly: true }) : null;
  const sendPresent = candidateTextarea ? findSendAffordance(candidateTextarea, { enabledOnly: false }) : null;
  const visibleText = visiblePageText();
  const thinkingText = matchThinkingText(visibleText);
  const requests = runId ? (recorderStatus.requests.get(runId) || []) : [];

  return {
    phase,
    at: new Date().toISOString(),
    href: location.href,
    title: document.title,
    origin: location.origin,
    promptLength: String(prompt || "").length,
    responseSource,
    finalTextLength,
    expectedAgent,
    selectedAgent,
    wireModel,
    agentSelection,
    ignoredAssistantErrorText,
    domMessage,
    assistantUi,
    thinking: Boolean(stopButton || thinkingText || hasIncompleteNetworkRecord(runId)),
    thinkingText,
    controls: {
      stopVisible: Boolean(stopButton),
      stopLabel: stopButton ? labelFor(stopButton) : "",
      sendEnabled: Boolean(sendEnabled),
      sendPresent: Boolean(sendPresent),
      sendLabel: labelFor(sendEnabled || sendPresent || null)
    },
    textarea: candidateTextarea ? summarizeTextarea(candidateTextarea) : null,
    submitted,
    recorder: {
      ready: recorderStatus.ready,
      reset: runId ? recorderStatus.resets.has(runId) : false,
      requestCount: requests.length,
      requests,
      // Verbose-only: unfiltered list of every request seen in this frame during the run. When
      // requestCount is 0 but the model visibly replies in the UI, this shows whether the model
      // request fired as a non-POST/filtered request (recorder blind spot) or not in this frame.
      observed: runId ? (recorderStatus.observed.get(runId) || []) : [],
      observedCount: runId ? (recorderStatus.observed.get(runId)?.length || 0) : 0,
      activeRecordCount: runId ? Array.from(networkRecords.values()).filter((record) => record.runId === runId).length : 0,
      incompleteRecordCount: runId ? Array.from(networkRecords.values()).filter((record) => record.runId === runId && !record.done).length : 0
    }
  };
}

function findVisibleTextarea() {
  return Array.from(document.querySelectorAll("textarea"))
    .find((el) => isVisible(el)) || null;
}

function summarizeTextarea(textarea) {
  return {
    valueLength: String(textarea.value || "").length,
    valuePreview: String(textarea.value || "").slice(0, 120),
    placeholder: textarea.getAttribute("placeholder") || "",
    disabled: textarea.disabled,
    readOnly: textarea.readOnly,
    visible: isVisible(textarea),
    label: labelFor(textarea)
  };
}

function matchThinkingText(text) {
  const match = String(text || "").match(/\b(Thinking(?:\.\.\.)?|Generating(?:\.\.\.)?|Working(?:\.\.\.)?)/i);
  return match ? match[0] : "";
}

function hasIncompleteNetworkRecord(runId = null) {
  return Array.from(networkRecords.values()).some((record) =>
    (!runId || record.runId === runId) && !record.done && !record.error
  );
}

async function dismissAssistantUiErrors() {
  const error = findAssistantUiError();

  if (!error) {
    return false;
  }

  const controls = Array.from(document.querySelectorAll("button, [role='button']"))
    .filter(isVisible)
    .filter((control) => {
      const label = labelFor(control);
      const rect = control.getBoundingClientRect();

      return /close|dismiss|cancel|×|x/i.test(label)
        || (rect.width <= 48 && rect.height <= 48);
    });

  for (const control of controls.reverse()) {
    control.click();
    await wait(100);

    if (!findAssistantUiError()) {
      return true;
    }
  }

  return false;
}

function findAssistantUiError(text = visiblePageText()) {
  const unableMatch = text.match(/Unable to complete the request\.\s*(?:\([^)]+\))?/i);

  if (!unableMatch) {
    return null;
  }

  return {
    severity: "fatal",
    text: unableMatch[0]
  };
}

function findAssistantUiWarning(text = visiblePageText()) {
  const slowMatch = text.match(/This is taking longer than expected\.?/i);

  if (!slowMatch) {
    return null;
  }

  return {
    severity: "warning",
    text: slowMatch[0]
  };
}

function visiblePageText(root) {
  if (typeof document === "undefined") {
    return "";
  }

  // Scope the scan to the chat container when we have one. Walking the whole document's
  // div/span tree and forcing innerText layout on every poll tick is the main per-tick
  // reflow cost during generation. The selector stays broad so WPP toast/alert/error
  // containers are still picked up within the scope.
  const scope = root && root !== document ? root : (document.body || document);

  return Array.from(scope?.querySelectorAll("main, section, article, div, p, span") || [])
    .filter(isVisible)
    .filter(isInViewport)
    .map((el) => el.innerText || el.textContent || "")
    .filter(Boolean)
    .join("\n");
}

function isInViewport(el) {
  const rect = el.getBoundingClientRect();
  const width = window.innerWidth || document.documentElement.clientWidth;
  const height = window.innerHeight || document.documentElement.clientHeight;

  return rect.bottom >= 0
    && rect.right >= 0
    && rect.top <= height
    && rect.left <= width;
}

function setNativeValue(element, value) {
  const prototype = Object.getPrototypeOf(element);
  const descriptor = Object.getOwnPropertyDescriptor(prototype, "value");

  if (descriptor?.set) {
    descriptor.set.call(element, value);
  } else {
    element.value = value;
  }
}

function looksLikeIncompleteAnthropicToolCall(text) {
  const value = String(text || "").trim();

  if (!value.includes("<invoke") && !value.includes("<function_calls")) {
    return false;
  }

  const invokeOpens = (value.match(/<invoke\b/gi) || []).length;
  const invokeCloses = (value.match(/<\/invoke>/gi) || []).length;

  if (invokeOpens > invokeCloses) {
    return true;
  }

  if (value.includes("<function_calls>") && !value.includes("</function_calls>")) {
    return true;
  }

  const paramOpens = (value.match(/<parameter\b/gi) || []).length;
  const paramCloses = (value.match(/<\/parameter>/gi) || []).length;

  return paramOpens > paramCloses;
}

function isIncompleteToolCallText(text) {
  const trimmed = String(text || "").trim();

  if (!trimmed.startsWith("{") || !/"type"\s*:\s*"tool_call"/.test(trimmed)) {
    return false;
  }

  try {
    const parsed = JSON.parse(trimmed);
    return !(parsed?.type === "tool_call" && parsed.tool);
  } catch {
    return true;
  }
}

function wait(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

if (globalThis.__O1_CODE_BRIDGE_TEST_HOOKS__ && globalThis.process?.versions?.node) {
  globalThis.__o1CodeBridgeContentTest = {
    recordCanCompleteOnIdle,
    recordLooksLikeIncompleteToolCall,
    shouldReturnCapturedRecord,
    shouldReturnStuckCapturedRecord,
    responseWaitDeadline,
    isChatReadyForNextMessage,
    inspectChatState,
    inspectAssistantUi,
    scrapeTokenPill,
    pickTokenPill,
    findAssistantUiError,
    findAssistantUiWarning,
    shouldReturnCapturedRecordDespiteAssistantUiError,
    shouldTreatAssistantUiErrorAsFatal,
    updateRecorderStatus,
    recorderStatus,
    isInViewport,
    isCompleteJson,
    findSendButton,
    findSendAffordance,
    findStopButton,
    waitForChatReady,
    submitPrompt,
    textareaStillContainsPrompt,
    attachImages,
    buildBridgeDiagnostics,
    matchThinkingText,
    hasIncompleteNetworkRecord,
    findImageFileInput,
    findAttachmentControl,
    fileFromImageInput,
    waitForAttachmentReady,
    isAttachmentReady,
    hasFreshDecodedThumbnail,
    hasUploadProgressIndicator,
    composerImageFingerprints,
    ATTACH_BUTTON_LABEL,
    STOP_BUTTON_LABEL,
    pickNetworkRecord,
    shouldReturnDomFallback,
    domRecordFromSnapshot,
    latestAssistantMessageSnapshot,
    isNewAssistantMessage,
    normalizeAssistantMessageText,
    deepQueryAll,
    agentLabelMatches,
    composedClosest,
    activateElement,
    findModelPill,
    findModelPickerRoot,
    findAgentSearchInput,
    findAgentOption,
    findAgentOptionCard,
    ensureAgentSelected,
    networkRecords,
    nextProgressFrame,
    registerProgressRun,
    closeProgressJob,
    forwardProgressRecord,
    handleControllerMessage,
    emitToController,
    progressDispatchers
  };
}
})();
