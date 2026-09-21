import { execFile } from "node:child_process"
import { existsSync } from "node:fs"
import { readlink } from "node:fs/promises"
import { join, normalize } from "node:path"
import { promisify } from "node:util"
import { app } from "electron"

const execFileAsync = promisify(execFile)

type Logger = {
  log(message: string, meta?: Record<string, unknown>): void
  error(message: string, meta?: Record<string, unknown>): void
}

export async function repairSystemCli() {
  if (!app.isPackaged) throw new Error("system_cli_unavailable")

  if (process.platform === "win32") {
    const directory = join(process.resourcesPath, "cli")
    const command = join(directory, "opencode.exe")
    const script = join(directory, "register-path.ps1")
    if (!existsSync(command) || !existsSync(script)) throw new Error("system_cli_unavailable")
    await execFileAsync(
      join(process.env.SystemRoot ?? "C:\\Windows", "System32", "WindowsPowerShell", "v1.0", "powershell.exe"),
      [
        "-NoLogo",
        "-NoProfile",
        "-NonInteractive",
        "-ExecutionPolicy",
        "Bypass",
        "-File",
        script,
        "-Action",
        "Install",
        "-OwnedPath",
        directory,
        "-CliPath",
        command,
      ],
      { windowsHide: true },
    ).catch(() => {
      throw new Error("system_cli_repair_failed")
    })
    return command
  }

  if (process.platform === "darwin") {
    const command = join(process.resourcesPath, "cli", "opencode")
    const registered = "/usr/local/bin/opencode"
    if (!existsSync(command)) throw new Error("system_cli_unavailable")
    const target = await readlink(registered).catch(() => undefined)
    if (target !== command) throw new Error("system_cli_requires_pkg")
    return registered
  }

  throw new Error("system_cli_unavailable")
}

export async function logSystemCliDiagnostics(logger: Logger) {
  if (!app.isPackaged) return
  const expected =
    process.platform === "win32"
      ? join(process.resourcesPath, "cli", "opencode.exe")
      : process.platform === "darwin"
        ? "/usr/local/bin/opencode"
        : undefined
  if (!expected) return

  const resolved = await resolveCommands()
  const registered = await registrationStatus()
  logger.log("system CLI registration checked", {
    expected,
    bundled: existsSync(join(process.resourcesPath, "cli", process.platform === "win32" ? "opencode.exe" : "opencode")),
    registered,
    resolved,
    shadowed: resolved.length > 0 && normalize(resolved[0]).toLowerCase() !== normalize(expected).toLowerCase(),
  })
}

async function registrationStatus() {
  if (process.platform === "darwin") {
    const target = await readlink("/usr/local/bin/opencode").catch(() => undefined)
    return target === join(process.resourcesPath, "cli", "opencode")
  }
  if (process.platform !== "win32") return false
  const directory = join(process.resourcesPath, "cli")
  const script = join(directory, "register-path.ps1")
  if (!existsSync(script)) return false
  return execFileAsync(
    join(process.env.SystemRoot ?? "C:\\Windows", "System32", "WindowsPowerShell", "v1.0", "powershell.exe"),
    [
      "-NoLogo",
      "-NoProfile",
      "-NonInteractive",
      "-ExecutionPolicy",
      "Bypass",
      "-File",
      script,
      "-Action",
      "Status",
      "-OwnedPath",
      directory,
    ],
    { windowsHide: true },
  ).then(
    (result) => {
      const value: unknown = JSON.parse(result.stdout)
      return Boolean(value && typeof value === "object" && "registered" in value && value.registered === true)
    },
    () => false,
  )
}

async function resolveCommands() {
  const executable = process.platform === "win32" ? "where.exe" : "/usr/bin/which"
  const args = process.platform === "win32" ? ["opencode"] : ["-a", "opencode"]
  return execFileAsync(executable, args, { windowsHide: true }).then(
    (result) =>
      result.stdout
        .split(/\r?\n/)
        .map((line) => line.trim())
        .filter(Boolean),
    () => [],
  )
}
