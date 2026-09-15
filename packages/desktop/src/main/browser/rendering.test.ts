import { expect, test } from "bun:test"
import type { DriverContents } from "./driver"
import { keepBrowserRendering } from "./rendering"

test("overlapping capture and input restore throttling after the last operation", () => {
  const contents: DriverContents = {
    backgroundThrottling: true,
    isDestroyed: () => false,
    getURL: () => "about:blank",
    loadURL: async () => {},
    debugger: { isAttached: () => true, attach: () => {}, sendCommand: async () => undefined },
  }
  const capture = keepBrowserRendering(contents)
  const input = keepBrowserRendering(contents)
  expect(contents.backgroundThrottling).toBe(false)
  capture()
  expect(contents.backgroundThrottling).toBe(false)
  input()
  expect(contents.backgroundThrottling).toBe(true)
})
