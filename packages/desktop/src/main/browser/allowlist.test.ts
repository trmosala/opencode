import { expect, test } from "bun:test"
import { allowed, updateAgentHost } from "./allowlist"

test("fixture host policy starts from the defaults and applies edits in memory", () => {
  expect(allowed("http://localhost:5173/")).toBe(true)
  expect(allowed("https://example.com/")).toBe(false)
  updateAgentHost("example.com")
  expect(allowed("https://sub.example.com/page")).toBe(true)
  expect(allowed("https://notexample.com")).toBe(false)
  updateAgentHost("example.com", true)
  expect(allowed("https://sub.example.com")).toBe(false)
  updateAgentHost("localhost", true)
  expect(allowed("http://localhost:5173/")).toBe(false)
  updateAgentHost("localhost")
  expect(allowed("http://localhost:5173/")).toBe(true)
  for (const host of ["https://example.com", "*.com", "example.com/path", "example.com:443", ""])
    expect(() => updateAgentHost(host)).toThrow()
})
