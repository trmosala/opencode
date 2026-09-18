import fs from "node:fs"
import { randomUUID } from "node:crypto"
import { basename, dirname, join } from "node:path"

export function atomicWriteNewFile(path: string, data: Buffer, beforePublish: (temporary: string) => void = () => {}) {
  fs.mkdirSync(dirname(path), { recursive: true })
  const temporary = join(dirname(path), `.${basename(path)}.${randomUUID()}.tmp`)
  let descriptor: number | undefined = fs.openSync(temporary, "wx", 0o600)
  try {
    fs.writeFileSync(descriptor, data)
    fs.fsyncSync(descriptor)
    const closing = descriptor
    descriptor = undefined
    fs.closeSync(closing)
    beforePublish(temporary)
    // A hard link publishes only the completely flushed file and refuses to replace any existing backup.
    fs.linkSync(temporary, path)
    try {
      fs.unlinkSync(temporary)
    } catch {
      // The complete destination is already committed. A hidden encrypted duplicate is safer than a false failure.
    }
  } catch (error) {
    if (descriptor !== undefined) {
      try {
        fs.closeSync(descriptor)
      } catch {}
    }
    try {
      fs.unlinkSync(temporary)
    } catch {}
    throw error
  }
}
