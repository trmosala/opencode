// Pure worker-pool acquisition decision, split out from worker-pool.ts so it loads without the
// Electron runtime: worker-pool.ts pulls in session.ts's runtime `electron` import, which Bun
// can't evaluate outside Electron, so a test importing the pool directly fails to load. Mirrors
// the three tiers of background.js acquireFreeTab.

export type WorkerView = { id: number; agent: string; busy: boolean; lastUsed: number }

export type Slot =
  | { action: "reuse"; id: number }
  | { action: "grow" }
  | { action: "retag"; id: number }
  | { action: "wait" }

// Which worker (if any) runs the next job for `agent`: prefer a free worker already pinned to the
// agent (or an untagged one); else grow while capacity remains so the agent gets its own worker;
// else re-tag the LRU free worker (one composer pill switch in content.js); else wait.
export function selectWorkerSlot(workers: WorkerView[], maxSize: number, agent: string): Slot {
  const free = workers
    .filter((worker) => !worker.busy)
    .sort((a, b) => a.lastUsed - b.lastUsed)

  const preferred = (agent ? free.find((worker) => worker.agent === agent) : undefined)
    ?? free.find((worker) => !worker.agent)
  if (preferred) return { action: "reuse", id: preferred.id }

  if (workers.length < maxSize) return { action: "grow" }

  if (free.length) return { action: "retag", id: free[0].id }

  return { action: "wait" }
}
