import assert from "node:assert/strict"
import { createServer, type ServerResponse } from "node:http"
import { readFileSync, writeFileSync, renameSync } from "node:fs"
import { join } from "node:path"
import { BrowserWindow, dialog } from "electron"
import { browserCommand, browserViewport, registerBrowserOwner } from "./tabs"
import { getStore } from "../store"
import { savedTabs, saveTabs, type SavedTab } from "./tab-recovery"
import { vaultAccess } from "./vault-session"
import { vaultAuthentication } from "./vault-auth"
import { readLogins, writeLogins } from "./vault"

export async function recoverySmoke(profile: string) {
  assert.equal(process.versions.electron, "42.3.3")
  const phase = process.env.CM_BROWSER_PERSISTENCE_PHASE
  const seed = phase === "interrupt-recovery"
  const witnessPath = join(profile, "recovery-witness.json")
  const witness = seed ? undefined : JSON.parse(readFileSync(witnessPath, "utf8"))
  let posts = 0
  let failures = 0
  let held: ServerResponse | undefined
  const server = createServer((request, response) => {
    if (request.method === "POST") {
      posts++
      request.resume()
    }
    if (request.url === "/fail") {
      failures++
      request.socket.destroy()
      return
    }
    if (request.url === "/held") {
      held = response
      return
    }
    if (request.url === "/empty") {
      response.writeHead(204)
      response.end()
      return
    }
    if (request.url === "/redirect" || request.url === "/redirect-fail") {
      response.writeHead(302, { Location: request.url === "/redirect" ? "/redirected" : "/fail" })
      response.end()
      return
    }
    response.writeHead(200, { "Content-Type": "text/html", "Cache-Control": "private, max-age=60" })
    response.end(
      '<!doctype html><title>Recovery fixture</title><form method="post" action="/post"><input name="secret"><button>Submit</button></form>',
    )
  })
  const wait = async (check: () => boolean | Promise<boolean>) => {
    for (let i = 0; i < 150; i++) {
      if (await check()) return
      await new Promise((resolve) => setTimeout(resolve, 20))
    }
    throw new Error("Recovery fixture condition timed out")
  }
  await new Promise<void>((resolve) => server.listen(witness?.port ?? 0, "127.0.0.1", resolve))
  const address = server.address()
  assert(address && typeof address !== "string")
  const url = `http://127.0.0.1:${address.port}`
  const win = new BrowserWindow({
    show: false,
    webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false },
  })
  const owner = registerBrowserOwner(win)
  const command = (value: unknown, task = "recovery") => browserCommand(owner, task, value)
  const group = () => owner.groups.get("recovery")!
  const verify = vaultAuthentication.verify
  const consent = dialog.showMessageBox
  try {
    await win.loadURL(`${url}/owner`)
    win.showInactive()
    assert.equal(vaultAccess.status(), "locked", "Relaunch is locked BEFORE any unlock")
    assert.throws(() => readLogins())
    if (seed) {
      const id = (await command({ op: "new" })).activeID!
      const tab = group().tabs[0]
      await command({ op: "navigate", tabID: id, url: `${url}/a` })
      await tab.view.webContents.executeJavaScript(
        "document.querySelector('input').value = 'synthetic-post-secret'; document.querySelector('form').submit(); true",
      )
      await wait(() => tab.view.webContents.getURL() === `${url}/post` && !tab.view.webContents.isLoading())
      assert.equal(posts, 1)
      await command({ op: "navigate", tabID: id, url: `${url}/c` })
      await command({ op: "back", tabID: id })
      await wait(() => tab.view.webContents.getURL() === `${url}/post` && !tab.view.webContents.isLoading())
      await tab.view.webContents.executeJavaScript(
        "document.querySelector('input').value = 'synthetic-form-secret'; history.replaceState({ secret: 'synthetic-state-secret' }, ''); true",
      )
      const second = (await command({ op: "new" })).activeID!
      const closingTab = group().tabs.find((entry) => entry.id === second)!
      await wait(() => !closingTab.recovery && !closingTab.view.webContents.isLoading())
      await command({ op: "navigate", tabID: second, url: `${url}/a` })
      await wait(() => closingTab.view.webContents.getURL() === `${url}/a` && !closingTab.view.webContents.isLoading())
      await command({ op: "navigate", tabID: second, url: `${url}/c` })
      await wait(() => closingTab.view.webContents.getURL() === `${url}/c` && !closingTab.view.webContents.isLoading())
      assert.equal(closingTab.saved.url, `${url}/c`)
      assert(closingTab.saved.navigation && closingTab.saved.navigation.activeIndex > 0)
      await command({ op: "close", tabID: second })
      await wait(() => group().tabs.length === 1)
      browserViewport(owner, {
        sessionID: "recovery",
        lease: "fixture",
        bounds: { x: 0, y: 0, width: 600, height: 400 },
      })
      dialog.showMessageBox = (async () => ({ response: 1, checkboxChecked: false })) as typeof dialog.showMessageBox
      await command({ op: "access", tabID: id, enabled: true })
      assert.equal(tab.agentAccess, true)
      vaultAuthentication.verify = async () => {}
      await vaultAccess.unlock(win)
      writeLogins([{ id: "fixture", origin: url, username: "fixture", password: "synthetic-vault-secret" }])
      const saved = savedTabs("recovery")!
      assert(saved.tabs[0].navigation, "Native history must be persisted")
      assert.equal(saved.tabs[0].navigation.entries[saved.tabs[0].navigation.activeIndex].url, `${url}/post`)
      assert(saved.closed[0].navigation)
      assert(
        !/synthetic-(?:post|form|state|vault)-secret|pageState|postData/.test(
          readFileSync(getStore("cm-browser").path, "utf8"),
        ),
      )
      writeFileSync(witnessPath, JSON.stringify({ port: address.port, id, saved }))
      const checkpoint = join(profile, "checkpoint.json")
      writeFileSync(`${checkpoint}.tmp`, JSON.stringify({ pid: process.pid, phase }))
      renameSync(`${checkpoint}.tmp`, checkpoint)
      console.log(
        "PASS recovery seed: real POST/form/history.state projected away; grant and vault unlocked before crash",
      )
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0)
      throw new Error("Owned crash checkpoint resumed")
    }
    assert.deepEqual(savedTabs("recovery"), witness.saved)
    const restored = await command({ op: "state" })
    const tab = group().tabs[0]
    assert.notEqual(tab.id, witness.id)
    assert.equal(restored.tabs[0].agentAccess, false)
    assert.equal(restored.profile?.vaultStatus, "locked")
    await wait(() => !tab.recovery && !tab.view.webContents.isLoading())
    assert.equal(tab.view.webContents.getURL(), `${url}/post`)
    assert.equal(tab.view.webContents.navigationHistory.getActiveIndex(), witness.saved.tabs[0].navigation.activeIndex)
    assert.equal(tab.view.webContents.navigationHistory.canGoBack(), true)
    assert.equal(tab.view.webContents.navigationHistory.canGoForward(), true)
    assert.equal(await tab.view.webContents.executeJavaScript("document.querySelector('input').value"), "")
    assert.equal(await tab.view.webContents.executeJavaScript("history.state"), null)
    assert.equal(posts, 0, "Restoring a POST entry must issue GET, never replay its body")
    await command({ op: "forward", tabID: tab.id })
    await wait(() => tab.view.webContents.getURL() === `${url}/c` && !tab.view.webContents.isLoading())
    await command({ op: "back", tabID: tab.id })
    await wait(() => tab.view.webContents.getURL() === `${url}/post` && !tab.view.webContents.isLoading())
    assert.equal(posts, 0)
    const reopened = (await command({ op: "reopen" })).activeID!
    const closed = group().tabs.find((entry) => entry.id === reopened)!
    await wait(() => !closed.recovery && !closed.view.webContents.isLoading())
    assert.equal(closed.agentAccess, false)
    assert(closed.view.webContents.navigationHistory.canGoBack())
    assert.equal(group().closed.length, 0)
    console.log(
      "PASS native URL/title-only restore: selected index, back/forward, recently closed, fresh private IDs, locked vault, zero POST",
    )

    const legacy = { url: `${url}/legacy`, title: "Legacy" }
    saveTabs({ sessionID: "legacy", tabs: [legacy], active: 0, closed: [] })
    await command({ op: "state" }, "legacy")
    const legacyTab = owner.groups.get("legacy")!.tabs[0]
    await wait(() => !legacyTab.recovery)
    assert.equal(legacyTab.view.webContents.getURL(), legacy.url)
    const storage = getStore("cm-browser")
    storage.set("tabSessions", [
      ...(storage.get("tabSessions") as unknown[]),
      {
        sessionID: "corrupt-navigation",
        tabs: [{ ...legacy, navigation: { entries: [], activeIndex: 99 }, pageState: "synthetic-state-secret" }],
        active: 0,
        closed: [],
      },
    ])
    assert.deepEqual(savedTabs("corrupt-navigation")!.tabs, [legacy])
    await command({ op: "state" }, "corrupt-navigation")
    await wait(() => !owner.groups.get("corrupt-navigation")!.tabs[0].recovery)
    assert(!JSON.stringify(storage.get("tabSessions")).includes("synthetic-state-secret"))

    const recover = async (task: string, path: string) => {
      const entries = [
        { url: `${url}/a`, title: "A" },
        { url: `${url}${path}`, title: "Target" },
        { url: `${url}/c`, title: "C" },
      ]
      const saved: SavedTab = { ...entries[1], navigation: { entries, activeIndex: 1 } }
      saveTabs({ sessionID: task, tabs: [saved], active: 0, closed: [] })
      await command({ op: "state" }, task)
      return { tab: owner.groups.get(task)!.tabs[0], saved }
    }
    const redirected = await recover("redirected", "/redirect")
    await wait(() => !redirected.tab.recovery && !redirected.tab.view.webContents.isLoading())
    assert.equal(redirected.tab.view.webContents.getURL(), `${url}/redirected`)
    assert.equal(savedTabs("redirected")!.tabs[0].url, `${url}/redirected`)
    assert(redirected.tab.view.webContents.navigationHistory.canGoBack())
    assert(redirected.tab.view.webContents.navigationHistory.canGoForward())
    for (const path of ["/redirect-fail", "/empty"]) {
      const recovery = await recover(path, path)
      await wait(() => recovery.tab.loadFailed && !recovery.tab.view.webContents.isLoading())
      assert.deepEqual(savedTabs(path)!.tabs[0], recovery.saved)
      await command({ op: "reload", tabID: recovery.tab.id }, path)
      await wait(() => !recovery.tab.view.webContents.isLoading())
      assert.deepEqual(savedTabs(path)!.tabs[0], recovery.saved, "No-document retry retains history")
      await command({ op: "navigate", tabID: recovery.tab.id, url: `${url}/replacement` }, path)
      await wait(
        () =>
          recovery.tab.view.webContents.getURL() === `${url}/replacement` && !recovery.tab.view.webContents.isLoading(),
      )
      assert.equal(savedTabs(path)!.tabs[0].url, `${url}/replacement`)
    }
    const stopped = await recover("stopped", "/held")
    await wait(() => !!held)
    await command({ op: "stop", tabID: stopped.tab.id }, "stopped")
    await wait(() => !stopped.tab.view.webContents.isLoading())
    assert.deepEqual(savedTabs("stopped")!.tabs[0], stopped.saved)
    ;(held as ServerResponse | undefined)?.end()
    held = undefined
    await command({ op: "navigate", tabID: stopped.tab.id, url: `${url}/replacement` }, "stopped")
    await wait(
      () => stopped.tab.view.webContents.getURL() === `${url}/replacement` && !stopped.tab.view.webContents.isLoading(),
    )
    assert.equal(savedTabs("stopped")!.tabs[0].url, `${url}/replacement`)
    const ordinary = (await command({ op: "new" }, "ordinary")).activeID!
    const ordinaryTab = owner.groups.get("ordinary")!.tabs[0]
    await wait(() => !ordinaryTab.recovery && !ordinaryTab.view.webContents.isLoading())
    await assert.rejects(command({ op: "navigate", tabID: ordinary, url: `${url}/fail` }, "ordinary"))
    assert.equal((await command({ op: "state" }, "ordinary")).tabs[0].loadError, undefined)
    console.log("PASS redirect, HTTP 204, Stop, explicit recovery and ordinary load-error wording")
    const failed = await recover("failed", "/fail")
    await wait(() => failed.tab.loadFailed && !failed.tab.view.webContents.isLoading())
    assert.deepEqual(savedTabs("failed")!.tabs[0], failed.saved)
    const count = failures
    await new Promise((resolve) => setTimeout(resolve, 100))
    assert.equal(failures, count, "No application retry")
    assert.match((await command({ op: "state" }, "failed")).tabs[0].loadError!, /Reload.*address.*close/)
    await command({ op: "reload", tabID: failed.tab.id }, "failed")
    await wait(() => failures > count && failed.tab.loadFailed && !failed.tab.view.webContents.isLoading())
    assert.deepEqual(savedTabs("failed")!.tabs[0], failed.saved, "Failed Reload retains the recoverable stack")
    await command({ op: "navigate", tabID: failed.tab.id, url: `${url}/recovered` }, "failed")
    assert.equal(savedTabs("failed")!.tabs[0].url, `${url}/recovered`)
    const pending = await recover("pending", "/held")
    await wait(() => !!held)
    assert.deepEqual(savedTabs("pending")!.tabs[0], pending.saved)
    await command({ op: "navigate", tabID: pending.tab.id, url: `${url}/replacement` }, "pending")
    ;(held as ServerResponse | undefined)?.end()
    held = undefined
    await new Promise((resolve) => setTimeout(resolve, 50))
    assert.equal(savedTabs("pending")!.tabs[0].url, `${url}/replacement`)
    const closing = await recover("closing", "/held")
    await wait(() => !!held)
    const closingContents = closing.tab.view.webContents
    await command({ op: "close", tabID: closing.tab.id }, "closing")
    await wait(() => closingContents.isDestroyed())
    ;(held as ServerResponse | undefined)?.end()
    held = undefined
    assert.equal(savedTabs("closing")!.tabs.length, 0)
    assert.deepEqual(savedTabs("closing")!.closed[0].navigation, closing.saved.navigation)
    console.log(
      "PASS legacy/corrupt navigation fallback; failed/pending preservation; navigation/close invalidate stale restore",
    )

    const before = readFileSync(storage.path)
    try {
      for (const malformed of ["{", "null", JSON.stringify({ tabSessions: {} })]) {
        writeFileSync(storage.path, malformed)
        assert.throws(() => savedTabs("recovery"))
        await assert.rejects(command({ op: "state" }, "malformed"))
        assert.equal(owner.groups.has("malformed"), false, "Invalid storage must not cache a half-initialized group")
        assert.throws(() => saveTabs({ sessionID: "x", tabs: [], active: -1, closed: [] }))
        assert.equal(readFileSync(storage.path, "utf8"), malformed)
      }
    } finally {
      writeFileSync(storage.path, before)
    }
    assert.equal(posts, 0)
    assert(!/synthetic-(?:post|form|state|vault)-secret|pageState|postData/.test(readFileSync(storage.path, "utf8")))
    console.log(
      `PASS malformed store untouched; Electron ${process.versions.electron}, Chromium ${process.versions.chrome}`,
    )
  } finally {
    vaultAuthentication.verify = verify
    dialog.showMessageBox = consent
    vaultAccess.lock()
    win.destroy()
    held?.destroy()
    server.closeAllConnections()
    await new Promise<void>((resolve) => server.close(() => resolve()))
  }
}
