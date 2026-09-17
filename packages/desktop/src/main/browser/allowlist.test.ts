import { describe, expect, test } from "bun:test"
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { DEFAULT_ALLOWLIST } from "@cookiemonster/cm-browser/protocol"
import { allowed, hostPolicyRevision, loadAllowlist, updateAgentHost } from "./allowlist"

const temp = () => join(mkdtempSync(join(tmpdir(), "cm-browser-")), "allowlist.json")

describe("loadAllowlist", () => {
  test("settings edits change the enforced hosts and reject URL or wildcard inputs", () => {
    const path = temp()
    updateAgentHost("example.com", false, path)
    expect(allowed("https://sub.example.com/page", path)).toBe(true)
    expect(allowed("https://notexample.com", path)).toBe(false)
    const before = hostPolicyRevision()
    updateAgentHost("example.com", true, path)
    expect(allowed("https://sub.example.com", path)).toBe(false)
    updateAgentHost("example.com", false, path)
    expect(allowed("https://sub.example.com", path)).toBe(true)
    expect(hostPolicyRevision()).toBe(before + 2)
    for (const host of ["https://example.com", "*.com", "example.com/path", "example.com:443", ""])
      expect(() => updateAgentHost(host, false, path)).toThrow()
  })
  test("seeds the defaults on first read", () => {
    const path = temp()
    expect(loadAllowlist(path)).toEqual(DEFAULT_ALLOWLIST)
    expect(JSON.parse(readFileSync(path, "utf8"))).toEqual([...DEFAULT_ALLOWLIST])
  })

  test("user edits win", () => {
    const path = temp()
    writeFileSync(path, JSON.stringify(["example.test"]))
    expect(loadAllowlist(path)).toEqual(["example.test"])
    expect(allowed("https://example.test/a", path)).toBe(true)
    expect(allowed("http://localhost:5173/", path)).toBe(false)
  })

  test("an empty list blocks everything without falling back to defaults", () => {
    const path = temp()
    writeFileSync(path, "[]")
    expect(loadAllowlist(path)).toEqual([])
    expect(allowed("https://teams.microsoft.com/", path)).toBe(false)
  })

  test("a malformed file falls back to defaults rather than allowing everything", () => {
    const path = temp()
    writeFileSync(path, "{ not json")
    expect(loadAllowlist(path)).toEqual(DEFAULT_ALLOWLIST)
    expect(allowed("https://evil.test/", path)).toBe(false)
    expect(allowed("https://teams.microsoft.com/", path)).toBe(true)
  })
})
