import { expect, test } from "bun:test"
import { getEventListeners } from "node:events"
import type { OnCompletedListenerDetails, OnErrorOccurredListenerDetails, WebRequest, WebRequestFilter } from "electron"
import { observeNetwork } from "./network-diagnostics"

function fixture() {
  let completed: ((details: OnCompletedListenerDetails) => void) | null = null
  let failed: ((details: OnErrorOccurredListenerDetails) => void) | null = null
  const installs = { completed: 0, failed: 0 }
  const fault: { method?: "onCompleted" | "onErrorOccurred" } = {}
  const webRequest: Pick<WebRequest, "onCompleted" | "onErrorOccurred"> = {
    onCompleted: (
      _filter: WebRequestFilter | ((details: OnCompletedListenerDetails) => void) | null,
      listener?: ((details: OnCompletedListenerDetails) => void) | null,
    ) => {
      completed = listener ?? null
      if (listener) installs.completed++
      if (listener && fault.method === "onCompleted") throw new Error("secret registration failure")
    },
    onErrorOccurred: (
      _filter: WebRequestFilter | ((details: OnErrorOccurredListenerDetails) => void) | null,
      listener?: ((details: OnErrorOccurredListenerDetails) => void) | null,
    ) => {
      failed = listener ?? null
      if (listener) installs.failed++
      if (listener && fault.method === "onErrorOccurred") throw new Error("secret registration failure")
    },
  }
  const frame = { detached: false }
  const contents = { id: 7, mainFrame: frame, isDestroyed: () => false }
  const emit = (extra: Record<string, unknown> = {}, error = false) => {
    const details = { webContentsId: 7, frame, resourceType: "xhr", statusCode: 200, ...extra }
    if (error) failed?.(details as unknown as OnErrorOccurredListenerDetails)
    else completed?.(details as unknown as OnCompletedListenerDetails)
  }
  return { webRequest, contents, frame, emit, installs, fault, handlers: () => [completed, failed] as const }
}

test("network counts status classes and failures without accessing rich payloads", async () => {
  const f = fixture()
  const pending = observeNetwork(f.webRequest, f.contents, 250, () => {})
  const event = { webContentsId: 7, frame: f.frame, resourceType: "xhr", statusCode: 200 }
  for (const key of [
    "url",
    "referrer",
    "method",
    "id",
    "timestamp",
    "responseHeaders",
    "requestHeaders",
    "uploadData",
    "error",
    "statusLine",
    "fromCache",
    "webContents",
  ])
    Object.defineProperty(event, key, {
      get: () => {
        throw new Error("secret must not be read")
      },
    })
  f.handlers()[0]?.(event as OnCompletedListenerDetails)
  const failure = { webContentsId: 7, frame: f.frame, resourceType: "xhr" }
  for (const key of ["statusCode", "url", "error", "referrer", "responseHeaders"])
    Object.defineProperty(failure, key, {
      get: () => {
        throw new Error("failure payload must not be read")
      },
    })
  f.handlers()[1]?.(failure as OnErrorOccurredListenerDetails)
  for (const statusCode of [101, 204, 302, 404, 503, 0]) f.emit({ statusCode })
  f.emit({}, true)
  expect(await pending).toEqual({
    durationMs: 250,
    http1xx: 1,
    http2xx: 2,
    http3xx: 1,
    http4xx: 1,
    http5xx: 1,
    other: 1,
    failed: 2,
    total: 9,
  })
  expect(f.handlers()).toEqual([null, null])
})

test("network requires exact live frame and tab attribution, excluding other resource types", async () => {
  const f = fixture()
  const pending = observeNetwork(f.webRequest, f.contents, 250, () => {})
  for (const extra of [
    { webContentsId: 8 },
    { webContentsId: undefined },
    { frame: undefined },
    { frame: null },
    { frame: { detached: false } },
    { frame: { detached: true } },
    { resourceType: "mainFrame" },
    { resourceType: "image" },
    { resourceType: "webSocket" },
  ])
    f.emit(extra)
  f.emit()
  expect((await pending).total).toBe(1)
})

test("shared Session installs once, cancel-one preserves another and other Sessions", async () => {
  const f = fixture(),
    other = fixture()
  const controller = new AbortController()
  const first = observeNetwork(f.webRequest, f.contents, 250, () => {}, controller.signal)
  const second = observeNetwork(f.webRequest, f.contents, 250, () => {})
  const independent = observeNetwork(other.webRequest, other.contents, 250, () => {})
  expect(f.installs).toEqual({ completed: 1, failed: 1 })
  controller.abort()
  await expect(first).rejects.toThrow("Network observation unavailable")
  expect(getEventListeners(controller.signal, "abort")).toHaveLength(0)
  expect(f.handlers().every(Boolean)).toBe(true)
  f.emit()
  other.emit({}, true)
  expect((await second).total).toBe(1)
  expect((await independent).failed).toBe(1)
  expect(f.handlers()).toEqual([null, null])
  expect(other.handlers()).toEqual([null, null])
})

test("authority is checked before event getters", async () => {
  const f = fixture()
  let valid = true
  let accessed = false
  const stale = observeNetwork(f.webRequest, f.contents, 250, () => {
    if (!valid) throw new Error("secret authority error")
  })
  valid = false
  const event = {
    get webContentsId() {
      accessed = true
      return 7
    },
  }
  f.handlers()[0]?.(event as OnCompletedListenerDetails)
  await expect(stale).rejects.toThrow("Network observation unavailable")
  expect(accessed).toBe(false)
  const second = observeNetwork(f.webRequest, f.contents, 250, () => {})
  f.emit()
  expect((await second).total).toBe(1)
})

test("stale subscriber and malformed event cleanup preserve another tab and another Session handler", async () => {
  const f = fixture(),
    other = fixture()
  let valid = true
  let foreign = 0
  other.webRequest.onCompleted({ urls: ["http://*/*"] }, () => {
    foreign++
  })
  const handler = other.handlers()[0]
  const first = observeNetwork(f.webRequest, f.contents, 250, () => {
    if (!valid) throw new Error("stale")
  })
  const second = observeNetwork(f.webRequest, { ...f.contents, id: 8 }, 250, () => {})
  valid = false
  f.emit({ webContentsId: 8 })
  await expect(first).rejects.toThrow("Network observation unavailable")
  expect((await second).total).toBe(1)
  const broken = observeNetwork(f.webRequest, f.contents, 250, () => {})
  const event = {
    webContentsId: 7,
    frame: f.frame,
    resourceType: "xhr",
    get statusCode(): number {
      throw new Error("secret")
    },
  }
  f.handlers()[0]?.(event as OnCompletedListenerDetails)
  await expect(broken).rejects.toThrow("Network observation unavailable")
  expect(f.handlers()).toEqual([null, null])
  expect(other.handlers()[0]).toBe(handler)
  other.emit()
  expect(foreign).toBe(1)
})

test("monotonic cutoff excludes late events even while timers are blocked", async () => {
  const f = fixture()
  const pending = observeNetwork(f.webRequest, f.contents, 250, () => {})
  f.emit()
  const end = performance.now() + 270
  while (performance.now() < end) {
    /* Deliberately prevent timer dispatch. */
  }
  f.emit()
  expect((await pending).total).toBe(1)
  expect(f.handlers()).toEqual([null, null])
})

test("detachment, replacement and authority loss at settlement fail closed", async () => {
  for (const change of ["detach", "replace", "authority"] as const) {
    const f = fixture()
    let valid = true
    const pending = observeNetwork(f.webRequest, f.contents, 250, () => {
      if (!valid) throw new Error("stale")
    })
    f.emit()
    if (change === "detach") f.frame.detached = true
    if (change === "replace") f.contents.mainFrame = { detached: false }
    if (change === "authority") valid = false
    await expect(pending).rejects.toThrow("Network observation unavailable")
    expect(f.handlers()).toEqual([null, null])
  }
})

test.each(["onCompleted", "onErrorOccurred"] as const)(
  "%s registration exception rolls back handlers and allows retry",
  async (method) => {
    const f = fixture()
    f.fault.method = method
    await expect(observeNetwork(f.webRequest, f.contents, 250, () => {})).rejects.toThrow(
      "Network observation unavailable",
    )
    expect(f.handlers()).toEqual([null, null])
    f.fault.method = undefined
    expect((await observeNetwork(f.webRequest, f.contents, 250, () => {})).total).toBe(0)
  },
)

test("invalid duration, initially stale authority and pre-abort never install listeners", async () => {
  const f = fixture()
  for (const duration of [0, 249, 5001, 250.5, NaN, Infinity])
    await expect(observeNetwork(f.webRequest, f.contents, duration, () => {})).rejects.toThrow()
  await expect(
    observeNetwork(f.webRequest, f.contents, 250, () => {
      throw new Error("stale")
    }),
  ).rejects.toThrow()
  await expect(observeNetwork(f.webRequest, f.contents, 250, () => {}, AbortSignal.abort())).rejects.toThrow()
  expect(f.installs).toEqual({ completed: 0, failed: 0 })
})
