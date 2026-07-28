import type { Plugin, PluginModule } from "@opencode-ai/plugin"
import { ipcPort } from "./port"
import { browserTools } from "./tools"

const port = ipcPort()

export const server: Plugin = async () => ({ tool: browserTools(port) })

const module: PluginModule = { id: "cm-browser", server }
export default module
