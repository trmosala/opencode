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
})
