import { describe, expect, test } from "bun:test"
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { DEFAULT_ALLOWLIST } from "@cookiemonster/cm-browser/protocol"
import { allowed, loadAllowlist } from "./allowlist"

const temp = () => join(mkdtempSync(join(tmpdir(), "cm-browser-")), "allowlist.json")

describe("loadAllowlist", () => {
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
