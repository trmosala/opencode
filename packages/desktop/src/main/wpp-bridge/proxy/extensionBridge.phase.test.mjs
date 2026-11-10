import { describe, expect, test } from "bun:test"
import { ExtensionBridge } from "./extensionBridge.mjs"

describe("ExtensionBridge progress phase", () => {
  test("records phase-only progress on the leased job for health", () => {
    const bridge = new ExtensionBridge()
    const job = {
      id: "job-1",
      type: "ask",
      createdAt: new Date().toISOString(),
      createdAtMs: Date.now(),
      timeoutMs: 900000,
      state: "leased",
      attempts: 1,
      progressPhase: null,
    }
    bridge.jobs.set(job.id, job)

    expect(bridge.pushProgress(job.id, { phase: "waiting-network" })).toMatchObject({
      ok: true,
      matched: true,
      phaseOnly: true,
    })
    expect(bridge.health().jobs[0]).toMatchObject({
      id: "job-1",
      progressPhase: "waiting-network",
    })

    expect(bridge.pushProgress(job.id, { seq: 1, finalText: "hello" })).toMatchObject({ ok: true, matched: true })
    expect(bridge.health().jobs[0].progressPhase).toBe("streaming")
  })
})
