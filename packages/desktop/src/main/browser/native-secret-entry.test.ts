import { describe, expect, test } from "bun:test"
import { nativeSecretEntryName, nativeSecretEntryPath } from "./native-secret-entry"

describe("native secret entry helper", () => {
  test("selects the current-architecture Windows helper", () => {
    expect(nativeSecretEntryName("win32", "x64")).toBe("windows-entry-x64.exe")
    expect(nativeSecretEntryName("win32", "arm64")).toBe("windows-entry-arm64.exe")
  })

  test("selects the current-architecture macOS helper", () => {
    expect(nativeSecretEntryName("darwin", "x64")).toBe("macos-entry-x64")
    expect(nativeSecretEntryName("darwin", "arm64")).toBe("macos-entry-arm64")
  })

  test("does not select a bundled binary for Linux", () => {
    expect(nativeSecretEntryName("linux", "x64")).toBeUndefined()
  })

  test("Linux development uses the system native form helper", () => {
    const platform = Object.getOwnPropertyDescriptor(process, "platform")!
    Object.defineProperty(process, "platform", { value: "linux" })
    try {
      expect(nativeSecretEntryPath()).toBe("/usr/bin/zenity")
    } finally {
      Object.defineProperty(process, "platform", platform)
    }
  })
})
