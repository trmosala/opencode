// Compatibility entrypoint: CM3 now validates the actual production app routes.
import { spawnSync } from "node:child_process"
import { dirname, resolve } from "node:path"
import { fileURLToPath } from "node:url"

const result = spawnSync(process.platform === "win32" ? "bun.exe" : "bun", ["run", "test:cm3:chrome"], {
  cwd: resolve(dirname(fileURLToPath(import.meta.url)), ".."),
  stdio: "inherit",
})
if (result.error) throw result.error
process.exit(result.status ?? 1)
