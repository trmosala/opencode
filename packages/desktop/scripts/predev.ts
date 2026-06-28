import { $ } from "bun"
import { createRequire } from "node:module"
import { dirname, join } from "node:path"
import { existsSync } from "node:fs"

// Bun skips lifecycle scripts by default, so electron's postinstall (which
// downloads the actual binary into dist/ and writes path.txt) may not have run
// even though it's listed in trustedDependencies. Without path.txt electron-vite
// fails with "Error: Electron uninstall". Run the installer if the binary is missing.
const electronDir = dirname(createRequire(import.meta.url).resolve("electron/package.json"))
if (!existsSync(join(electronDir, "path.txt"))) {
  console.log("electron binary missing, running install.js…")
  await $`node ${join(electronDir, "install.js")}`
}

await $`bun ./scripts/copy-icons.ts ${process.env.OPENCODE_CHANNEL ?? "dev"}`

await $`cd ../opencode && bun script/build-node.ts`
