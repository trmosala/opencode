// Pure worker-pool acquisition decision, split out from worker-pool.ts so it loads without the
// Electron runtime: worker-pool.ts pulls in session.ts's runtime `electron` import, which Bun
// can't evaluate outside Electron, so a test importing the pool directly fails to load. Mirrors
// the three tiers of background.js acquireFreeTab.

export type WorkerView = { id: number; agent: string; busy: boolean; lastUsed: number }

export type Slot =
  | { action: "reuse"; id: number }
  | { action: "grow" }

// Which worker (if any) runs the next job for `agent`: prefer a free worker already pinned to the
// agent (or an untagged one); else grow so parallel jobs never fail on a local tab cap.
export function selectWorkerSlot(workers: WorkerView[], agent: string): Slot {
  const free = workers
    .filter((worker) => !worker.busy)
    .sort((a, b) => a.lastUsed - b.lastUsed)

  const preferred = (agent ? free.find((worker) => worker.agent === agent) : undefined)
    ?? free.find((worker) => !worker.agent)
  if (preferred) return { action: "reuse", id: preferred.id }

  return { action: "grow" }
}

export function shouldReapWorker(worker: WorkerView, now: number, idleTtlMs: number) {
  return !worker.busy && now - worker.lastUsed >= idleTtlMs
}
