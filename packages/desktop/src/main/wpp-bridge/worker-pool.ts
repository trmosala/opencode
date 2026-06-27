// Worker-window pool — the Electron port of the MV3 background.js tab pool. Each worker is one
// hidden BrowserWindow (session.ts) hosting an authenticated WPP assistant page, with the recorder
// and controller relay installed at document-start. The pool runs up to maxSize jobs concurrently,
// one per worker, so parallel sub-agents fan out instead of serializing.
//
// Soft per-agent affinity mirrors background.js acquireFreeTab: prefer a free worker already pinned
// to the requested agent (or an untagged one); else grow the pool so the agent gets its own worker;
// only when the pool is full do we re-tag the LRU free worker, which costs one composer pill switch
// in content.js. Affinity is in-memory only — durable affinity + last-good chat URL persistence is
// handoff item 3.

import type { BrowserWindow } from "electron"
import { createWorkerWindow } from "./session"
import { installController, type Controller, type ProgressFrame } from "./controller-injection"
import { installRecorder } from "./recorder-injection"
import { selectWorkerSlot, type WorkerView } from "./worker-slot"

const DEFAULT_MAX_SIZE = Math.max(1, Number(process.env.O1_CODE_MAX_TABS) || 5)

type Worker = {
  id: number
  window: BrowserWindow
  controller: Controller
  agent: string
  busy: boolean
  lastUsed: number
}

export type WorkerPoolOptions = { chatUrl: string; maxSize?: number }

export class WorkerPool {
  private readonly workers = new Map<number, Worker>()
  private readonly maxSize: number
  private readonly chatUrl: string

  constructor(options: WorkerPoolOptions) {
    this.maxSize = Math.max(1, options.maxSize ?? DEFAULT_MAX_SIZE)
    this.chatUrl = options.chatUrl
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

  // Reserve a worker for `agent`, spawning one if the pool can still grow. Throws when the pool is
  // saturated (every worker busy) — extensionBridge already caps concurrency at maxSize, so this is
  // a safety net, not the normal path.
  // ponytail: assumes serialized acquire (extensionBridge.poll's pollInProgress guard). Add a
  // reservation counter before the spawn await if a concurrent caller is ever introduced.
  async acquire(agent: string): Promise<Worker> {
    this.prune()
    const slot = selectWorkerSlot(this.view(), this.maxSize, agent)

    if (slot.action === "wait") throw new Error("WPP worker pool is full and every worker is busy.")

    if (slot.action === "grow") {
      const worker = await this.spawn(agent)
      worker.busy = true
      return worker
    }

    const worker = this.workers.get(slot.id)!
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
    await installRecorder(window.webContents)
    const controller = await installController(window.webContents)
    await window.webContents.loadURL(this.chatUrl)
    await openAssistantPopover(window.webContents)
    await waitForAssistantBridge(controller)

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
  }

  // Drop workers whose window was destroyed (closed, crashed) so a dead id is never handed out —
  // the Electron equivalent of background.js resolveOwnedTargets pruning closed tabs.
  private prune() {
    for (const [id, worker] of this.workers) {
      if (worker.window.isDestroyed()) this.workers.delete(id)
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

  throw new Error("Timed out opening WPP AI Assistant popover.")
}

async function waitForAssistantBridge(controller: Controller) {
  const deadline = Date.now() + 30000
  while (Date.now() < deadline) {
    const state = await controller.inspectChat(2000).catch(() => null) as { ok?: boolean; ready?: boolean } | null
    if (state?.ok && state.ready) return
    await wait(500)
  }
  throw new Error("Timed out waiting for WPP AI Assistant bridge readiness.")
}

function wait(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}
