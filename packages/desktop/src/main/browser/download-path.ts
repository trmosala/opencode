import { lstatSync } from "node:fs"
import { lstat } from "node:fs/promises"
import { dirname, resolve } from "node:path"

export function physicalDownloadPathSync(path: string) {
  for (let current = resolve(path); ; current = dirname(current)) {
    if (lstatSync(current).isSymbolicLink()) return false
    if (dirname(current) === current) return true
  }
}

export async function physicalDownloadPath(path: string) {
  for (let current = resolve(path); ; current = dirname(current)) {
    if ((await lstat(current)).isSymbolicLink()) return false
    if (dirname(current) === current) return true
  }
}
