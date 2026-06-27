import type { WebContents } from "electron"

type InstallTarget = (sessionId?: string) => Promise<void>

export async function installInRootAndChildTargets(contents: WebContents, install: InstallTarget) {
  const dbg = contents.debugger
  if (!dbg.isAttached()) dbg.attach("1.3")

  const installed = new Set<string>()
  const installOnce = async (sessionId?: string) => {
    const key = sessionId || "root"
    if (installed.has(key)) return
    installed.add(key)
    try {
      await install(sessionId)
    } catch (error) {
      installed.delete(key)
      throw error
    }
  }

  dbg.on("message", (_event, method, params) => {
    if (method !== "Target.attachedToTarget") return
    const sessionId = (params as { sessionId?: string })?.sessionId
    if (!sessionId) return
    void installOnce(sessionId).catch(() => undefined)
  })

  await dbg.sendCommand("Target.setAutoAttach", {
    autoAttach: true,
    waitForDebuggerOnStart: false,
    flatten: true,
  })
  await installOnce()
}
