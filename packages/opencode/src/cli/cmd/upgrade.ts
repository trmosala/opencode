import type { Argv } from "yargs"
import { UI } from "../ui"
import { Installation } from "../../installation"

export const UpgradeCommand = {
  command: "upgrade [target]",
  describe: "upgrade opencode to the latest or a specific version",
  builder: (yargs: Argv) => {
    return yargs
      .positional("target", {
        describe: "version to upgrade to, for ex '0.1.48' or 'v0.1.48'",
        type: "string",
      })
      .option("method", {
        alias: "m",
        describe: "installation method to use",
        type: "string",
        choices: ["curl", "npm", "pnpm", "bun", "brew", "choco", "scoop"],
      })
  },
  handler: async () => {
    const error = await Installation.upgrade("unknown", "").catch((error: unknown) => error)
    if (error instanceof Installation.UpgradeFailedError) UI.error(error.stderr)
    process.exitCode = 1
  },
}
