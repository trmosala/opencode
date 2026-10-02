import type { Plugin, PluginModule } from "@opencode-ai/plugin"
import { ipcPort } from "./port"
import { browserTools } from "./tools"
import { browserDelegation } from "./delegation"

const port = ipcPort()

export const server: Plugin = async () => ({
  tool: browserTools(port),
  "task.execute.scope": browserDelegation(port),
})

const module: PluginModule = { id: "cm-browser", server }
export default module
