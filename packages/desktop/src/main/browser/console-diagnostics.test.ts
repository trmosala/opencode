import { expect, test } from "bun:test"
import { EventEmitter, getEventListeners } from "node:events"
import { observeConsole } from "./console-diagnostics"

test("console observation counts severity without retaining message or source payloads", async () => {
  const contents = new EventEmitter()
  const secret = "correct horse battery staple"
  const source = "https://user:password@example.test/private?token=secret"
  const pending = observeConsole(contents, 250, () => {})
  contents.emit("console-message", { params: { level: "error", message: secret, sourceId: source } })
  contents.emit("console-message", { params: { level: "warning", message: secret, sourceId: source } })
  contents.emit("console-message", { params: { level: "info", message: secret, sourceId: source } })
  contents.emit("console-message", { params: { level: "debug", message: secret, sourceId: source } })
  contents.emit("console-message", { params: { level: "unknown", message: secret, sourceId: source } })
  const result = await pending
  expect(result).toEqual({ durationMs: 250, debug: 1, info: 1, warning: 1, error: 1, other: 1, total: 5 })
  expect(JSON.stringify(result)).not.toContain(secret)
  expect(JSON.stringify(result)).not.toContain(source)
  expect(getEventListeners(contents, "console-message")).toHaveLength(0)
})

test("console observation checks authority per event and always cleans up", async () => {
  const contents = new EventEmitter()
  let valid = true
  const pending = observeConsole(contents, 250, () => {
    if (!valid) throw new Error("stale")
  })
  valid = false
  contents.emit("console-message", {
    params: { level: "error", message: "never retained", sourceId: "https://example.test/" },
  })
  await expect(pending).rejects.toThrow("stale")
  expect(getEventListeners(contents, "console-message")).toHaveLength(0)
})
