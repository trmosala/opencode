import { extname } from "node:path"
import { fileURLToPath } from "node:url"

export function resolveExternalURL(value: string) {
  if (!URL.canParse(value)) return undefined
  const url = new URL(value)
  if (url.protocol === "http:" || url.protocol === "https:" || url.protocol === "mailto:") return url.href
  return undefined
}

export function resolveLocalFilePath(value: string) {
  if (!URL.canParse(value)) return undefined
  const url = new URL(value)
  if (url.protocol !== "file:" || url.hostname) return undefined
  try {
    return fileURLToPath(url)
  } catch {
    return undefined
  }
}

// Opening these through the OS default handler runs code (or an installer/shortcut) instead of showing a document.
const PROGRAM_EXTENSIONS = new Set([
  ".app",
  ".appimage",
  ".appref-ms",
  ".appx",
  ".applescript",
  ".bash",
  ".bat",
  ".cmd",
  ".com",
  ".command",
  ".cpl",
  ".csh",
  ".deb",
  ".desktop",
  ".exe",
  ".fish",
  ".hta",
  ".inf",
  ".jar",
  ".js",
  ".jse",
  ".ksh",
  ".lnk",
  ".mpkg",
  ".msc",
  ".msi",
  ".msix",
  ".msp",
  ".pif",
  ".pkg",
  ".pl",
  ".ps1",
  ".psm1",
  ".py",
  ".pyw",
  ".rb",
  ".reg",
  ".rpm",
  ".run",
  ".scpt",
  ".scr",
  ".settingcontent-ms",
  ".sh",
  ".tool",
  ".url",
  ".vbe",
  ".vbs",
  ".workflow",
  ".ws",
  ".wsf",
  ".wsh",
  ".zsh",
])

const BUNDLE_EXTENSIONS = new Set([".app", ".mpkg", ".pkg", ".tool", ".workflow"])

export function launchesProgram(
  paths: readonly string[],
  mode: number,
  directory: boolean,
  platform: NodeJS.Platform = process.platform,
) {
  // A folder is a program only as a macOS bundle; a project folder named `three.js` is still a folder.
  if (directory) return paths.some((path) => BUNDLE_EXTENSIONS.has(extname(path).toLowerCase()))
  if (paths.some((path) => PROGRAM_EXTENSIONS.has(extname(path).toLowerCase()))) return true
  // macOS runs extensionless POSIX executables in Terminal. Files with an extension open with their document handler,
  // and exFAT/SMB mounts mark every file executable, so the execute bit only matters without one.
  return platform !== "win32" && (mode & 0o111) !== 0 && paths.some((path) => extname(path) === "")
}
