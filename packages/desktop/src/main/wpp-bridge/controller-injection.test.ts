import { describe, expect, test } from "bun:test"
import vm from "node:vm"
import {
  controllerRouteActive,
  rejectPendingRequests,
  routeOutboundFrame,
  snapshotClipboard,
  type ProgressFrame,
} from "./controller-injection"

type Pending = { resolve: (result: unknown) => void; reject: (error: Error) => void }

describe("snapshotClipboard", () => {
  test("materializes all formats before the clipboard is overwritten", async () => {
    const original = {
      "text/plain": new Blob(["original text"]),
      "text/html": new Blob(["<b>original text</b>"]),
      "image/png": new Blob([new Uint8Array([137, 80, 78, 71])]),
      "web application/x-custom": new Blob([new Uint8Array([0, 255, 1])]),
      "electron application/bookmark": { title: "Example", url: "https://example.com" },
    }
    const live = new Map<string, Blob | Electron.ClipboardBookmark>(Object.entries(original))
    const saved = await snapshotClipboard([
      {
        types: [...live.keys()],
        async getType(type) {
          await Promise.resolve()
          const value = live.get(type)
          if (!value) throw new Error("clipboard was overwritten")
          return value
        },
      },
    ])
    live.clear()

    expect(saved).toEqual([original])
    const text = saved[0]["text/plain"]
    const custom = saved[0]["web application/x-custom"]
    if (!(text instanceof Blob) || !(custom instanceof Blob)) throw new Error("expected blob payloads")
    expect(await text.text()).toBe("original text")
    expect(await custom.bytes()).toEqual(new Uint8Array([0, 255, 1]))
  })

  test("preserves an empty clipboard", async () => {
    expect(await snapshotClipboard([])).toEqual([])
  })

  test("propagates read failures before the paste can overwrite the clipboard", async () => {
    await expect(
      snapshotClipboard([
        {
          types: ["text/plain"],
          async getType() {
            throw new Error("clipboard read failed")
          },
        },
      ]),
    ).rejects.toThrow("clipboard read failed")
  })
})

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

    routeOutboundFrame({ type: "O1_CODE_BRIDGE_JOB_RESULT", requestId: "req-3", result: {} }, pending, progress)

    expect(resolved).toBe(true)
    expect(frames).toEqual([])
  })

  test("ignores a result whose requestId has no waiter without throwing", () => {
    expect(() =>
      routeOutboundFrame({ type: "O1_CODE_BRIDGE_JOB_RESULT", requestId: "missing", result: {} }, new Map(), new Map()),
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

test("rejects every pending request when the worker renderer exits", () => {
  const errors: Error[] = []
  const pending = new Map<string, Pending>([
    ["req-1", { resolve: () => {}, reject: (error) => errors.push(error) }],
    ["req-2", { resolve: () => {}, reject: (error) => errors.push(error) }],
  ])

  rejectPendingRequests(pending, new Error("worker exited"))

  expect(errors.map((error) => error.message)).toEqual(["worker exited", "worker exited"])
  expect(pending.size).toBe(0)
})

describe("dedicated controller route", () => {
  test("accepts only the current dedicated document and route token", async () => {
    const window = { __wppBridgeControllerRoute: "current" }
    const context = vm.createContext({ window })
    const frame = {
      url: "https://open-web-agent-builder-cs.wpp.ai/chat/project/foundational?resultId=turn",
      executeJavaScript: async (code: string) => vm.runInContext(code, context),
    }
    const contents = { mainFrame: { framesInSubtree: [frame] } }
    const route = { frame, token: "current", active: true }
    expect(await controllerRouteActive(contents, route)).toBe(true)
    expect(await controllerRouteActive(contents, { ...route, token: "stale" })).toBe(false)
    expect(await controllerRouteActive(contents, { ...route, active: false })).toBe(false)
    window.__wppBridgeControllerRoute = ""
    expect(await controllerRouteActive(contents, route)).toBe(false)
  })

  test("rejects replacement frames, duplicate chats and the assistant side panel", async () => {
    const frame = {
      url: "https://open-web-agent-builder-cs.wpp.ai/chat/project/foundational",
      executeJavaScript: async () => true,
    }
    const route = { frame, token: "current", active: true }
    expect(await controllerRouteActive({ mainFrame: { framesInSubtree: [{ ...frame }] } }, route)).toBe(false)
    await expect(
      controllerRouteActive({ mainFrame: { framesInSubtree: [frame, { ...frame }] } }, route),
    ).rejects.toThrow("o1_code_thread_desync")
    await expect(
      controllerRouteActive(
        { mainFrame: { framesInSubtree: [{ ...frame, url: "https://open-web-assistant-cs.wpp.ai/chat" }] } },
        route,
      ),
    ).rejects.toThrow("o1_code_thread_desync")
  })

  test("rejects cancellation while document validation is in flight", async () => {
    const pending = Promise.withResolvers<unknown>()
    const frame = {
      url: "https://open-web-agent-builder-cs.wpp.ai/chat/project/foundational",
      executeJavaScript: () => pending.promise,
    }
    const route = { frame, token: "current", active: true }
    const check = controllerRouteActive({ mainFrame: { framesInSubtree: [frame] } }, route)
    route.active = false
    pending.resolve(true)
    expect(await check).toBe(false)
  })
})
