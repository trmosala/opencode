import fs from "node:fs"
import { syncBuiltinESMExports } from "node:module"

const rename = fs.renameSync
export const persistenceRenameFault = {
  path: "",
  attempts: 0,
  restore() {
    persistenceRenameFault.path = ""
    fs.renameSync = rename
    syncBuiltinESMExports()
  },
}

// Import before electron-store: stubborn-fs captures renameSync during initialization.
if (process.argv.includes("--persistence-exdev") || process.argv.includes("--persistence-reopen")) {
  fs.renameSync = (source, target) => {
    if (String(target) !== persistenceRenameFault.path) return rename(source, target)
    persistenceRenameFault.attempts++
    throw Object.assign(new Error("fixture cross-device rename"), { code: "EXDEV" })
  }
  syncBuiltinESMExports()
}
