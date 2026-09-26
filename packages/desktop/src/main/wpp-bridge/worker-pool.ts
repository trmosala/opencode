// Worker-window pool — the Electron port of the MV3 background.js tab pool. Each worker is one
// hidden BrowserWindow (session.ts) hosting an authenticated WPP assistant page, with the recorder
// and controller relay installed at document-start. The pool runs one job per worker, so parallel
// sub-agents fan out instead of serializing.
//
// Soft per-agent affinity mirrors background.js acquireFreeTab: prefer a free worker already pinned
// to the requested agent (or an untagged one); else grow the pool so the agent gets its own worker;
// affinity is in-memory only — durable affinity + last-good chat URL persistence is handoff item 3.

import type { BrowserWindow } from "electron"
import { createWorkerWindow } from "./session"
import { installController, type Controller, type ProgressFrame } from "./controller-injection"
import { installRecorder } from "./recorder-injection"
import { installNetworkWitness, type NetworkWitness } from "./cdp-network-recorder"
import { captureFailureError, captureHealth, decideCaptureVerdict } from "./capture-verdict"
import { cleanupWindowOnFailure, classifyWppAuthState, classifyWppProjectAccessState, classifyWppSessionProbe, isWppFrameUrl, wppAuthRequiredError, wppProjectAccessError } from "./worker-startup"
import { selectWorkerSlot, shouldReapWorker, ttlForWorker, type WorkerView } from "./worker-slot"
import { SpawnGate } from "./spawn-gate"
import { assertCapabilityResponse, buildCapabilityProbeJob } from "./proxy/protocol.mjs"
import { DEFAULT_MODEL_ID } from "./proxy/modelProfiles.mjs"

const IDLE_WORKER_TTL_MS = 10 * 60 * 1000
// A session-pinned tab holds that session's WPP thread (browser-held context), so reaping it throws
// away context a continuing turn would reuse. Interactive session tabs are meant to live for the
// running app session — Electron destroys all worker windows on quit, so "reap on app close" is
// free. This long idle TTL is only a leak guard so a forgotten/abandoned session can't hold an
// authenticated window indefinitely; normal same-session turns refresh lastUsed and never hit it.
const PINNED_WORKER_TTL_MS = Math.max(30 * 60 * 1000, Number(process.env.O1_CODE_PINNED_TTL_MS) || 4 * 60 * 60 * 1000)
// Sub-agent (child-session) tabs are pinned too — so a sub-agent keeps thread continuity across its
// own multi-turn run — but a sub-agent never resumes once it returns its result, so there's no point
// holding its authenticated window for the full pinned grace. Reap it on a much shorter idle TTL.
const SUBAGENT_WORKER_TTL_MS = Math.max(60 * 1000, Number(process.env.O1_CODE_SUBAGENT_TTL_MS) || 5 * 60 * 1000)
const REAP_INTERVAL_MS = 60 * 1000
// Serialize turns of one session onto its pinned worker: when that tab is busy, a concurrent
// same-session turn waits for it instead of forking a second WPP thread. Bounded so a genuinely
// wedged turn can't block the session forever — on timeout we fall through to adopt/grow (a fresh
// thread), which is the same recovery as a lost pinned tab. Default covers the max job timeout.
const SESSION_WAIT_TIMEOUT_MS = Math.max(60 * 1000, Number(process.env.O1_CODE_SESSION_WAIT_MS) || 16 * 60 * 1000)
const SESSION_WAIT_POLL_MS = 250
// Total workers stay unbounded (one job per worker = full parallelism); this only caps how many
// heavy spawns (page load + CDP inject + SSO + bridge wait) run at once so a burst doesn't open
// every authenticated window simultaneously. A grow past the cap waits for a slot, never fails.
const MAX_CONCURRENT_SPAWNS = Math.max(1, Number(process.env.O1_CODE_MAX_SPAWNS) || 3)
// Debug: surface the normally-hidden worker windows so you can watch the serialized prompt land in
// each WPP composer and see which session each tab serves (window title = session · agent).
// Initialized from O1_CODE_SHOW_WORKERS for launch-time control, but mutable so the View ▸ "Toggle
// Worker Windows" menu item can toggle the authenticated tabs at runtime (see toggleWorkerWindows).
let workersVisible = process.env.O1_CODE_SHOW_WORKERS === "1"

// Every live pool registers here so the runtime toggle can reach each pool's worker windows. poolFor()
// destroys the old pool when the chat URL changes, so this is usually a single entry.
const livePools = new Set<WorkerPool>()

// Flip worker-window visibility and apply it to every live worker tab. Returns the new state so the
// menu action can reflect it. Newly spawned workers honor the flag on their own via spawn().
export function toggleWorkerWindows(): boolean {
  workersVisible = !workersVisible
  for (const pool of livePools) pool.applyWorkerVisibility()
  return workersVisible
}

function workerTitle(agent: string, sessionKey: string, subagent = false): string {
  return `o1-code worker — ${agent}${sessionKey ? ` · ${sessionKey}` : " · unpinned"}${subagent ? " (subagent)" : ""}`
}

type Worker = {
  id: number
  window: BrowserWindow
  controller: Controller
  netWitness: NetworkWitness
  agent: string
  // Agent for which this worker most recently passed the CM_REQUEST_V1 capability handshake.
  protocolAgent: string
  // The OpenCode session this worker's WPP tab is pinned to ("" = unpinned). Set on claim so later
  // turns of the same session reuse the same authenticated thread.
  sessionKey: string
  // True when sessionKey is a sub-agent (child) session — drives the shorter reap TTL (see prune).
  subagent: boolean
  busy: boolean
  lastUsed: number
}

export type WorkerPoolOptions = { chatUrl: string }

export class WorkerPool {
  private readonly workers = new Map<number, Worker>()
  private readonly chatUrl: string
  private readonly reapTimer: NodeJS.Timeout
  private readonly spawnGate = new SpawnGate(MAX_CONCURRENT_SPAWNS)

  constructor(options: WorkerPoolOptions) {
    this.chatUrl = options.chatUrl
    this.reapTimer = setInterval(() => this.prune(), REAP_INTERVAL_MS)
    this.reapTimer.unref()
    livePools.add(this)
  }

  // Show or hide every live worker window to match the current visibility flag. Driven by the runtime
  // toggle (toggleWorkerWindows); spawn() applies the flag to newly created workers itself.
  applyWorkerVisibility() {
    for (const worker of this.workers.values()) {
      if (worker.window.isDestroyed()) continue
      if (workersVisible) {
        worker.window.showInactive()
        worker.window.setTitle(workerTitle(worker.agent, worker.sessionKey, worker.subagent))
      } else {
        worker.window.hide()
      }
    }
  }

  // Acquire + run + release in one call — the single entry point a caller (extensionBridge) needs.
  // The agent string doubles as the affinity key; content.js reselects the composer pill to match.
  async run(
    job: {
      id?: string
      createdAtMs?: number
      timeoutMs?: number
      payload?: { model?: string; sessionKey?: string; subagent?: boolean }
    },
    onProgress?: (frame: ProgressFrame) => void,
    signal?: AbortSignal,
  ): Promise<unknown> {
    const worker = await this.acquire(
      (job.payload?.model || DEFAULT_MODEL_ID).trim(),
      (job.payload?.sessionKey || "").trim(),
      job.payload?.subagent === true,
      signal,
    )
    try {
      try {
        await withClientAbort(this.ensureProtocolCapability(worker, job), signal)
      } catch (error) {
        this.discard(worker.id)
        throw error
      }
      const startedAt = Date.now()
      const result = await withClientAbort(
        worker.controller.runJob(job, onProgress, remainingJobTimeout(job)),
        signal,
      )
      // content.js reported its OWN failure (agent selection, missing composer, chat busy, …). Surface
      // it verbatim so extensionBridge converts it to the real typed error (e.g. o1_code_wrong_agent)
      // with content.js's diagnostics. Running the capture verdict here instead would relabel every
      // such error as a generic submit_or_ui_failure and discard the real reason.
      if (result && typeof result === "object" && (result as Record<string, unknown>).ok === false) {
        // Pre-submit failures (recorder never armed, pinned thread lost, attachment state unknown)
        // mean this tab is structurally dead but NO model request was sent, so replay is duplicate-safe.
        // Discard is mandatory: a released worker stays eligible, so acquire() could re-select this same
        // dead tab on the retry and fail identically. openaiCompat.shouldRetryFreshReplay does the replay.
        const failureType = (result as Record<string, unknown>).type
        if (
          failureType === "o1_code_recorder_not_armed" ||
          failureType === "o1_code_thread_desync" ||
          failureType === "o1_code_image_attachment_desync"
        ) {
          this.discard(worker.id)
          const r = result as Record<string, unknown>
          const error = new Error(String(r.error || "O1-Code worker reported a pre-submit failure.")) as Error & {
            statusCode?: number
            type?: string
            bridgeResult?: unknown
          }
          error.statusCode = typeof r.statusCode === "number" ? r.statusCode : 502
          error.type = failureType
          error.bridgeResult = r
          throw error
        }
        const diagnostics = Reflect.get(result, "diagnostics")
        const captureTimedOut = diagnostics
          && typeof diagnostics === "object"
          && Reflect.get(diagnostics, "phase") === "no-network-response"
        if (!captureTimedOut) return result
      }
      const enriched = attachCaptureVerdict(result, worker.netWitness.summarizeWindow(startedAt))
      if (enriched.captureVerdict.accept) return enriched.result

      this.discard(worker.id)
      const error = captureFailureError(enriched.captureVerdict, enriched.result.capture)
      if (error) {
        // Surface content.js's own submit view on the failure so the log distinguishes "prompt never
        // landed in the composer" (submitted.valueLength === 0) from "typed + sent but no model
        // request fired" (valueLength > 0, sendButtonFound). Rides the already-logged bridgeResult.
        const r = enriched.result as Record<string, unknown>
        ;(error as Error & { bridgeResult?: unknown }).bridgeResult = {
          ok: r.ok ?? null,
          contentError: r.error ?? null,
          contentType: r.type ?? null,
          contentStatusCode: r.statusCode ?? null,
          submitted: r.submitted ?? null,
          recorder: r.recorder ?? null,
          responseSource: r.responseSource ?? null,
          freshChat: r.freshChat ?? null,
          diagnostics: r.diagnostics ?? null,
        }
        throw error
      }
      throw new Error("Unexpected capture verdict failure.")
    } catch (error) {
      if (error instanceof Error && Reflect.get(error, "type") === "o1_code_client_aborted") {
        this.discard(worker.id)
      }
      throw error
    } finally {
      this.release(worker.id)
    }
  }

  // Reserve a worker for `agent`, spawning one when no matching idle worker is available. Spawns
  // are gated by spawnGate so a concurrent burst opens windows in waves, not all at once.
  // ponytail: select->claim is kept await-free so single-threaded JS serializes it — that, not a
  // mutex, is what prevents two callers double-booking one free worker. Do NOT insert an await
  // between selectWorkerSlot and claim() or the race becomes real.
  async acquire(agent: string, sessionKey = "", subagent = false, signal?: AbortSignal): Promise<Worker> {
    // Wait out a busy same-session tab before adopting/growing, so concurrent turns of one session
    // never fork its WPP thread. The loop re-selects each poll (the tab may free, be reaped, or the
    // session may still be busy); a "wait" past the deadline falls through to the spawn path.
    const waitDeadline = Date.now() + SESSION_WAIT_TIMEOUT_MS
    for (;;) {
      throwIfClientAborted(signal)
      this.prune()
      const slot = selectWorkerSlot(this.view(), agent, sessionKey)
      if (slot.action === "reuse") return this.claim(slot.id, agent, sessionKey, subagent)
      if (slot.action !== "wait" || Date.now() >= waitDeadline) break
      await withClientAbort(wait(SESSION_WAIT_POLL_MS), signal)
    }

    await this.spawnGate.acquire()
    try {
      throwIfClientAborted(signal)
      // A worker may have freed (or been spawned for this agent) while we waited for a spawn slot.
      // A still-busy same-session tab now reads as "wait" here; we do NOT keep polling under the gate
      // (that would hold a spawn slot idle) — spawn a fresh thread instead, the same timeout fallback.
      this.prune()
      const slot = selectWorkerSlot(this.view(), agent, sessionKey)
      if (slot.action === "reuse") return this.claim(slot.id, agent, sessionKey, subagent)

      const worker = await this.spawn(agent, sessionKey, subagent)
      if (signal?.aborted) {
        this.discard(worker.id)
        throw clientAbortedError()
      }
      worker.busy = true
      return worker
    } finally {
      this.spawnGate.release()
    }
  }

  private claim(id: number, agent: string, sessionKey: string, subagent: boolean): Worker {
    const worker = this.workers.get(id)!
    worker.busy = true
    if (worker.agent !== agent) worker.protocolAgent = ""
    worker.agent = agent
    if (sessionKey) worker.sessionKey = sessionKey
    // Classification follows the turn that claimed the worker: an adopted unpinned worker takes the
    // current turn's tier, and a pinned worker keeps its session's tier across reuse.
    worker.subagent = subagent
    if (workersVisible && !worker.window.isDestroyed()) {
      worker.window.setTitle(workerTitle(worker.agent, worker.sessionKey, worker.subagent))
    }
    return worker
  }

  release(id: number) {
    const worker = this.workers.get(id)
    if (!worker) return
    worker.busy = false
    worker.lastUsed = Date.now()
  }

  private discard(id: number) {
    const worker = this.workers.get(id)
    if (!worker) return
    if (!worker.window.isDestroyed()) worker.window.destroy()
    this.workers.delete(id)
  }

  private async ensureProtocolCapability(
    worker: Worker,
    job: {
      id?: string
      createdAtMs?: number
      timeoutMs?: number
      payload?: { model?: string; continueThread?: boolean }
    },
  ) {
    const agent = (job.payload?.model || worker.agent).trim()
    if (job.payload?.continueThread === true) {
      if (worker.protocolAgent === agent) return
      assertCapabilityResponse(null, agent)
    }

    const probeJob = buildCapabilityProbeJob(job)
    const result = await worker.controller.runJob(probeJob, undefined, remainingJobTimeout(job))
    if (result && typeof result === "object" && Reflect.get(result, "ok") === false) {
      const rawError = Reflect.get(result, "error")
      const rawStatus = Reflect.get(result, "statusCode")
      const rawType = Reflect.get(result, "type")
      const error = new Error(
        typeof rawError === "string" ? rawError : "CookieMonster protocol capability probe failed.",
      ) as Error & {
        statusCode?: number
        type?: string
        bridgeResult?: unknown
      }
      error.statusCode = typeof rawStatus === "number" ? rawStatus : 502
      error.type = typeof rawType === "string" ? rawType : "o1_code_protocol_probe_failed"
      error.bridgeResult = result
      throw error
    }
    assertCapabilityResponse(result, agent)
    worker.protocolAgent = agent
  }

  destroy() {
    clearInterval(this.reapTimer)
    livePools.delete(this)
    for (const worker of this.workers.values()) {
      if (!worker.window.isDestroyed()) worker.window.destroy()
    }
    this.workers.clear()
  }

  // Recorder + controller must be installed BEFORE the first navigation: both register
  // Page.addScriptToEvaluateOnNewDocument, the document-start hook that arms the fetch/XHR recorder
  // and the relay before any page script runs. Navigating after install is what makes that hold.
  private async spawn(agent: string, sessionKey: string, subagent: boolean): Promise<Worker> {
    const window = createWorkerWindow()
    if (workersVisible) {
      window.showInactive()
      window.setTitle(workerTitle(agent, sessionKey, subagent))
    }
    return cleanupWindowOnFailure(window, async () => {
      await installRecorder(window.webContents)
      const controller = await installController(window.webContents)
      const netWitness = await installNetworkWitness(window.webContents)
      await window.webContents.loadURL(this.chatUrl)
      await throwIfAuthRequired(window.webContents)
      await openAssistantPopover(window.webContents)
      await waitForAssistantBridge(window.webContents, controller)

      const worker: Worker = {
        id: window.webContents.id,
        window,
        controller,
        netWitness,
        agent,
        protocolAgent: "",
        sessionKey,
        subagent,
        busy: false,
        lastUsed: Date.now(),
      }
      this.workers.set(worker.id, worker)
      return worker
    })
  }

  // Drop workers whose window was destroyed or sat idle past the TTL so a dead or stale id is never
  // handed out.
  private prune() {
    const now = Date.now()
    for (const [id, worker] of this.workers) {
      const ttl = ttlForWorker(worker, {
        idle: IDLE_WORKER_TTL_MS,
        pinned: PINNED_WORKER_TTL_MS,
        subagent: SUBAGENT_WORKER_TTL_MS,
      })
      if (worker.window.isDestroyed()) {
        this.workers.delete(id)
      } else if (shouldReapWorker(worker, now, ttl)) {
        worker.window.destroy()
        this.workers.delete(id)
      }
    }
  }

  // Best-effort login probe for openaiCompat's post-failure path: probe a live worker's page and
  // classify it as logged-out or not. Returns a reason string when the WPP session looks logged out,
  // else null. Auth is partition-wide (persist:wpp), so ANY live worker's page answers the question.
  // Probes every WPP frame (the composer is a cross-origin iframe the top frame's innerText can't
  // see) and re-fetches each frame's document to catch the soft logout where the cached SPA shell
  // keeps rendering while its cookies are dead — that state shows no login URL or sign-in text.
  // ponytail: reads an already-live worker only — it will NOT spawn one just to probe (spawn is
  // heavy, and a hard logout already surfaces as wpp_auth_required on the retry's own spawn).
  async checkAuthState(): Promise<string | null> {
    const live = Array.from(this.workers.values()).find((worker) => !worker.window.isDestroyed())
    if (!live) return null
    return probeWppAuthState(live.window.webContents).catch(() => null)
  }

  // Does a live tab pinned to this session exist? The proxy uses this to decide whether it can send
  // a delta into an existing thread instead of replaying the full transcript.
  hasSession(sessionKey: string): boolean {
    if (!sessionKey) return false
    this.prune()
    for (const worker of this.workers.values()) {
      if (worker.sessionKey === sessionKey && !worker.window.isDestroyed()) return true
    }
    return false
  }

  private view(): WorkerView[] {
    return Array.from(this.workers.values(), (worker) => ({
      id: worker.id,
      agent: worker.agent,
      sessionKey: worker.sessionKey,
      subagent: worker.subagent,
      busy: worker.busy,
      lastUsed: worker.lastUsed,
    }))
  }
}

function withClientAbort<T>(promise: Promise<T>, signal?: AbortSignal): Promise<T> {
  if (!signal) return promise
  if (signal.aborted) return Promise.reject(clientAbortedError())

  return new Promise((resolve, reject) => {
    const abort = () => reject(clientAbortedError())
    signal.addEventListener("abort", abort, { once: true })
    promise.then(resolve, reject).finally(() => signal.removeEventListener("abort", abort))
  })
}

function clientAbortedError() {
  const error = new Error("The OpenAI-compatible client disconnected before the WPP turn completed.")
  Reflect.set(error, "statusCode", 499)
  Reflect.set(error, "type", "o1_code_client_aborted")
  return error
}

function throwIfClientAborted(signal?: AbortSignal) {
  if (signal?.aborted) throw clientAbortedError()
}

function remainingJobTimeout(job: { createdAtMs?: number; timeoutMs?: number }) {
  if (!job.timeoutMs) return undefined
  return Math.max(1, job.timeoutMs - (Date.now() - (job.createdAtMs ?? Date.now())))
}

function attachCaptureVerdict(result: unknown, witness: ReturnType<NetworkWitness["summarizeWindow"]>) {
  const value = result && typeof result === "object" ? result as Record<string, unknown> : {}
  const recorder = value.recorder && typeof value.recorder === "object"
    ? value.recorder as { requestCount?: number }
    : null
  const responseSource = typeof value.responseSource === "string" ? value.responseSource : null
  const pageRecorderRequestSeen = Number(recorder?.requestCount) > 0
  const parseComplete = responseSource === "network"
  const captureVerdict = decideCaptureVerdict({ responseSource, pageRecorderRequestSeen, witness })
  const capture = captureHealth({
    responseSource,
    pageRecorderRequestSeen,
    parseComplete,
    witness,
    verdict: captureVerdict,
  })

  return {
    captureVerdict,
    result: {
      ...value,
      capture,
    },
  }
}

async function openAssistantPopover(contents: BrowserWindow["webContents"]) {
  const deadline = Date.now() + 30000

  while (Date.now() < deadline) {
    const state = await contents.executeJavaScript(`
      (() => {
        const iframe = document.querySelector("#assistant-iframe");
        // NOTE: iframe.src is the element attribute and keeps its initial /external?target=/chat
        // value even after the assistant SPA client-side-routes to /chat — so it is NOT a reliable
        // "settled on chat" signal. Settledness is gated downstream by composer readiness inside the
        // iframe (waitForAssistantBridge), which is the only cross-origin-safe truth.
        if (iframe && String(iframe.src || "").includes("open-web-assistant-cs.wpp.ai")) {
          return { open: true, src: iframe.src };
        }

        const controls = Array.from(document.querySelectorAll('[data-testid="assistant-popover-button-new"], wpp-action-button-v2-22-2, button, [role="button"]'));
        const control = controls.find((el) => /AI\\s*Assistant/i.test(el.innerText || el.textContent || el.getAttribute("aria-label") || ""));
        if (!control) return { open: false };

        const rect = control.getBoundingClientRect();
        return {
          open: false,
          click: rect.width > 0 && rect.height > 0,
          x: Math.round(rect.left + rect.width / 2),
          y: Math.round(rect.top + rect.height / 2)
        };
      })()
    `, true).catch(() => null) as { open?: boolean; click?: boolean; x?: number; y?: number } | null

    if (state?.open) return
    if (state?.click && typeof state.x === "number" && typeof state.y === "number") {
      contents.sendInputEvent({ type: "mouseMove", x: state.x, y: state.y })
      contents.sendInputEvent({ type: "mouseDown", button: "left", x: state.x, y: state.y, clickCount: 1 })
      contents.sendInputEvent({ type: "mouseUp", button: "left", x: state.x, y: state.y, clickCount: 1 })
    }
    await wait(500)
  }

  await throwIfAuthRequired(contents)
  throw new Error("Timed out opening WPP AI Assistant popover.")
}

async function waitForAssistantBridge(contents: BrowserWindow["webContents"], controller: Controller) {
  const deadline = Date.now() + 30000
  // Require the composer to report ready for two CONSECUTIVE polls before declaring the bridge
  // usable. inspectChat runs inside the assistant iframe, so its readiness reflects the real chat
  // composer (the only cross-origin-safe truth — the host-page iframe.src attribute is stale under
  // SPA routing). A single transient "ready" can be seen mid-redirect, after which the navigation
  // wipes the composer we then fill → post-login submit_or_ui_failure. Stability debounces that.
  let stable = 0
  while (Date.now() < deadline) {
    const state = await controller.inspectChat(2000).catch(() => null) as { ok?: boolean; ready?: boolean } | null
    if (state?.ok && state.ready) {
      stable += 1
      if (stable >= 2) return
    } else {
      stable = 0
    }
    await wait(500)
  }
  await throwIfAuthRequired(contents)
  throw new Error("Timed out waiting for WPP AI Assistant bridge readiness.")
}

async function throwIfAuthRequired(contents: BrowserWindow["webContents"]) {
  const state = await readStartupAuthState(contents)
  const accessReason = classifyWppProjectAccessState(state)
  if (accessReason) throw wppProjectAccessError(accessReason, state)
  const reason = classifyWppAuthState(state)
  if (reason) throw wppAuthRequiredError(reason, state)
}

async function readStartupAuthState(contents: BrowserWindow["webContents"]) {
  const frames = contents.mainFrame.framesInSubtree.filter((frame) => isWppFrameUrl(frame.url))
  const texts = await Promise.all(frames.map((frame) => frame.executeJavaScript(`
    (() => String(document.body?.innerText || document.documentElement?.innerText || ""))()
  `, true).catch(() => "")))
  return { url: contents.getURL(), text: texts.map((text) => typeof text === "string" ? text : "").join("\n") }
}

// Post-failure logout probe (checkAuthState). Pass 1: classify every WPP frame's URL + visible text
// — catches a hard logout and a sign-in UI rendered inside the composer iframe. Pass 2: re-fetch
// each frame's own document from inside that frame — catches the soft logout where dead cookies
// leave the cached SPA shell rendering normally (no login URL, no sign-in text anywhere). Each
// frame's location.href is post-redirect, so a redirect or 401/403 on the re-fetch is decisive.
async function probeWppAuthState(contents: BrowserWindow["webContents"]): Promise<string | null> {
  const frames = contents.mainFrame.framesInSubtree.filter((frame) => isWppFrameUrl(frame.url))

  for (const frame of frames) {
    const text = await frame.executeJavaScript(`
      (() => String(document.body?.innerText || document.documentElement?.innerText || ""))()
    `, true).catch(() => "")
    const reason = classifyWppAuthState({ url: frame.url, text: String(text || "") })
    if (reason) return reason
  }

  for (const frame of frames) {
    const probe = await frame.executeJavaScript(`
      fetch(location.href, { credentials: "include", cache: "no-store", redirect: "manual" })
        .then((res) => ({ status: res.status, type: res.type }))
        .catch(() => null)
    `, true).catch(() => null)
    const reason = classifyWppSessionProbe(probe)
    if (reason) return reason
  }

  return null
}

function wait(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}
