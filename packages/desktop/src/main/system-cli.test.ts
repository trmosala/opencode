import { afterEach, expect, test } from "bun:test"
import assert from "node:assert/strict"
import { execFile } from "node:child_process"
import { mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { promisify } from "node:util"
import { hasSystemCli } from "./system-cli-capability"

const roots: string[] = []

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

test.each([
  { name: "app-only package", metadata: { cmSystemCli: false }, expected: false },
  { name: "Windows system CLI package", metadata: { cmSystemCli: true }, expected: true },
  { name: "unbranded package without capability", metadata: {}, expected: true },
])("reads system CLI capability for $name", async ({ metadata, expected }) => {
  const root = await mkdtemp(join(tmpdir(), "cm-system-cli-"))
  roots.push(root)
  await writeFile(join(root, "package.json"), JSON.stringify(metadata))

  expect(await hasSystemCli(root)).toBe(expected)
})

test("does not enable system CLI when the package manifest cannot be read or parsed", async () => {
  const root = await mkdtemp(join(tmpdir(), "cm-system-cli-"))
  roots.push(root)

  await assert.rejects(hasSystemCli(root))
  await writeFile(join(root, "package.json"), "{")
  await assert.rejects(hasSystemCli(root), SyntaxError)
})

const execFileAsync = promisify(execFile)
const script = join(import.meta.dir, "../../resources/windows/cli-path.ps1")
const owned = "C:\\Program Files\\CookieMonster\\resources\\cli"

test.skipIf(process.platform !== "win32")("validates a command's real exit code without changing PATH", async () => {
  const run = (command: string) =>
    execFileAsync(
      join(process.env.SystemRoot ?? "C:\\Windows", "System32", "WindowsPowerShell", "v1.0", "powershell.exe"),
      [
        "-NoLogo",
        "-NoProfile",
        "-NonInteractive",
        "-File",
        script,
        "-Action",
        "Validate",
        "-OwnedPath",
        owned,
        "-CliPath",
        command,
      ],
      { windowsHide: true },
    )

  expect((await run(process.execPath)).stdout.trim().length).toBeGreaterThan(0)
  await expect(run(join(process.env.SystemRoot ?? "C:\\Windows", "System32", "where.exe"))).rejects.toThrow(
    "The bundled CookieMonster CLI failed validation.",
  )
})

test.skipIf(process.platform !== "win32")("environment notification propagates native broadcast failure", async () => {
  const result = await execFileAsync(
    "pwsh",
    [
      "-NoLogo",
      "-NoProfile",
      "-NonInteractive",
      "-Command",
      `
    $ErrorActionPreference = "Stop"
    $tokens = $null
    $errors = $null
    $ast = [System.Management.Automation.Language.Parser]::ParseFile('${script.replaceAll("'", "''")}', [ref]$tokens, [ref]$errors)
    if ($errors.Count) { throw $errors[0] }
    $definition = $ast.Find({ param($node) $node -is [System.Management.Automation.Language.FunctionDefinitionAst] -and $node.Name -eq 'Send-EnvironmentChange' }, $true)
    Invoke-Expression $definition.Extent.Text
    Add-Type -TypeDefinition @'
using System;
namespace CookieMonster {
  public static class EnvironmentChange {
    public static bool Fail;
    public static IntPtr SendMessageTimeout(IntPtr window, uint message, IntPtr wParam, string lParam, uint flags, uint timeout, out IntPtr result) {
      result = IntPtr.Zero;
      return Fail ? IntPtr.Zero : new IntPtr(1);
    }
  }
}
'@
    Send-EnvironmentChange
    [CookieMonster.EnvironmentChange]::Fail = $true
    try { Send-EnvironmentChange; throw 'Failure was ignored' }
    catch {
      if ($_.Exception.Message -notlike '*could not notify running applications*') { throw }
    }
    Write-Output 'PASS'
  `,
    ],
    { windowsHide: true },
  )
  expect(result.stdout.trim()).toBe("PASS")
})

const transform = (action: "TransformInstall" | "TransformUninstall", value: string) =>
  execFileAsync(
    "pwsh",
    [
      "-NoLogo",
      "-NoProfile",
      "-NonInteractive",
      "-File",
      script,
      "-Action",
      action,
      "-OwnedPath",
      owned,
      "-PathValue",
      value,
    ],
    { windowsHide: true },
  ).then((result) => result.stdout.trim())

test.skipIf(process.platform !== "win32")("installs the exact CookieMonster command directory once", async () => {
  expect(await transform("TransformInstall", "")).toBe(owned)
  expect(await transform("TransformInstall", "C:\\Windows;C:\\Tools")).toBe(`${owned};C:\\Windows;C:\\Tools`)
  expect(await transform("TransformInstall", `${owned};C:\\Windows`)).toBe(`${owned};C:\\Windows`)
  expect(await transform("TransformInstall", `C:\\Windows;${owned};C:\\Tools`)).toBe(`C:\\Windows;${owned};C:\\Tools`)
  expect(
    await transform("TransformInstall", `C:\\Windows;c:\\program files\\cookiemonster\\resources\\cli\\;${owned}`),
  ).toBe(`C:\\Windows;${owned}`)
  expect(await transform("TransformInstall", `"${owned}\\";C:\\Windows`)).toBe(`${owned};C:\\Windows`)
  expect(await transform("TransformInstall", `${owned}-old;C:\\Windows`)).toBe(`${owned};${owned}-old;C:\\Windows`)
})

test.skipIf(process.platform !== "win32")(
  "uninstall removes only the exact CookieMonster command directory",
  async () => {
    expect(await transform("TransformUninstall", `${owned};C:\\Windows;C:\\Tools`)).toBe("C:\\Windows;C:\\Tools")
    expect(await transform("TransformUninstall", `C:\\Windows;"${owned}\\";C:\\Tools;${owned}`)).toBe(
      "C:\\Windows;C:\\Tools",
    )
    expect(await transform("TransformUninstall", `${owned}-old;C:\\Windows`)).toBe(`${owned}-old;C:\\Windows`)
  },
)
