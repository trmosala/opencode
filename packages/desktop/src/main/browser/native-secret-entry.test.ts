import { describe, expect, test } from "bun:test"
import { nativeSecretEntryName } from "./native-secret-entry"

describe("native secret entry helper", () => {
  test("selects the current-architecture Windows helper", () => {
    expect(nativeSecretEntryName("win32", "x64")).toBe("windows-entry-x64.exe")
    expect(nativeSecretEntryName("win32", "arm64")).toBe("windows-entry-arm64.exe")
  })

  test("selects the current-architecture macOS helper", () => {
    expect(nativeSecretEntryName("darwin", "x64")).toBe("macos-entry-x64")
    expect(nativeSecretEntryName("darwin", "arm64")).toBe("macos-entry-arm64")
  })

  test("rejects unsupported platforms", () => {
    expect(nativeSecretEntryName("linux", "x64")).toBeUndefined()
  })
})
