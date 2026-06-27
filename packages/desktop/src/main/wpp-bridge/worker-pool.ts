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
import { cleanupWindowOnFailure, classifyWppAuthState, wppAuthRequiredError } from "./worker-startup"
import { selectWorkerSlot, shouldReapWorker, type WorkerView } from "./worker-slot"
import { SpawnGate } from "./spawn-gate"

const IDLE_WORKER_TTL_MS = 10 * 60 * 1000
const REAP_INTERVAL_MS = 60 * 1000
// Total workers stay unbounded (one job per worker = full parallelism); this only caps how many
// heavy spawns (page load + CDP inject + SSO + bridge wait) run at once so a burst doesn't open
// every authenticated window simultaneously. A grow past the cap waits for a slot, never fails.
const MAX_CONCURRENT_SPAWNS = Math.max(1, Number(process.env.O1_CODE_MAX_SPAWNS) || 3)

type Worker = {
  id: number
  window: BrowserWindow
  controller: Controller
  agent: string
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
  }

  // Acquire + run + release in one call — the single entry point a caller (extensionBridge) needs.
  // The agent string doubles as the affinity key; content.js reselects the composer pill to match.
  async run(
    job: { id?: string; payload?: { model?: string } },
    onProgress?: (frame: ProgressFrame) => void,
  ): Promise<unknown> {
    const worker = await this.acquire(String(job.payload?.model || "OgilvyOneCoder").trim())
    try {
      return await worker.controller.runJob(job, onProgress)
    } finally {
      this.release(worker.id)
    }
  }

  // Reserve a worker for `agent`, spawning one when no matching idle worker is available. Spawns
  // are gated by spawnGate so a concurrent burst opens windows in waves, not all at once.
  // ponytail: select->claim is kept await-free so single-threaded JS serializes it — that, not a
  // mutex, is what prevents two callers double-booking one free worker. Do NOT insert an await
  // between selectWorkerSlot and claim() or the race becomes real.
  async acquire(agent: string): Promise<Worker> {
    this.prune()
    let slot = selectWorkerSlot(this.view(), agent)
    if (slot.action === "reuse") return this.claim(slot.id, agent)

    await this.spawnGate.acquire()
    try {
      // A worker may have freed (or been spawned for this agent) while we waited for a spawn slot.
      this.prune()
      slot = selectWorkerSlot(this.view(), agent)
      if (slot.action === "reuse") return this.claim(slot.id, agent)

      const worker = await this.spawn(agent)
      worker.busy = true
      return worker
    } finally {
      this.spawnGate.release()
    }
  }

  private claim(id: number, agent: string): Worker {
    const worker = this.workers.get(id)!
    worker.busy = true
    worker.agent = agent
    return worker
  }

  release(id: number) {
    const worker = this.workers.get(id)
    if (!worker) return
    worker.busy = false
    worker.lastUsed = Date.now()
  }

  destroy() {
    clearInterval(this.reapTimer)
    for (const worker of this.workers.values()) {
      if (!worker.window.isDestroyed()) worker.window.destroy()
    }
    this.workers.clear()
  }

  // Recorder + controller must be installed BEFORE the first navigation: both register
  // Page.addScriptToEvaluateOnNewDocument, the document-start hook that arms the fetch/XHR recorder
  // and the relay before any page script runs. Navigating after install is what makes that hold.
  private async spawn(agent: string): Promise<Worker> {
    const window = createWorkerWindow()
    return cleanupWindowOnFailure(window, async () => {
      await installRecorder(window.webContents)
      const controller = await installController(window.webContents)
      await window.webContents.loadURL(this.chatUrl)
      await throwIfAuthRequired(window.webContents)
      await openAssistantPopover(window.webContents)
      await waitForAssistantBridge(window.webContents, controller)

      const worker: Worker = {
        id: window.webContents.id,
        window,
        controller,
        agent,
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
      if (worker.window.isDestroyed()) {
        this.workers.delete(id)
      } else if (shouldReapWorker(worker, now, IDLE_WORKER_TTL_MS)) {
        worker.window.destroy()
        this.workers.delete(id)
      }
    }
  }

  private view(): WorkerView[] {
    return Array.from(this.workers.values(), (worker) => ({
      id: worker.id,
      agent: worker.agent,
      busy: worker.busy,
      lastUsed: worker.lastUsed,
    }))
  }
}

async function openAssistantPopover(contents: BrowserWindow["webContents"]) {
  const deadline = Date.now() + 30000

  while (Date.now() < deadline) {
    const state = await contents.executeJavaScript(`
      (() => {
        const iframe = document.querySelector("#assistant-iframe");
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
  while (Date.now() < deadline) {
    const state = await controller.inspectChat(2000).catch(() => null) as { ok?: boolean; ready?: boolean } | null
    if (state?.ok && state.ready) return
    await wait(500)
  }
  await throwIfAuthRequired(contents)
  throw new Error("Timed out waiting for WPP AI Assistant bridge readiness.")
}

async function throwIfAuthRequired(contents: BrowserWindow["webContents"]) {
  const state = await readStartupAuthState(contents)
  const reason = classifyWppAuthState(state)
  if (reason) throw wppAuthRequiredError(reason, state)
}

async function readStartupAuthState(contents: BrowserWindow["webContents"]) {
  const text = await contents.executeJavaScript(`
    (() => String(document.body?.innerText || document.documentElement?.innerText || ""))()
  `, true).catch(() => "")
  return { url: contents.getURL(), text: String(text || "") }
}

function wait(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}
