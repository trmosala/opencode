import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import electron from "electron"

// Run after building, or pass an extracted packaged app directory as the first argument.
// Stall the real Electron logging API to verify startup still presents the main window.
const directory = await mkdtemp(join(tmpdir(), "cm-startup-smoke-"))
const target = resolve(process.argv[2] ?? ".")
try {
  const entry = join(directory, "startup.cjs")
  await Bun.write(
    entry,
    `const { app, netLog, BrowserWindow } = require("electron")
process.env.OPENCODE_TEST_ONBOARDING = "1"
netLog.startLogging = () => new Promise(() => {})
app.setAppPath(${JSON.stringify(target)})
const timer = setTimeout(() => {
  const windows = BrowserWindow.getAllWindows().filter(win => win.webContents.getURL().startsWith("oc://renderer/"))
  const visible = windows.some(win => win.isVisible())
  console.log("STARTUP_CHECK " + JSON.stringify({ windows: windows.length, visible }))
  app.exit(visible ? 0 : 1)
}, 15000)
app.on("will-quit", () => clearTimeout(timer))
import(${JSON.stringify(join(target, "out/main/index.js"))})
`,
  )
  const env = { ...process.env }
  delete env.ELECTRON_RUN_AS_NODE
  const child = Bun.spawn([electron, entry], { env, stdout: "inherit", stderr: "inherit" })
  process.exitCode = await child.exited
} finally {
  await rm(directory, { recursive: true, force: true })
}
