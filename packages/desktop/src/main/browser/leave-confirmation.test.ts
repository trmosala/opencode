import assert from "node:assert/strict"
import { describe, it } from "bun:test"
import { createLeaveConfirmation } from "./leave-confirmation"

describe("leave confirmation", () => {
  it("keeps the event loop responsive and coalesces concurrent confirmations", async () => {
    const answer = Promise.withResolvers<boolean>()
    let calls = 0
    let progress = 0
    const confirmation = createLeaveConfirmation({
      check: () => {},
      ask: () => {
        calls++
        return answer.promise
      },
    })
    const first = confirmation.confirm()
    const second = confirmation.confirm()
    await new Promise((resolve) => setTimeout(resolve, 0))
    progress++
    assert.equal(progress, 1)
    assert.equal(calls, 1)
    answer.resolve(false)
    assert.deepEqual(await Promise.all([first, second]), [false, false])
  })

  it("revalidates authority after the asynchronous answer", async () => {
    const answer = Promise.withResolvers<boolean>()
    let valid = true
    const confirmation = createLeaveConfirmation({
      check: () => {
        if (!valid) throw new Error("revoked")
      },
      ask: () => answer.promise,
    })
    const pending = confirmation.confirm()
    valid = false
    answer.resolve(true)
    assert.equal(await pending, false)
  })

  it("chooses Stay when Leave was not approved", async () => {
    const confirmation = createLeaveConfirmation({
      check: () => {},
      ask: async () => false,
    })
    assert.equal(await confirmation.confirm(), false)
  })

  it("returns Leave only while the captured authority remains valid", async () => {
    const confirmation = createLeaveConfirmation({
      check: () => {},
      ask: async () => true,
    })
    assert.equal(await confirmation.confirm(), true)
  })

  it("dismisses on cancellation but waits for the native dialog to settle", async () => {
    const controller = new AbortController()
    const answer = Promise.withResolvers<boolean>()
    let signal: AbortSignal | undefined
    let settled = false
    const confirmation = createLeaveConfirmation({
      check: () => {},
      signal: controller.signal,
      ask: (value) => {
        signal = value
        return answer.promise
      },
    })
    const pending = confirmation.confirm().then((leave) => {
      settled = true
      return leave
    })
    controller.abort()
    assert.equal(signal?.aborted, true)
    await Promise.resolve()
    assert.equal(settled, false, "Cancellation must not release a still-open native dialog")
    answer.resolve(true)
    assert.equal(await pending, false, "Late Leave cannot override cancellation")
  })

  it("actively dismisses a waiting dialog when closure-based authority is lost", async () => {
    let valid = true
    const aborted = Promise.withResolvers<void>()
    const confirmation = createLeaveConfirmation({
      check: () => {
        if (!valid) throw Error("Task changed")
      },
      ask: (signal) =>
        new Promise<boolean>((resolve) => {
          signal.addEventListener("abort", () => {
            aborted.resolve()
            resolve(false)
          })
        }),
    })
    const pending = confirmation.confirm()
    valid = false
    const timer = setTimeout(() => aborted.reject(Error("No cancellation")), 500)
    try {
      await aborted.promise
    } finally {
      clearTimeout(timer)
    }
    assert.equal(await pending, false)
  })

  it("uses the original absolute deadline while waiting", async () => {
    const aborted = Promise.withResolvers<void>()
    const answer = Promise.withResolvers<boolean>()
    const confirmation = createLeaveConfirmation({
      check: () => {},
      deadline: Date.now() + 30,
      ask: (signal) => {
        signal.addEventListener("abort", () => aborted.resolve())
        return answer.promise
      },
    })
    const pending = confirmation.confirm()
    await aborted.promise
    answer.resolve(true)
    assert.equal(await pending, false)
  })

  it("never opens a dialog for expired or already-canceled authority", async () => {
    for (const control of [{ deadline: Date.now() - 1 }, { signal: AbortSignal.abort() }]) {
      let shown = false
      const confirmation = createLeaveConfirmation({
        ...control,
        check: () => {},
        ask: async () => {
          shown = true
          return true
        },
      })
      assert.equal(await confirmation.confirm(), false)
      assert.equal(shown, false)
    }
  })
})
