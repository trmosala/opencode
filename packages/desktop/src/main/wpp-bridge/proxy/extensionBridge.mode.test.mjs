import { expect, test } from "bun:test"
import { ExtensionBridge } from "./extensionBridge.mjs"

test("mode changes retire idle workers and their continuity, but never interrupt active jobs", () => {
  const bridge = new ExtensionBridge()
  let destroyed = 0
  bridge.workerPool = { destroy: () => destroyed++, hasSession: () => true }
  expect(bridge.chatMode).toBe("assistant")
  bridge.jobs.set("running", {})
  expect(bridge.setChatMode("agent")).toBe(false)
  expect(bridge.chatMode).toBe("assistant")
  expect(destroyed).toBe(0)
  bridge.jobs.clear()
  expect(bridge.setChatMode("agent")).toBe(true)
  expect(destroyed).toBe(1)
  expect(bridge.hasSession("old")).toBe(false)
  expect(bridge.setChatMode("assistant")).toBe(true)
  expect(() => bridge.setChatMode("unknown")).toThrow("Invalid WPP chat mode")
  expect(bridge.chatMode).toBe("assistant")
})
