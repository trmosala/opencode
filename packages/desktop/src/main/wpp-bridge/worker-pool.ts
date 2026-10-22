// SAFETY: Electron/CDP and injected page replies own these optional fields; the guards below classify them before use.
/* oxlint-disable no-restricted-globals -- Reflection reads browser-owned records at the capture boundary. */
// Worker-window pool — the Electron port of the MV3 background.js tab pool. Each worker is one
// hidden BrowserWindow (session.ts) hosting an authenticated WPP assistant page, with the recorder
// and controller relay installed at document-start. The pool runs one job per worker, so parallel
// sub-agents fan out instead of serializing.
//
// Soft per-agent affinity mirrors background.js acquireFreeTab: prefer a free worker already pinned
// to the requested agent (or an untagged one); else grow the pool so the agent gets its own worker;
// affinity is in-memory only — durable affinity + last-good chat URL persistence is handoff item 3.

import type { BrowserWindow } from "electron"
import { createHash } from "node:crypto"
import { diagnosticUrl, observeWorkerWindow, writeWorkerLog, type WorkerLogWriter } from "./worker-logging"
import { createWorkerWindow } from "./session"
import { hideWorkerWindow, showWorkerWindow } from "./worker-preview"
import { openAssistantPanel } from "./assistant-panel"
import { agentChatProjectId, openAgentChat } from "./agent-chat"
import { armTargetAttach } from "./cdp-targets"
import { installController, type Controller, type ProgressFrame } from "./controller-injection"
import { installRecorder } from "./recorder-injection"
import { installNetworkWitness, type NetworkWitness } from "./cdp-network-recorder"
import { captureFailureError, captureHealth, decideCaptureVerdict } from "./capture-verdict"
import { awaitCdpWitnessSettle, shouldAwaitCdpFinish } from "./cdp-witness-wait"
import {
  cleanupWindowOnFailure,
  classifyWppAuthState,
  classifyWppProjectAccessState,
  classifyWppSessionProbe,
  isWppFrameUrl,
  loadWorkerProject,
  wppAuthRequiredError,
  wppProjectAccessError,
} from "./worker-startup"
import { selectWorkerSlot, shouldReapWorker, ttlForWorker, type WorkerView } from "./worker-slot"
import { SpawnGate } from "./spawn-gate"
import { assertCapabilityResponse, buildCapabilityProbeJob } from "./proxy/protocol.mjs"
import { DEFAULT_AGENT_NAME } from "./proxy/modelProfiles.mjs"
import { resetThread } from "./proxy/sessionThreads.mjs"
import { artifactTargetDir, persistArtifacts } from "./artifact-resolver"
import { wppImagePrompts } from "./artifact-capture"

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
  protocolEndpoint?: string
  // The OpenCode session this worker's WPP tab is pinned to ("" = unpinned). Set on claim so later
  // turns of the same session reuse the same authenticated thread.
  sessionKey: string
  // True when sessionKey is a sub-agent (child) session — drives the shorter reap TTL (see prune).
  subagent: boolean
  busy: boolean
  lastUsed: number
}

export type WorkerPoolOptions = { chatUrl: string; chatMode?: "assistant" | "agent"; log?: WorkerLogWriter }

export class WorkerPool {
  private readonly workers = new Map<number, Worker>()
  private readonly startingWorkers = new Map<number, Pick<Worker, "window" | "agent" | "sessionKey" | "subagent">>()
  private readonly chatMode: "assistant" | "agent"
  private readonly chatUrl: string
  private readonly log?: WorkerLogWriter
  private readonly jobs = new Map<number, { runId?: string; jobId?: string }>()
  private readonly reapTimer: NodeJS.Timeout
  private readonly spawnGate = new SpawnGate(MAX_CONCURRENT_SPAWNS)

  constructor(options: WorkerPoolOptions) {
    this.chatUrl = options.chatUrl
    this.chatMode = options.chatMode ?? "assistant"
    this.log = options.log
    this.reapTimer = setInterval(() => this.prune(), REAP_INTERVAL_MS)
    this.reapTimer.unref()
    livePools.add(this)
  }

  // Show or hide every live worker window to match the current visibility flag. Driven by the runtime
  // toggle (toggleWorkerWindows); spawn() applies the flag to newly created workers itself.
  applyWorkerVisibility() {
    // Include windows still loading WPP so the toggle can reveal a stalled startup.
    for (const worker of [...this.startingWorkers.values(), ...this.workers.values()]) {
      if (worker.window.isDestroyed()) continue

      if (workersVisible) {
        showWorkerWindow(worker.window, workerTitle(worker.agent, worker.sessionKey, worker.subagent))
      } else {
        hideWorkerWindow(worker.window)
      }
    }
  }

  // Acquire + run + release in one call — the single entry point a caller (extensionBridge) needs.
  // The agent string doubles as the affinity key; the dedicated chat must match it exactly.
  async run(
    job: {
      id?: string
      runId?: string
      createdAtMs?: number
      timeoutMs?: number
      payload?: {
        model?: string
        sessionKey?: string
        subagent?: boolean
        continueThread?: boolean
        directory?: string
      }
    },
    onProgress?: (frame: ProgressFrame) => void,
    signal?: AbortSignal,
  ): Promise<unknown> {
    const queuedAt = Date.now()

    const worker = await this.acquire(
      (job.payload?.model || DEFAULT_AGENT_NAME).trim(),
      (job.payload?.sessionKey || "").trim(),
      job.payload?.subagent === true,
      signal,
      job,
    )

    this.jobs.set(worker.id, { runId: job.runId, jobId: job.id })
    this.record(worker.id, "job-started", {
      queueMs: Date.now() - queuedAt,
      mode: job.payload?.continueThread ? "continue" : "fresh",
    })
    const correlation = { workerId: worker.id, jobId: job.id, runId: job.runId }

    try {
      try {
        await withClientAbort(this.ensureProtocolCapability(worker, job), signal)
      } catch (error) {
        this.discard(worker.id, "protocol-failed")
        throw error
      }

      throwIfClientAborted(signal)
      const startedAt = Date.now()
      this.record(worker.id, "protocol-ready", {})
      // Do not pin protocolEndpoint onto the job: the probe often learns /v1/chat while the live
      // turn hits *.lambda-url…/, and pageRecorder's expectedEndpoint gate would drop the Fetch.
      const result = await withClientAbort(worker.controller.runJob(job, onProgress, remainingJobTimeout(job)), signal)
      this.record(worker.id, "job-result", {
        durationMs: Date.now() - startedAt,
        ok: result && typeof result === "object" ? Reflect.get(result, "ok") : null,
        type: result && typeof result === "object" ? Reflect.get(result, "type") : null,
      })

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

        if (isPreSubmitFailureType(failureType)) {
          this.discard(worker.id, failureType)
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

        const captureTimedOut =
          diagnostics && typeof diagnostics === "object" && Reflect.get(diagnostics, "phase") === "no-network-response"

        if (!captureTimedOut) return { ...result, worker: correlation }
      }

      const sinceMs = submissionStartedAt(result, startedAt)
      let witness = worker.netWitness.summarizeWindow(sinceMs)

      // content.js may time out a beat before Network.loadingFinished on a slow stream — wait for
      // CDP progress before labeling unfinished-stream / capture failure.
      if (shouldAwaitCdpFinish(result, witness)) {
        witness = await withClientAbort(
          awaitCdpWitnessSettle(() => worker.netWitness.summarizeWindow(sinceMs)),
          signal,
        )
      }

      const enriched = attachCaptureVerdict(result, witness)
      this.record(worker.id, "capture-verdict", {
        accepted: enriched.captureVerdict.accept,
        capture: {
          ...enriched.result.capture,
          cdpUrl: enriched.result.capture.cdpUrl ? diagnosticUrl(enriched.result.capture.cdpUrl) : null,
        },
      })

      if (enriched.captureVerdict.accept) {
        const finalText = Reflect.get(enriched.result, "finalText")
        const prompts = typeof finalText === "string" ? wppImagePrompts(finalText) : []
        const artifacts = await worker.netWitness.collectArtifacts(sinceMs, signal, remainingJobTimeout(job), prompts)
        const images = await persistArtifacts(artifacts, artifactTargetDir(job.payload?.directory), { signal })
        throwIfClientAborted(signal)
        if (images.length !== artifacts.length)
          throw Object.assign(new Error("Could not download every image generated by WPP."), {
            type: "wpp_image_download_failed",
            statusCode: 502,
          })
        return { ...enriched.result, images, worker: correlation }
      }

      this.discard(worker.id, "capture-rejected")
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
      const type = error && typeof error === "object" ? Reflect.get(error, "type") : undefined
      this.record(worker.id, "job-failed", { type: type ?? "unknown", durationMs: Date.now() - queuedAt }, "error")

      if (error && typeof error === "object") Object.assign(error, { worker: correlation })

      if (type === "o1_code_client_aborted" || isPreSubmitFailureType(type)) {
        this.discard(worker.id, type)
      }

      throw error
    } finally {
      this.release(worker.id)
      this.jobs.delete(worker.id)
    }
  }

  // Reserve a worker for `agent`, spawning one when no matching idle worker is available. Spawns
  // are gated by spawnGate so a concurrent burst opens windows in waves, not all at once.
  // ponytail: select->claim is kept await-free so single-threaded JS serializes it — that, not a
  // mutex, is what prevents two callers double-booking one free worker. Do NOT insert an await
  // between selectWorkerSlot and claim() or the race becomes real.
  async acquire(
    agent: string,
    sessionKey = "",
    subagent = false,
    signal?: AbortSignal,
    job?: { id?: string; runId?: string },
  ): Promise<Worker> {
    // Wait out a busy same-session tab before adopting/growing, so concurrent turns of one session
    // never fork its WPP thread. The loop re-selects each poll (the tab may free, be reaped, or the
    // session may still be busy); a "wait" past the deadline falls through to the spawn path.
    const waitDeadline = Date.now() + SESSION_WAIT_TIMEOUT_MS
    const queuedAt = Date.now()

    for (;;) {
      throwIfClientAborted(signal)
      this.prune()
      const slot = selectWorkerSlot(this.view(), agent, sessionKey)

      if (slot.action === "reuse") {
        const worker = this.claim(slot.id, agent, sessionKey, subagent)
        this.record(worker.id, "worker-reused", { runId: job?.runId, jobId: job?.id, queueMs: Date.now() - queuedAt })

        return worker
      }

      if (slot.action === "wait" && Date.now() - queuedAt < SESSION_WAIT_POLL_MS) {
        this.record(slot.id, "waiting-for-worker", { runId: job?.runId, jobId: job?.id })
      }

      if (slot.action !== "wait" || Date.now() >= waitDeadline) break
      await withClientAbort(wait(SESSION_WAIT_POLL_MS), signal)
    }

    await this.spawnGate.acquire(signal).catch((error) => {
      throwIfClientAborted(signal)
      throw error
    })

    try {
      throwIfClientAborted(signal)
      // A worker may have freed (or been spawned for this agent) while we waited for a spawn slot.
      // A still-busy same-session tab now reads as "wait" here; we do NOT keep polling under the gate
      // (that would hold a spawn slot idle) — spawn a fresh thread instead, the same timeout fallback.
      this.prune()
      const slot = selectWorkerSlot(this.view(), agent, sessionKey)

      if (slot.action === "reuse") {
        const worker = this.claim(slot.id, agent, sessionKey, subagent)
        this.record(worker.id, "worker-reused", { runId: job?.runId, jobId: job?.id, queueMs: Date.now() - queuedAt })

        return worker
      }

      const worker = await this.spawn(agent, sessionKey, subagent, signal, job)

      if (signal?.aborted) {
        this.discard(worker.id, "o1_code_client_aborted")
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

    if (worker.agent !== agent) {
      worker.protocolAgent = ""
      worker.protocolEndpoint = undefined
    }

    worker.agent = agent

    if (sessionKey) worker.sessionKey = sessionKey
    // Classification follows the turn that claimed the worker: an adopted unpinned worker takes the
    // current turn's tier, and a pinned worker keeps its session's tier across reuse.
    worker.subagent = subagent

    if (workersVisible && !worker.window.isDestroyed()) {
      showWorkerWindow(worker.window, workerTitle(worker.agent, worker.sessionKey, worker.subagent))
    }

    return worker
  }

  release(id: number) {
    const worker = this.workers.get(id)

    if (!worker) return
    worker.busy = false
    worker.lastUsed = Date.now()
    this.record(id, "worker-released", {})
  }

  private discard(id: number, reason = "discarded") {
    const worker = this.workers.get(id)

    if (!worker) return
    this.record(id, "worker-discarded", { reason })

    if (!worker.window.isDestroyed()) worker.window.destroy()
    this.workers.delete(id)
    resetThread(worker.sessionKey)
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
    // The handshake checks the WPP instruction installed on the agent, which a fresh chat in the same
    // tab does not change. Probe once per worker and agent; claim() clears the result on an agent
    // switch. A continued thread cannot be probed in place, so an unverified one fails for replay.
    if (worker.protocolAgent === agent) return
    if (job.payload?.continueThread === true) assertCapabilityResponse(null, agent)

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
    const request = result && typeof result === "object" ? Reflect.get(result, "request") : undefined
    const endpoint = request && typeof request === "object" ? Reflect.get(request, "endpoint") : undefined
    const url = typeof endpoint === "string" ? URL.parse(endpoint) : null
    worker.protocolEndpoint = url ? url.origin + url.pathname : undefined
  }

  destroy() {
    clearInterval(this.reapTimer)
    livePools.delete(this)

    for (const [id, worker] of this.startingWorkers) {
      this.record(id, "worker-discarded", { reason: "pool-destroyed-during-startup" })

      if (!worker.window.isDestroyed()) worker.window.destroy()
    }

    this.startingWorkers.clear()

    for (const worker of this.workers.values()) {
      this.record(worker.id, "worker-discarded", { reason: "pool-destroyed" })

      if (!worker.window.isDestroyed()) worker.window.destroy()
      resetThread(worker.sessionKey)
    }

    this.workers.clear()
    this.jobs.clear()
  }

  // Recorder + controller + network witness register installers first; armTargetAttach then enables
  // paused auto-attach so every child iframe gets the full set before page scripts run. Navigating
  // only after arm is what makes the document-start fetch/XHR patch hold.
  private async spawn(
    agent: string,
    sessionKey: string,
    subagent: boolean,
    signal?: AbortSignal,
    job?: { id?: string; runId?: string },
  ): Promise<Worker> {
    throwIfClientAborted(signal)
    const window = createWorkerWindow()
    const id = window.webContents.id
    this.startingWorkers.set(id, { window, agent, sessionKey, subagent })
    this.jobs.set(id, { runId: job?.runId, jobId: job?.id })
    const startedAt = Date.now()
    const stage = (phase: string) => this.record(id, "startup-stage", { phase, elapsedMs: Date.now() - startedAt })
    observeWorkerWindow(window.webContents, (event, details, level) => this.record(id, event, details, level))
    stage("created")

    if (workersVisible) {
      showWorkerWindow(window, workerTitle(agent, sessionKey, subagent))
    }

    return cleanupWindowOnFailure(window, async () => {
      stage("installing-recorder")
      await withClientAbort(
        installRecorder(window.webContents, (event) => {
          if (
            event.type === "O1_CODE_BRIDGE_RECORDER_STATUS" &&
            ["ready", "reset", "request", "observed"].includes(event.status ?? "")
          ) {
            this.record(id, "recorder-status", { status: event.status })
          }
        }),
        signal,
      )
      stage("installing-controller")
      const controller = await withClientAbort(installController(window.webContents, this.chatMode), signal)
      stage("installing-network-witness")
      const netWitness = await withClientAbort(installNetworkWitness(window.webContents), signal)
      stage("arming-targets")
      await withClientAbort(armTargetAttach(window.webContents), signal)
      stage("loading-project")
      await loadWorkerProject(window.webContents, this.chatUrl, 240000, signal, this.chatMode)
      stage("checking-auth")
      await withClientAbort(throwIfAuthRequired(window.webContents), signal)
      const target = URL.parse(this.chatUrl)
      const loaded = URL.parse(window.webContents.getURL())

      if (
        !target ||
        loaded?.origin !== target.origin ||
        loaded.pathname.replace(/\/$/, "") !== target.pathname.replace(/\/$/, "")
      ) {
        const error = new Error("o1_code_wrong_project")
        Object.assign(error, { type: "o1_code_wrong_project" })
        Object.assign(error, { statusCode: 400 })
        throw error
      }

      stage(this.chatMode === "agent" ? "opening-agent-chat" : "opening-assistant-panel")
      await (
        this.chatMode === "agent"
          ? openAgentChat(window.webContents, agent, { signal, projectId: agentChatProjectId(this.chatUrl) })
          : openAssistantPanel(window.webContents, { signal })
      ).catch(async (error) => {
        throwIfClientAborted(signal)
        await withClientAbort(throwIfAuthRequired(window.webContents), signal)
        throw error
      })
      stage("waiting-for-composer")
      await waitForAssistantBridge(window.webContents, controller, signal)
      throwIfClientAborted(signal)

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
      stage("ready")

      return worker
    })
      .catch((error) => {
        this.record(
          id,
          "startup-failed",
          {
            type: error && typeof error === "object" ? (Reflect.get(error, "type") ?? "unknown") : "unknown",
            elapsedMs: Date.now() - startedAt,
          },
          "error",
        )

        if (error && typeof error === "object")
          Object.assign(error, { worker: { workerId: id, runId: job?.runId, jobId: job?.id } })
        this.jobs.delete(id)
        throw error
      })
      .finally(() => this.startingWorkers.delete(id))
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

      if (!worker.window.isDestroyed() && !shouldReapWorker(worker, now, ttl)) continue
      this.record(id, "worker-discarded", {
        reason: worker.window.isDestroyed() ? "window-destroyed" : "idle-timeout",
        idleMs: now - worker.lastUsed,
        ttlMs: ttl,
      })

      if (!worker.window.isDestroyed()) worker.window.destroy()
      this.workers.delete(id)
      // A retired tab's thread is gone; its mirror must not survive to fake a continue.
      resetThread(worker.sessionKey)
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

  private record(id: number, event: string, details: Record<string, unknown>, level?: "info" | "warn" | "error") {
    const worker = this.workers.get(id) ?? this.startingWorkers.get(id)
    writeWorkerLog(
      id,
      event,
      {
        workerId: id,
        agent: worker?.agent,
        ownerId: worker?.sessionKey ? createHash("sha256").update(worker.sessionKey).digest("hex").slice(0, 16) : null,
        subagent: worker?.subagent,
        ...this.jobs.get(id),
        ...details,
        ...(typeof details.url === "string" ? { url: diagnosticUrl(details.url) } : {}),
      },
      level,
      this.log,
    )
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
  Object.assign(error, { statusCode: 499 })
  Object.assign(error, { type: "o1_code_client_aborted" })

  return error
}

function throwIfClientAborted(signal?: AbortSignal) {
  if (signal?.aborted) throw clientAbortedError()
}

function isPreSubmitFailureType(type: unknown): type is string {
  return (
    typeof type === "string" &&
    [
      "o1_code_recorder_not_armed",
      "o1_code_thread_desync",
      "o1_code_greeting_not_settled",
      "o1_code_fresh_chat_failed",
      "o1_code_image_attachment_desync",
    ].includes(type)
  )
}

function remainingJobTimeout(job: { createdAtMs?: number; timeoutMs?: number }) {
  if (!job.timeoutMs) return undefined

  return Math.max(1, job.timeoutMs - (Date.now() - (job.createdAtMs ?? Date.now())))
}

function attachCaptureVerdict(result: unknown, witness: ReturnType<NetworkWitness["summarizeWindow"]>) {
  const value = result && typeof result === "object" ? (result as Record<string, unknown>) : {}

  const recorder =
    value.recorder && typeof value.recorder === "object" ? (value.recorder as { requestCount?: number }) : null

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

type StartupContents = Pick<BrowserWindow["webContents"], "executeJavaScript" | "getURL"> & {
  mainFrame: Pick<BrowserWindow["webContents"]["mainFrame"], "framesInSubtree">
}

export function submissionStartedAt(result: unknown, earliest: number) {
  if (!result || typeof result !== "object") return Infinity
  const diagnostics = Reflect.get(result, "diagnostics")

  const submitted =
    Reflect.get(result, "submitted") ??
    (diagnostics && typeof diagnostics === "object" ? Reflect.get(diagnostics, "submitted") : undefined)

  const at = submitted && typeof submitted === "object" ? Reflect.get(submitted, "startedAtMs") : undefined

  return typeof at === "number" && Number.isFinite(at) && at >= earliest && at <= Date.now() ? at : Infinity
}

async function waitForAssistantBridge(
  contents: BrowserWindow["webContents"],
  controller: Controller,
  signal?: AbortSignal,
) {
  // Slow links can still be downloading assistant assets after the project shell is ready.
  const deadline = Date.now() + 240000
  // Require the composer to report ready for two CONSECUTIVE polls before declaring the bridge
  // usable. inspectChat runs inside the assistant iframe, so its readiness reflects the real chat
  // composer (the only cross-origin-safe truth — the host-page iframe.src attribute is stale under
  // SPA routing). A single transient "ready" can be seen mid-redirect, after which the navigation
  // wipes the composer we then fill → post-login submit_or_ui_failure. Stability debounces that.
  let stable = 0

  while (Date.now() < deadline) {
    throwIfClientAborted(signal)

    const state = (await withClientAbort(
      controller.inspectChat(2000).catch(() => null),
      signal,
    )) as { ok?: boolean; ready?: boolean } | null

    if (state?.ok && state.ready) {
      stable += 1

      if (stable >= 2) return
    } else {
      stable = 0
    }

    await withClientAbort(wait(500), signal)
  }

  throwIfClientAborted(signal)
  await throwIfAuthRequired(contents)
  throw new Error("Timed out waiting for WPP AI Assistant bridge readiness.")
}

async function throwIfAuthRequired(contents: StartupContents) {
  const state = await readStartupAuthState(contents)
  const accessReason = classifyWppProjectAccessState(state)

  if (accessReason) throw wppProjectAccessError(accessReason, state)
  const reason = classifyWppAuthState(state)

  if (reason) throw wppAuthRequiredError(reason, state)
}

async function readStartupAuthState(contents: StartupContents) {
  const frames = contents.mainFrame.framesInSubtree.filter((frame) => isWppFrameUrl(frame.url))

  const texts = await Promise.all(
    frames.map((frame) =>
      frame
        .executeJavaScript(
          `
    (() => String(document.body?.innerText || document.documentElement?.innerText || ""))()
  `,
          true,
        )
        .catch(() => ""),
    ),
  )

  return { url: contents.getURL(), text: texts.map((text) => (typeof text === "string" ? text : "")).join("\n") }
}

// Post-failure logout probe (checkAuthState). Pass 1: classify every WPP frame's URL + visible text
// — catches a hard logout and a sign-in UI rendered inside the composer iframe. Pass 2: re-fetch
// each frame's own document from inside that frame — catches the soft logout where dead cookies
// leave the cached SPA shell rendering normally (no login URL, no sign-in text anywhere). Each
// frame's location.href is post-redirect, so a redirect or 401/403 on the re-fetch is decisive.
async function probeWppAuthState(contents: BrowserWindow["webContents"]): Promise<string | null> {
  const frames = contents.mainFrame.framesInSubtree.filter((frame) => isWppFrameUrl(frame.url))

  for (const frame of frames) {
    const text = await frame
      .executeJavaScript(
        `
      (() => String(document.body?.innerText || document.documentElement?.innerText || ""))()
    `,
        true,
      )
      .catch(() => "")

    const reason = classifyWppAuthState({ url: frame.url, text: String(text || "") })

    if (reason) return reason
  }

  for (const frame of frames) {
    const probe = await frame
      .executeJavaScript(
        `
      fetch(location.href, { credentials: "include", cache: "no-store", redirect: "manual" })
        .then((res) => ({ status: res.status, type: res.type }))
        .catch(() => null)
    `,
        true,
      )
      .catch(() => null)

    const reason = classifyWppSessionProbe(probe)

    if (reason) return reason
  }

  return null
}

function wait(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}
