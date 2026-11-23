import { describe, expect, test } from "bun:test"
import { resolve } from "node:path"
import { pathToFileURL } from "node:url"
import { launchesProgram, resolveExternalURL, resolveLocalFilePath } from "./external-url"

describe("external URLs", () => {
  test("opens web URLs externally", () => {
    expect(resolveExternalURL("https://example.com/a?b=c")).toBe("https://example.com/a?b=c")
    expect(resolveExternalURL("http://example.com")).toBe("http://example.com/")
  })

  test("opens mail links externally", () => {
    expect(resolveExternalURL("mailto:hello@opencode.ai")).toBe("mailto:hello@opencode.ai")
  })

  test("rejects file URLs and unsupported protocols", () => {
    expect(resolveExternalURL("file:///tmp/index.html")).toBeUndefined()
    expect(resolveExternalURL("javascript:alert(1)")).toBeUndefined()
    expect(resolveExternalURL("data:text/html,hello")).toBeUndefined()
    expect(resolveExternalURL("not a url")).toBeUndefined()
  })

  test("resolves only local file URLs", () => {
    const path = resolve("example.html")
    expect(resolveLocalFilePath(pathToFileURL(path).href)).toBe(path)
    expect(resolveLocalFilePath("file://example.com/share/index.html")).toBeUndefined()
    expect(resolveLocalFilePath("https://example.com/index.html")).toBeUndefined()
  })
})

describe("local program detection", () => {
  test("treats executables, scripts, installers and shortcuts as programs on every platform", () => {
    for (const path of [
      "C:\\Users\\me\\setup.EXE",
      "/tmp/run.sh",
      "/tmp/x.bat",
      "/tmp/x.cmd",
      "/tmp/x.ps1",
      "/tmp/x.vbs",
      "/tmp/x.js",
      "/tmp/x.msi",
      "/tmp/x.lnk",
      "/Applications/Evil.app",
      "/tmp/x.command",
      "/tmp/x.desktop",
      "/tmp/x.AppImage",
      "/tmp/x.jar",
    ])
      for (const platform of ["darwin", "linux", "win32"] as const)
        expect(launchesProgram([path], 0o644, path.endsWith(".app"), platform)).toBe(true)
  })

  test("checks the resolved target too and POSIX execute bits on files only", () => {
    expect(launchesProgram(["/tmp/notes.txt", "/tmp/payload.sh"], 0o644, false, "darwin")).toBe(true)
    expect(launchesProgram(["/tmp/tool"], 0o755, false, "darwin")).toBe(true)
    expect(launchesProgram(["/tmp/tool"], 0o755, false, "linux")).toBe(true)
    expect(launchesProgram(["C:\\tmp\\notes.txt"], 0o755, false, "win32")).toBe(false)
    expect(launchesProgram(["/tmp/project"], 0o755, true, "darwin")).toBe(false)
    expect(launchesProgram(["/tmp/report.pdf"], 0o644, false, "linux")).toBe(false)
    expect(launchesProgram(["/tmp/index.html"], 0o644, false, "darwin")).toBe(false)
    expect(launchesProgram(["/tmp/three.js"], 0o755, true, "darwin")).toBe(false)
    expect(launchesProgram(["C:\\repos\\tool.py"], 0o755, true, "win32")).toBe(false)
    expect(launchesProgram(["/Volumes/share/report.pdf"], 0o777, false, "darwin")).toBe(false)
    expect(launchesProgram(["/Volumes/share/install"], 0o777, false, "darwin")).toBe(true)
  })
})
