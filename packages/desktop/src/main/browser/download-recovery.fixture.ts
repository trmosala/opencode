import assert from "node:assert/strict"
import { createServer } from "node:http"
import { mkdir, readFile, writeFile, stat, readdir } from "node:fs/promises"
import { join } from "node:path"
import { app, BrowserWindow, dialog, session } from "electron"
import { browserCommand, registerBrowserOwner } from "./tabs"
import { getStore } from "../store"
import { savedDownloads } from "./download-records"
import { downloadHistory } from "./preferences"
import { recoveringDownloads, pruneDownloadRecovery } from "./download-recovery"
import { BROWSER_PARTITION } from "./policy"
import { downloadCheckpoint } from "./download-recovery-data"

export async function downloadRecoverySmoke() {
  const directory = process.env.CM_BROWSER_SMOKE_PROFILE
  assert(directory, "Download recovery tests require an isolated profile")
  const phase = process.env.CM_BROWSER_PERSISTENCE_PHASE
  const bytes = Buffer.alloc(2 * 1024 * 1024).map((_value, index) => index % 251)
  const modified = "Mon, 01 Jun 2026 10:00:00 GMT"
  let requests = 0
  let mode = "valid"
  const server = createServer((request, response) => {
    if (request.url === "/") {
      response.end("Download fixture")
      return
    }
    requests++
    if (!request.headers.cookie?.includes("download_auth=yes")) {
      response.writeHead(401)
      response.end()
      return
    }
    const offset = Number(request.headers.range?.match(/^bytes=(\d+)-$/)?.[1] ?? 0)
    if (mode === "redirect") {
      response.writeHead(302, { Location: "/other" })
      response.end()
      return
    }
    response.writeHead(offset && mode !== "no-range" ? 206 : 200, {
      "Content-Type": "application/octet-stream",
      "Content-Disposition": 'attachment; filename="fixture.bin"',
      "Accept-Ranges": "bytes",
      ETag: mode === "changed" ? '"changed"' : '"fixture-v1"',
      "Last-Modified": modified,
      "Content-Length": bytes.length - (mode === "no-range" ? 0 : offset),
      ...(offset ? { "Content-Range": `bytes ${offset}-${bytes.length - 1}/${bytes.length}` } : {}),
    })
    if (offset) {
      response.end(bytes.subarray(mode === "no-range" ? 0 : offset))
      return
    }
    let sent = 0
    const timer = setInterval(() => {
      response.write(bytes.subarray(sent, sent + 32 * 1024))
      sent += 32 * 1024
      if (sent >= bytes.length) {
        clearInterval(timer)
        response.end()
      }
    }, 60)
    response.once("close", () => clearInterval(timer))
  })
  const previous =
    phase === "reopen-download"
      ? (JSON.parse(await readFile(join(directory, "download-fixture.json"), "utf8")) as { port: number; id: string })
      : undefined
  await new Promise<void>((resolve) => server.listen(previous?.port ?? 0, "127.0.0.1", resolve))
  const address = server.address()
  assert(address && typeof address !== "string")
  const origin = `http://127.0.0.1:${address.port}`
  const win = new BrowserWindow({ show: false })
  const owner = registerBrowserOwner(win)
  const command = (value: Parameters<typeof browserCommand>[2]) => browserCommand(owner, "download-smoke", value)
  const wait = async (check: () => boolean) => {
    for (let attempt = 0; attempt < 200; attempt++) {
      if (check()) return
      await new Promise((resolve) => setTimeout(resolve, 25))
    }
    throw new Error("Download fixture condition timed out: " + JSON.stringify(downloadHistory()))
  }
  const show = dialog.showMessageBox
  const save = dialog.showSaveDialogSync
  try {
    if (phase === "interrupt-download") {
      const destination = join(directory, "downloads")
      await mkdir(destination)
      getStore("cm-browser").set("preferences", { askDownloadLocation: false })
      getStore("cm-browser").set("downloadDirectory", destination)
      const browser = session.fromPartition(BROWSER_PARTITION)
      await browser.cookies.set({
        url: origin,
        name: "download_auth",
        value: "yes",
        expirationDate: Date.now() / 1000 + 3600,
      })
      await browser.cookies.flushStore()
      await command({ op: "new" })
      const tab = owner.groups.get("download-smoke")!.tabs[0]
      await tab.contents.loadURL(origin)
      await tab.view.webContents.executeJavaScript(
        `(() => { const a = document.createElement('a'); a.href = '/file'; document.body.append(a); a.click(); })()`,
        true,
      )
      await wait(() => savedDownloads(getStore("cm-browser").get("downloads", [])).some((row) => !!row.recovery))
      const row = savedDownloads(getStore("cm-browser").get("downloads", []))[0]
      assert(row.recovery && row.recovery.offset < bytes.length)
      await writeFile(join(directory, "download-fixture.json"), JSON.stringify({ port: address.port, id: row.id }))
      await writeFile(join(directory, "checkpoint.json"), JSON.stringify({ pid: process.pid, phase }))
      await new Promise(() => {})
      return
    }
    assert(previous)
    const original = savedDownloads(getStore("cm-browser").get("downloads", [])).find((row) => row.id === previous.id)!
    assert(original.recovery)
    assert.equal(original.state, "interrupted")
    await command({ op: "state" })
    assert.equal(requests, 0, "Restart/history must never authorize network requests")
    await writeFile(original.recovery.destination, "user-created file after crash")
    const source = await readFile(original.recovery.destination)
    const projection = JSON.stringify(downloadHistory())
    assert(!projection.includes("checkpoint") && !projection.includes(origin) && !projection.includes(directory))
    dialog.showMessageBox = (async () => ({ response: 0, checkboxChecked: false })) as typeof show
    await command({ op: "recover-download", id: original.id })
    assert.equal(requests, 0)
    assert.equal(recoveringDownloads().size, 0)
    dialog.showMessageBox = (async () => ({ response: 1, checkboxChecked: false })) as typeof show
    await writeFile(join(directory, "downloads", "fixture (1).bin"), "existing sibling")
    await command({ op: "recover-download", id: original.id })
    await wait(() => !recoveringDownloads().size)
    const completed = savedDownloads(getStore("cm-browser").get("downloads", []))[0]
    assert.equal(completed.state, "completed")
    assert(completed.path?.endsWith("fixture (2).bin"))
    assert.deepEqual(await readFile(completed.path!), bytes)
    assert.deepEqual(await readFile(original.recovery.destination), source)
    assert.equal(await readFile(join(directory, "downloads", "fixture (1).bin"), "utf8"), "existing sibling")
    assert.equal(requests, 1, "Only the missing range should be requested")
    const partSource = join(directory, "fixture-prefix")
    await writeFile(partSource, bytes.subarray(0, 64 * 1024))
    for (const failure of ["no-range", "changed", "redirect", "corrupt", "auth", "blocked"]) {
      mode = failure
      const snapshot = await downloadCheckpoint(
        join(app.getPath("userData"), "browser-download-parts"),
        partSource,
        64 * 1024,
      )
      const recovery = { ...original.recovery, ...snapshot, offset: 64 * 1024 }
      getStore("cm-browser").set("downloads", [{ ...original, recovery }])
      if (failure === "corrupt")
        await writeFile(
          join(app.getPath("userData"), "browser-download-parts", snapshot.checkpoint),
          Buffer.alloc(64 * 1024, 88),
        )
      if (failure === "auth") await session.fromPartition(BROWSER_PARTITION).cookies.remove(origin, "download_auth")
      if (failure === "blocked")
        getStore("cm-browser").set("transferRules", [{ origin: "*", uploads: "ask", downloads: "block" }])
      const before: number = requests
      if (failure === "blocked") await assert.rejects(command({ op: "recover-download", id: original.id }))
      else await command({ op: "recover-download", id: original.id })
      await wait(() => !recoveringDownloads().size)
      assert.equal(savedDownloads(getStore("cm-browser").get("downloads", []))[0].state, "interrupted")
      assert.equal(requests - before, ["blocked", "corrupt"].includes(failure) ? 0 : 1)
      assert.deepEqual(await readFile(original.recovery.destination), source)
      assert.equal((await stat(completed.path!)).size, bytes.length)
      console.log(`PASS native download recovery rejection: ${failure}`)
    }
    console.log(
      "PASS authenticated restart download recovery, consent, exact bytes, safe destination and private projection",
    )
    mode = "valid"
    getStore("cm-browser").set("transferRules", [{ origin: "*", uploads: "ask", downloads: "ask" }])
    getStore("cm-browser").set("preferences", { askDownloadLocation: true })
    await session.fromPartition(BROWSER_PARTITION).cookies.set({ url: origin, name: "download_auth", value: "yes" })
    let choosers = 0
    dialog.showSaveDialogSync = () => {
      choosers++
      return original.recovery!.destination
    }
    await command({ op: "new" })
    const tab = owner.groups.get("download-smoke")!.tabs[0]
    await tab.contents.loadURL(origin)
    await tab.view.webContents.executeJavaScript(
      `(() => { const a = document.createElement('a'); a.href = '/file'; document.body.append(a); a.click(); })()`,
      true,
    )
    await wait(() => downloadHistory().some((row) => row.id !== original.id && row.state === "completed"))
    const normal = savedDownloads(getStore("cm-browser").get("downloads", [])).find((row) => row.id !== original.id)!
    assert.equal(choosers, 1)
    assert.deepEqual(await readFile(normal.path!), bytes)
    assert.deepEqual(await readFile(original.recovery.destination), source)
    assert.equal(normal.recovery, undefined)
    dialog.showSaveDialogSync = () => {
      choosers++
      return ""
    }
    await tab.view.webContents.executeJavaScript(`document.querySelector('a').click()`, true)
    await wait(() => choosers === 2)
    assert.deepEqual(await readFile(original.recovery.destination), source)
    await command({ op: "forget-download", id: original.id })
    await pruneDownloadRecovery()
    assert.deepEqual(await readdir(join(app.getPath("userData"), "browser-download-parts")), [])
    console.log("PASS normal staged completion, native destination choice/cancellation and private-file cleanup")
  } finally {
    dialog.showMessageBox = show
    dialog.showSaveDialogSync = save
    win.destroy()
    server.closeAllConnections()
    await new Promise<void>((resolve) => server.close(() => resolve()))
  }
}
