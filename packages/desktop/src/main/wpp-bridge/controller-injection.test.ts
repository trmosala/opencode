import { describe, expect, test } from "bun:test"
import { routeOutboundFrame, type ProgressFrame } from "./controller-injection"

type Pending = { resolve: (result: unknown) => void; reject: (error: Error) => void }

describe("routeOutboundFrame", () => {
  test("resolves and clears the awaiting request when a job result matches by requestId", () => {
    const pending = new Map<string, Pending>()
    let resolved: unknown
    pending.set("req-1", { resolve: (result) => (resolved = result), reject: () => {} })

    routeOutboundFrame(
      { type: "O1_CODE_BRIDGE_JOB_RESULT", requestId: "req-1", result: { ok: true } },
      pending,
      new Map(),
    )

    expect(resolved).toEqual({ ok: true })
    expect(pending.has("req-1")).toBe(false)
  })

  test("routes an inspect result to its awaiting request", () => {
    const pending = new Map<string, Pending>()
    let resolved: unknown
    pending.set("req-2", { resolve: (result) => (resolved = result), reject: () => {} })

    routeOutboundFrame(
      { type: "O1_CODE_BRIDGE_INSPECT_RESULT", requestId: "req-2", result: { state: "idle" } },
      pending,
      new Map(),
    )

    expect(resolved).toEqual({ state: "idle" })
    expect(pending.has("req-2")).toBe(false)
  })

  test("delivers progress frames to the job's subscriber by jobId", () => {
    const frames: ProgressFrame[] = []
    const progress = new Map<string, (frame: ProgressFrame) => void>([["job-1", (frame) => frames.push(frame)]])

    routeOutboundFrame(
      { type: "O1_CODE_BRIDGE_JOB_PROGRESS", jobId: "job-1", frame: { seq: 3, finalText: "hi" } },
      new Map(),
      progress,
    )

    expect(frames).toEqual([{ seq: 3, finalText: "hi" }])
  })

  test("does not cross a result onto the progress channel", () => {
    const frames: ProgressFrame[] = []
    const progress = new Map<string, (frame: ProgressFrame) => void>([["req-3", (frame) => frames.push(frame)]])
    const pending = new Map<string, Pending>()
    let resolved = false
    pending.set("req-3", { resolve: () => (resolved = true), reject: () => {} })

    routeOutboundFrame(
      { type: "O1_CODE_BRIDGE_JOB_RESULT", requestId: "req-3", result: {} },
      pending,
      progress,
    )

    expect(resolved).toBe(true)
    expect(frames).toEqual([])
  })

  test("ignores a result whose requestId has no waiter without throwing", () => {
    expect(() =>
      routeOutboundFrame(
        { type: "O1_CODE_BRIDGE_JOB_RESULT", requestId: "missing", result: {} },
        new Map(),
        new Map(),
      ),
    ).not.toThrow()
  })

  test("ignores a progress frame with no matching subscriber", () => {
    expect(() =>
      routeOutboundFrame(
        { type: "O1_CODE_BRIDGE_JOB_PROGRESS", jobId: "none", frame: { seq: 1, finalText: "" } },
        new Map(),
        new Map(),
      ),
    ).not.toThrow()
  })

  test("ignores an unknown frame type", () => {
    const pending = new Map<string, Pending>()
    let resolved = false
    pending.set("req-4", { resolve: () => (resolved = true), reject: () => {} })

    routeOutboundFrame({ type: "O1_CODE_BRIDGE_NETWORK_RECORD", requestId: "req-4" }, pending, new Map())

    expect(resolved).toBe(false)
    expect(pending.has("req-4")).toBe(true)
  })
})
