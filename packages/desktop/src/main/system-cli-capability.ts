import { readFile } from "node:fs/promises"
import { join } from "node:path"

export async function hasSystemCli(appPath: string) {
  const metadata: { cmSystemCli?: boolean } = JSON.parse(await readFile(join(appPath, "package.json"), "utf8"))
  // Unbranded and older packages omit this capability.
  return metadata.cmSystemCli !== false
}
