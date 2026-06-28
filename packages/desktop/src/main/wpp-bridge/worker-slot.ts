// Pure worker-pool acquisition decision, split out from worker-pool.ts so it loads without the
// Electron runtime: worker-pool.ts pulls in session.ts's runtime `electron` import, which Bun
// can't evaluate outside Electron, so a test importing the pool directly fails to load. Mirrors
// the three tiers of background.js acquireFreeTab.

export type WorkerView = {
  id: number
  agent: string
  sessionKey?: string
  // True when this worker serves a sub-agent (child) session rather than a top-level interactive
  // one. Sub-agents are throw-away, so the pool reaps their pinned tabs on a shorter TTL.
  subagent?: boolean
  busy: boolean
  lastUsed: number
}

export type Slot =
  | { action: "reuse"; id: number }
  | { action: "grow" }

// Which worker (if any) runs the next job. A `sessionKey` pins a worker to one OpenCode session so
// its WPP thread holds that session's context across turns: the session's own pinned tab is reused
// first, and a tab pinned to a *different* session is never stolen (that would corrupt its thread).
// Otherwise adopt an unpinned worker, preferring the requested agent (or an untagged one); else grow
// so parallel jobs never fail on a local tab cap.
export function selectWorkerSlot(workers: WorkerView[], agent: string, sessionKey?: string): Slot {
  const free = workers
    .filter((worker) => !worker.busy)
    .sort((a, b) => a.lastUsed - b.lastUsed)

  if (sessionKey) {
    const pinned = free.find((worker) => worker.sessionKey === sessionKey)
    if (pinned) return { action: "reuse", id: pinned.id }
  }

  const adoptable = free.filter((worker) => !worker.sessionKey)
  const preferred = (agent ? adoptable.find((worker) => worker.agent === agent) : undefined)
    ?? adoptable.find((worker) => !worker.agent)
  if (preferred) return { action: "reuse", id: preferred.id }

  return { action: "grow" }
}

export function shouldReapWorker(worker: WorkerView, now: number, idleTtlMs: number) {
  return !worker.busy && now - worker.lastUsed >= idleTtlMs
}

// Idle TTL for a worker by its pin tier. Unpinned workers are pure LRU scratch (shortest reuse
// window is fine). A session-pinned tab holds that session's WPP thread, so it earns a long grace —
// unless it serves a throw-away sub-agent, which never resumes once done and so is reaped sooner.
export function ttlForWorker(
  worker: WorkerView,
  ttls: { idle: number; pinned: number; subagent: number },
): number {
  if (!worker.sessionKey) return ttls.idle
  return worker.subagent ? ttls.subagent : ttls.pinned
}
