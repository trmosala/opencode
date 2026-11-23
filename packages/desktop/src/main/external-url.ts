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

export function launchesProgram(
  paths: readonly string[],
  mode: number,
  directory: boolean,
  platform: NodeJS.Platform = process.platform,
) {
  if (paths.some((path) => PROGRAM_EXTENSIONS.has(extname(path).toLowerCase()))) return true
  // macOS runs extensionless POSIX executables in Terminal. Directory execute bits only mean traversal.
  return platform !== "win32" && !directory && (mode & 0o111) !== 0
}
