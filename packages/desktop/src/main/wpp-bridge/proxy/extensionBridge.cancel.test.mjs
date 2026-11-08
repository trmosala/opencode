import { expect, test } from "bun:test"
import { ExtensionBridge } from "./extensionBridge.mjs"

test("deadline cancellation prevents late worker actions", async () => {
  const bridge = new ExtensionBridge()
  const gate = Promise.withResolvers()
  let receivedSignal
  let lateAction = false
  /** @type {Promise<unknown> | undefined} */
  let work
  bridge.poolFor = () => ({
    run: (_job, _progress, signal) => {
      receivedSignal = signal
      work = (async () => {
        await gate.promise
        if (signal.aborted) return { ok: false }
        lateAction = true
        return { ok: true }
      })()
      return work
    },
  })
  const error = await bridge.run("offline synthetic prompt", { timeoutMs: 10 }).catch((error) => error)
  expect(error.type).toBe("o1_code_extension_timeout")
  expect(bridge.recentJobs.at(-1).state).toBe("expired")
  expect(receivedSignal?.aborted).toBe(true)
  gate.resolve()
  await work
  expect(lateAction).toBe(false)
})
