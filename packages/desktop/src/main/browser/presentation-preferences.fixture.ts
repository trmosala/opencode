import assert from "node:assert/strict"
import { createServer } from "node:http"
import { BrowserWindow } from "electron"
import { browserCommand, browserViewport, registerBrowserOwner } from "./tabs"

async function fixtureServer(title: string) {
  const server = createServer((_request, response) => {
    response.writeHead(200, { "Content-Type": "text/html" })
    response.end(`<!doctype html><meta name="viewport" content="width=device-width"><title>${title}</title>`)
  })
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve))
  const address = server.address()
  assert(address && typeof address !== "string")
  return { server, url: `http://127.0.0.1:${address.port}` }
}

export async function presentationPreferencesSmoke() {
  const first = await fixtureServer("Presentation A")
  const second = await fixtureServer("Presentation B")
  const win = new BrowserWindow({
    show: false,
    width: 900,
    height: 700,
    webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false },
  })
  const owner = registerBrowserOwner(win)
  const command = (value: unknown) => browserCommand(owner, "presentation-preferences", value)
  const wait = async (check: () => boolean | Promise<boolean>) => {
    for (let index = 0; index < 150; index++) {
      if (await check()) return
      await new Promise((resolve) => setTimeout(resolve, 30))
    }
    throw new Error("Presentation preferences fixture timed out")
  }
  try {
    await win.loadURL(`${first.url}/owner`)
    win.showInactive()
    browserViewport(owner, {
      sessionID: "presentation-preferences",
      lease: "presentation",
      bounds: { x: 0, y: 0, width: 800, height: 600 },
    })
    const original = (await command({ op: "new" })).activeID!
    await command({ op: "navigate", tabID: original, url: `${first.url}/one` })
    await wait(async () => (await command({ op: "state" })).tabs.find((tab) => tab.id === original)?.loading === false)
    await command({ op: "zoom", tabID: original, factor: 1.4 })
    await wait(async () => (await command({ op: "state" })).tabs.find((tab) => tab.id === original)?.zoom === 1.4)

    await command({ op: "navigate", tabID: original, url: `${first.url}/two` })
    await wait(async () => (await command({ op: "state" })).tabs.find((tab) => tab.id === original)?.zoom === 1.4)
    await command({ op: "navigate", tabID: original, url: `${second.url}/other-origin` })
    await wait(async () => (await command({ op: "state" })).tabs.find((tab) => tab.id === original)?.zoom === 1)

    const fresh = (await command({ op: "new" })).activeID!
    await command({ op: "navigate", tabID: fresh, url: `${first.url}/fresh` })
    await wait(async () => (await command({ op: "state" })).tabs.find((tab) => tab.id === fresh)?.zoom === 1.4)

    await command({ op: "device-preset-save", name: "Fixture phone", size: { width: 412, height: 915 } })
    const preset = (await command({ op: "state" })).profile?.devicePresets?.[0]
    assert.deepEqual(preset && { name: preset.name, size: preset.size }, {
      name: "Fixture phone",
      size: { width: 412, height: 915 },
    })
    await command({ op: "device", tabID: fresh, enabled: true, size: preset!.size })
    await wait(async () => {
      const tab = owner.groups.get("presentation-preferences")!.tabs.find((row) => row.id === fresh)!
      return (await tab.view.webContents.executeJavaScript("window.innerWidth")) === 412
    })
    await command({ op: "device", tabID: fresh, enabled: false })
    await wait(async () => {
      const tab = owner.groups.get("presentation-preferences")!.tabs.find((row) => row.id === fresh)!
      return (await tab.view.webContents.executeJavaScript("window.innerWidth")) !== 412
    })
    assert.equal((await command({ op: "state" })).tabs.find((tab) => tab.id === fresh)?.device, false)

    const restoredWindow = new BrowserWindow({
      show: false,
      webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false },
    })
    const restoredOwner = registerBrowserOwner(restoredWindow)
    try {
      await restoredWindow.loadURL(`${first.url}/restored-owner`)
      const restoredCommand = (value: unknown) => browserCommand(restoredOwner, "presentation-preferences", value)
      await wait(async () => {
        const state = await restoredCommand({ op: "state" })
        return state.tabs.length === 2 && state.tabs.every((tab) => !tab.loading)
      })
      const restored = await restoredCommand({ op: "state" })
      assert.equal(restored.tabs.find((tab) => tab.url === `${first.url}/fresh`)?.zoom, 1.4)
      assert(restored.tabs.every((tab) => !tab.device))
      assert.equal(restored.profile?.devicePresets?.[0]?.name, "Fixture phone")
    } finally {
      restoredWindow.destroy()
    }
    console.log("PASS presentation preferences: exact-origin zoom, new/recovered tabs, presets and preview exit")
  } finally {
    win.destroy()
    await Promise.all(
      [first.server, second.server].map(
        (server) =>
          new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve()))),
      ),
    )
  }
}
