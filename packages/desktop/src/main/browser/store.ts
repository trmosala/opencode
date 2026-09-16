import fs from "node:fs"
import { randomUUID } from "node:crypto"
import { dirname } from "node:path"

// Only the cm-browser API in use, with literal keys and Conf-compatible JSON.
export class BrowserStore {
  constructor(readonly path: string) {}

  get store(): Record<string, unknown> {
    try {
      return Object.assign(Object.create(null), requireObject(JSON.parse(fs.readFileSync(this.path, "utf8"))))
    } catch (error) {
      if (error && typeof error === "object" && "code" in error && error.code === "ENOENT") return Object.create(null)
      throw error
    }
  }

  set store(value: Record<string, unknown>) {
    requireObject(value)
    // Read even for replacement: malformed existing data must never be overwritten.
    const current = this.store
    const next = { ...value }
    if (!Object.hasOwn(next, "__internal__") && Object.hasOwn(current, "__internal__"))
      next.__internal__ = current.__internal__
    const data = JSON.stringify(next, undefined, "\t")
    requireObject(JSON.parse(data))
    fs.mkdirSync(dirname(this.path), { recursive: true })
    const temporary = `${this.path}.${randomUUID()}.tmp`
    // Open outside the cleanup block: EEXIST must not delete someone else's file.
    let descriptor: number | undefined = fs.openSync(temporary, "wx", 0o600)
    try {
      fs.writeFileSync(descriptor, data, "utf8")
      fs.fsyncSync(descriptor)
      const closing = descriptor
      descriptor = undefined
      fs.closeSync(closing)
      fs.renameSync(temporary, this.path)
    } catch (error) {
      // Cleanup is best-effort; preserve the write failure, and only touch our own temp.
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

  get(key: string, defaultValue?: unknown): unknown {
    const value = this.store
    return Object.hasOwn(value, key) ? value[key] : defaultValue
  }

  has(key: string) {
    return Object.hasOwn(this.store, key)
  }

  set(key: string | Record<string, unknown>, value?: unknown) {
    if (typeof key !== "string") requireObject(key)
    if (containsReservedKey(key)) throw new TypeError("Reserved store key")
    const next = this.store
    for (const [name, entry] of typeof key === "string" ? [[key, value]] : Object.entries(key)) {
      if (["undefined", "symbol", "function"].includes(typeof entry))
        throw new TypeError("Store values must be JSON; use delete() to remove a key")
      if (name === "__proto__" || name === "constructor" || name === "prototype") continue
      next[name as string] = entry
    }
    this.store = next
  }

  delete(key: string) {
    const next = this.store
    delete next[key]
    this.store = next
  }

  clear() {
    this.store = {}
  }
}

function requireObject(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new TypeError("Invalid cm-browser store")
  return value as Record<string, unknown>
}

function containsReservedKey(value: unknown): boolean {
  if (typeof value === "string") return value === "__internal__" || value.startsWith("__internal__.")
  return (
    !!value &&
    typeof value === "object" &&
    Object.entries(value).some(
      ([key, entry]) =>
        containsReservedKey(key) || (!!entry && typeof entry === "object" && containsReservedKey(entry)),
    )
  )
}
