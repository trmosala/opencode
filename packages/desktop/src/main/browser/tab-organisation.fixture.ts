import assert from "node:assert/strict"
import { createServer } from "node:http"
import { BrowserWindow, dialog } from "electron"
import { browserCommand, registerBrowserOwner } from "./tabs"
import { savedTabs } from "./tab-recovery"

export async function tabOrganisationSmoke() {
  const server = createServer((_request, response) => {
    response.writeHead(200, { "Content-Type": "text/html" })
    response.end("<!doctype html><title>Tab organisation fixture</title><p>Fixture</p>")
  })
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve))
  const address = server.address()
  assert(address && typeof address !== "string")
  const url = `http://127.0.0.1:${address.port}`
  const win = new BrowserWindow({
    show: false,
    webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false },
  })
  const owner = registerBrowserOwner(win)
  const command = (value: unknown) => browserCommand(owner, "tab-organisation", value)
  const group = () => owner.groups.get("tab-organisation")!
  const wait = async (check: () => boolean | Promise<boolean>) => {
    for (let index = 0; index < 100; index++) {
      if (await check()) return
      await new Promise((resolve) => setTimeout(resolve, 30))
    }
    throw new Error("Tab organisation fixture timed out")
  }
  const originalPrompt = dialog.showMessageBoxSync
  let leave = false
  try {
    await win.loadURL(`${url}/owner`)
    win.showInactive()
    const first = (await command({ op: "new" })).activeID!
    await command({ op: "navigate", tabID: first, url: `${url}/a` })
    const second = (await command({ op: "new" })).activeID!
    await command({ op: "navigate", tabID: second, url: `${url}/b` })
    const third = (await command({ op: "new" })).activeID!
    await command({ op: "navigate", tabID: third, url: `${url}/c` })

    await command({ op: "tab-pin", tabID: second, pinned: true })
    await command({ op: "tab-pin", tabID: first, pinned: true })
    await command({ op: "tab-move", tabID: first, direction: "left" })
    assert.deepEqual(
      group().tabs.map((tab) => tab.id),
      [first, second, third],
    )
    assert.deepEqual(
      group().tabs.map((tab) => tab.saved.pinned === true),
      [true, true, false],
    )

    const source = group().tabs.find((tab) => tab.id === second)!
    source.agentAccess = true
    const duplicate = (await command({ op: "duplicate", tabID: second })).activeID!
    const copied = group().tabs.find((tab) => tab.id === duplicate)!
    await wait(() => !copied.contents.isLoadingMainFrame())
    assert.deepEqual(
      group().tabs.map((tab) => tab.id),
      [first, second, duplicate, third],
    )
    assert.equal(copied.contents.getURL(), `${url}/b`)
    assert.equal(copied.agentAccess, false)
    assert.equal(copied.saved.pinned, undefined)
    assert.deepEqual(
      copied.saved.navigation?.entries.map((entry) => entry.url),
      [`${url}/b`],
    )
    assert.equal(copied.openerID, undefined)
    assert.equal(copied.device, undefined)

    await command({ op: "tab-pin", tabID: first, pinned: false })
    await command({ op: "tab-move", tabID: third, direction: "left" })
    assert.deepEqual(
      group().tabs.map((tab) => tab.id),
      [second, first, third, duplicate],
    )
    await command({ op: "tab-move", tabID: third, direction: "right" })
    assert.deepEqual(
      group().tabs.map((tab) => tab.id),
      [second, first, duplicate, third],
    )

    const right = group().tabs.find((tab) => tab.id === third)!
    await right.view.webContents.executeJavaScript("void (window.onbeforeunload=()=>false)")
    dialog.showMessageBoxSync = (() => (leave ? 1 : 0)) as typeof dialog.showMessageBoxSync
    await command({ op: "close-tabs", tabID: duplicate, scope: "right" })
    assert.equal(right.contents.isDestroyed(), false)
    leave = true
    await command({ op: "close-tabs", tabID: duplicate, scope: "right" })
    await wait(() => right.contents.isDestroyed())

    const fourth = (await command({ op: "new" })).activeID!
    await command({ op: "navigate", tabID: fourth, url: `${url}/d` })
    const fifth = (await command({ op: "new" })).activeID!
    await command({ op: "navigate", tabID: fifth, url: `${url}/e` })
    const guarded = group().tabs.find((tab) => tab.id === fifth)!
    await guarded.view.webContents.executeJavaScript("void (window.onbeforeunload=()=>false)")
    await command({ op: "close-tabs", tabID: first, scope: "others" })
    await wait(() => group().tabs.length === 2)
    assert.equal(group().activeID, first)
    assert.deepEqual(
      group().tabs.map((tab) => tab.id),
      [second, first],
    )
    assert.deepEqual(
      group().tabs.map((tab) => tab.saved.pinned === true),
      [true, false],
    )

    const recovery = savedTabs("tab-organisation")!
    assert.deepEqual(
      recovery.tabs.map((tab) => tab.url),
      [`${url}/b`, `${url}/a`],
    )
    assert.deepEqual(
      recovery.tabs.map((tab) => tab.pinned === true),
      [true, false],
    )
    const restoredWindow = new BrowserWindow({
      show: false,
      webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false },
    })
    const restoredOwner = registerBrowserOwner(restoredWindow)
    try {
      await restoredWindow.loadURL(`${url}/restored-owner`)
      const restored = await browserCommand(restoredOwner, "tab-organisation", { op: "state" })
      assert.deepEqual(
        restored.tabs.map((tab) => tab.pinned),
        [true, false],
      )
      assert.deepEqual(
        restored.tabs.map((tab) => tab.url),
        [`${url}/b`, `${url}/a`],
      )
      assert(restored.tabs.every((tab) => !tab.agentAccess))
      assert(restored.tabs.every((tab) => ![first, second].includes(tab.id)))
    } finally {
      restoredWindow.destroy()
    }
    console.log("PASS tab organisation: pin/order/recovery, fresh private duplicates, bulk close and beforeunload")
  } finally {
    dialog.showMessageBoxSync = originalPrompt
    win.destroy()
    await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())))
  }
}
