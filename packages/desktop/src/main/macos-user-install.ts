import { execFile } from "node:child_process"
import { mkdir } from "node:fs/promises"
import { posix } from "node:path"

export function macCommand(file: string, args: string[], input?: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = execFile(
      file,
      args,
      { encoding: "utf8", timeout: 120_000, maxBuffer: 4 * 1024 * 1024 },
      (error, stdout) => {
        if (error) reject(error)
        else resolve(stdout)
      },
    )
    child.stdin?.on("error", () => {})
    child.stdin?.end(input)
  })
}

export async function diskImageSource(executable: string, run = macCommand) {
  // ponytail: no private translocation APIs; never copy a guessed original bundle.
  if (executable.includes("/AppTranslocation/")) return "manual"
  const source = posix.dirname(posix.dirname(posix.dirname(executable)))
  if (!source.endsWith("/CookieMonster.app")) return "none"
  try {
    const plist = await run("/usr/bin/hdiutil", ["info", "-plist"])
    const info: unknown = JSON.parse(await run("/usr/bin/plutil", ["-convert", "json", "-o", "-", "-"], plist))
    if (!info || typeof info !== "object" || !("images" in info) || !Array.isArray(info.images)) {
      throw new Error("Invalid disk-image information")
    }
    const mounted = info.images.some((image: { "system-entities"?: { "mount-point"?: string }[] }) =>
      image?.["system-entities"]?.some((entity) => {
        const mount = entity["mount-point"]
        return typeof mount === "string" && mount !== "/" && source.startsWith(`${mount}/`)
      }),
    )
    return mounted ? source : "none"
  } catch {
    return source.startsWith("/Volumes/") ? "manual" : "none"
  }
}

export async function copyUserApp(source: string, applications: string, run = macCommand) {
  const destination = posix.join(applications, "CookieMonster.app")
  await mkdir(applications, { recursive: true })
  // Atomic reservation rejects existing directories, files and dangling symlinks.
  await mkdir(destination)
  // Never remove a failed copy: retaining our partial bundle also avoids deleting concurrent user changes.
  await run("/usr/bin/ditto", ["--rsrc", "--extattr", "--acl", source, destination])
  return destination
}

type Installer = {
  executable: string
  applications: string
  confirm: (destination: string) => Promise<boolean>
  manual: (destination: string) => Promise<void>
  failed: (destination: string) => Promise<void>
  releaseLock: () => void
  quit: () => void
  run?: typeof macCommand
  copy?: typeof copyUserApp
}

export async function installFromDiskImage(options: Installer) {
  const source = await diskImageSource(options.executable, options.run)
  if (source === "none") return false
  const destination = posix.join(options.applications, "CookieMonster.app")
  if (source === "manual") {
    await options.manual(destination)
    options.quit()
    return true
  }
  if (!(await options.confirm(destination))) {
    options.quit()
    return true
  }
  try {
    await (options.copy ?? copyUserApp)(source, options.applications, options.run)
    // The installed process must acquire the same lock before starting its sidecar.
    options.releaseLock()
    await (options.run ?? macCommand)("/usr/bin/open", ["-n", destination])
  } catch {
    await options.failed(destination)
  }
  options.quit()
  return true
}
