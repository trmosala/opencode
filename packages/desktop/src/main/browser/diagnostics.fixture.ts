import assert from "node:assert/strict"
import { BrowserWindow } from "electron"
import { observeConsole } from "./console-diagnostics"

export async function diagnosticsSmoke() {
  const win = new BrowserWindow({
    show: false,
    webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false },
  })
  try {
    await win.loadURL("data:text/html,<title>diagnostics</title>")
    const observation = observeConsole(win.webContents, 250, () => {})
    await win.webContents.executeJavaScript(`
      console.debug("debug secret");
      console.info("info secret");
      console.warn("warning secret");
      console.error("error secret");
    `)
    const result = await observation
    assert(result.debug >= 1)
    assert(result.info >= 1)
    assert(result.warning >= 1)
    assert(result.error >= 1)
    assert.equal(result.total, result.debug + result.info + result.warning + result.error + result.other)
    assert(!JSON.stringify(result).includes("secret"))
    assert.equal(win.webContents.listenerCount("console-message"), 0)
    console.log("PASS native bounded console diagnostics")
  } finally {
    if (!win.isDestroyed()) win.destroy()
  }
}
