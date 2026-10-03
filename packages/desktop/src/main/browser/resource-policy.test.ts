import { describe, expect, test } from "bun:test"
import { browserResourceBlocker, type BrowserResourceState } from "./resource-policy"

const inactive: BrowserResourceState = {
  active: false,
  loading: false,
  pinned: false,
  granted: false,
  busy: false,
  transferring: false,
  media: false,
  unsaved: false,
  unknown: false,
}

describe("inactive tab resource protection", () => {
  test("an explicitly requested inactive clean tab can be unloaded", () => {
    expect(browserResourceBlocker(inactive)).toBeUndefined()
  })

  test.each([
    ["active", "active"],
    ["loading", "loading"],
    ["pinned", "pinned"],
    ["granted", "granted"],
    ["busy", "busy"],
    ["transferring", "transfer"],
    ["media", "media"],
    ["unsaved", "unsaved"],
    ["unknown", "unknown"],
  ] as const)("protects %s pages", (field, reason) => {
    expect(browserResourceBlocker({ ...inactive, [field]: true })).toBe(reason)
  })
})
