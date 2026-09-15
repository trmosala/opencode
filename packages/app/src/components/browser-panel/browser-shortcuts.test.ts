import { expect, test } from "bun:test"
import { browserShortcut } from "@/browser-panel"

test("browser shortcuts support Control and Command without consuming ordinary typing", () => {
  const input = { ctrlKey: true, metaKey: false, altKey: false, shiftKey: false }
  expect(browserShortcut({ ...input, key: "L" })).toBe("address")
  expect(browserShortcut({ ...input, key: "t" })).toBe("new")
  expect(browserShortcut({ ...input, key: "t", shiftKey: true })).toBe("reopen")
  expect(browserShortcut({ ...input, key: "w" })).toBe("close")
  expect(browserShortcut({ ...input, key: "r" })).toBe("reload")
  expect(browserShortcut({ ...input, key: "Tab" })).toBe("next")
  expect(browserShortcut({ ...input, key: "Tab", shiftKey: true })).toBe("previous")
  expect(browserShortcut({ ...input, key: "l", ctrlKey: false, metaKey: true })).toBe("address")
  expect(browserShortcut({ ...input, key: "l", ctrlKey: false })).toBeUndefined()
  expect(browserShortcut({ ...input, key: "l", altKey: true })).toBeUndefined()
  expect(browserShortcut({ ...input, key: "w", shiftKey: true })).toBeUndefined()
  expect(browserShortcut({ ...input, key: "c" })).toBeUndefined()
})
