export * as Server from "./runtime"
export { prepareDatabase } from "./database"

import { registerHooks } from "node:module"
import { randomUUID } from "node:crypto"
import { binaryPath } from "@opencode/pty"

let installed = false
const runtimeID = randomUUID()

export async function listen(input: import("./server").ListenOptions) {
  if (!installed) {
    process.env.CM_V2_RUNTIME_ID = runtimeID
    if (binaryPath) process.env.OPENCODE_PTY_BIN ??= binaryPath.replace(/app\.asar([/\\])/, "app.asar.unpacked$1")
    // Local plugins must use the host's stable SDK, never the legacy desktop's beta Effect.
    registerHooks({
      resolve(specifier, context, nextResolve) {
        if (specifier === "#v1-migration")
          return nextResolve("@opencode/core/database/v1-migration.bun", { ...context, parentURL: import.meta.url })
        if (specifier === "bun:sqlite")
          return { url: new URL("./migration-reader.js", import.meta.url).href, shortCircuit: true }
        if (specifier === "effect" || specifier.startsWith("effect/") || specifier.startsWith("@effect/"))
          return nextResolve(specifier, { ...context, parentURL: import.meta.url })
        if (context.parentURL?.includes("__opencode_reload=") && specifier.startsWith("@opencode/"))
          return nextResolve(specifier, { ...context, parentURL: import.meta.url })
        return nextResolve(specifier, context)
      },
    })
    installed = true
  }
  const { Server } = await import("./server")
  return Server.listen(input)
}
