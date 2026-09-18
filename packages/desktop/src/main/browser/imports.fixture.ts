import assert from "node:assert/strict"
import fs from "node:fs"
import { join } from "node:path"
import { syncBuiltinESMExports } from "node:module"
import { BrowserWindow, dialog, session, safeStorage } from "electron"
import type { MessageBoxOptions } from "electron"
import { browserCommand, browserLinkContext, type registerBrowserOwner } from "./tabs"
import { BROWSER_PARTITION } from "./policy"
import { getStore } from "../store"
import { nativeT } from "../native-translations"
import { vaultAuthentication } from "./vault-auth"
import { vaultAccess } from "./vault-session"
import { readLogins, writeLogins } from "./vault"
import { bookmarks, saveBookmark } from "./bookmarks"

export async function importsSmoke(
  win: BrowserWindow,
  owner: ReturnType<typeof registerBrowserOwner>,
  directory: string,
) {
  const storage = getStore("cm-browser")
  const cookies = session.fromPartition(BROWSER_PARTITION).cookies
  const originals = {
    picker: dialog.showOpenDialog,
    message: dialog.showMessageBox,
    verify: vaultAuthentication.verify,
    encryption: safeStorage.isEncryptionAvailable,
    set: cookies.set,
    get: cookies.get,
    flush: cookies.flushStore,
    open: fs.promises.open,
    rename: fs.renameSync,
  }
  const command = (kind: "passwords" | "cookies" | "bookmarks") =>
    browserCommand(owner, "smoke", kind === "bookmarks" ? { op: "bookmark-import" } : { op: "import", kind })
  const source = join(directory, "PRIVATE_SOURCE")
  const secret = "PRIVATE_SECRET"
  const initial = {
    id: "00000000-0000-4000-8000-000000000001",
    origin: "https://example.test",
    username: "user",
    password: "old",
  }
  const csv = `url,username,password\nhttps://example.test,user,older\nhttps://example.test,user,${secret}\nhttps://new.test,new,${secret}\n`
  let answer = 0
  let pickerCancel = false
  let pickerHook: () => Promise<void> = async () => {}
  let reviewHook: () => Promise<void> = async () => {}
  let fixtureError: unknown
  let review: MessageBoxOptions | undefined
  let result: MessageBoxOptions | undefined
  let sets = 0
  let flushes = 0
  let cases = 0
  const listenerCounts = () => [
    ...["hide", "minimize", "close", "closed"].map((name) => win.listenerCount(name)),
    ...["did-start-navigation", "render-process-gone", "destroyed"].map((name) => win.webContents.listenerCount(name)),
  ]
  const safe = (value: unknown) => {
    const text = String(typeof value === "object" ? JSON.stringify(value) : value)
    assert(!text.includes(secret), "no exported secrets in native UI or renderer response")
    assert(!text.includes(source), "no full source path in native UI or renderer response")
  }
  const run = async (kind: "passwords" | "cookies" | "bookmarks", reject = false) => {
    review = undefined
    result = undefined
    fixtureError = undefined
    const listeners = listenerCounts()
    try {
      if (reject)
        await assert.rejects(command(kind), (error: Error) => {
          safe(error.message)
          return true
        })
      else safe(await command(kind))
    } finally {
      if (fixtureError) throw fixtureError
    }
    assert.equal(owner.suspended, 0)
    assert.deepEqual(listenerCounts(), listeners, "import listeners released")
    cases++
  }
  const detail = () => {
    assert(result)
    return result.detail ?? ""
  }
  const reviewCounts = (counts: Record<string, number>) => {
    assert(review)
    for (const [key, value] of Object.entries(counts))
      assert(review.detail?.includes(`${key}: ${value}`), `${key} count`)
    assert(review.detail?.includes("plaintext"))
    assert(review.detail?.includes("not app or WPP"))
  }
  try {
    vaultAuthentication.verify = async () => {}
    await vaultAccess.unlock(win)
    writeLogins([initial])
    browserLinkContext(owner, "smoke", "imports")
    dialog.showOpenDialog = (async () => {
      try {
        await pickerHook()
        return { canceled: pickerCancel, filePaths: pickerCancel ? [] : [source] }
      } catch (error) {
        fixtureError = error
        throw error
      }
    }) as typeof dialog.showOpenDialog
    dialog.showMessageBox = (async (first: BrowserWindow | MessageBoxOptions, second?: MessageBoxOptions) => {
      try {
        const options = second ?? (first as MessageBoxOptions)
        safe(options)
        if (options.message === nativeT("desktop.browser.import.review")) {
          assert.equal(options.defaultId, 0)
          assert.equal(options.cancelId, 0)
          assert.equal(options.buttons?.[0], nativeT("desktop.browser.cancel"))
          review = options
          await reviewHook()
          return { response: answer, checkboxChecked: false }
        }
        assert.equal(options.message, nativeT("desktop.browser.import.result"))
        result = options
        return { response: 0, checkboxChecked: false }
      } catch (error) {
        fixtureError = error
        throw error
      }
    }) as typeof dialog.showMessageBox
    cookies.set = async (row) => {
      sets++
      return originals.set.call(cookies, row)
    }
    cookies.flushStore = async () => {
      flushes++
      return originals.flush.call(cookies)
    }

    fs.writeFileSync(source, csv)
    const before = JSON.stringify(storage.store)
    pickerCancel = true
    await run("passwords")
    assert.equal(JSON.stringify(storage.store), before)
    pickerCancel = false
    await run("passwords")
    reviewCounts({ "Valid rows": 3, "Duplicate source rows": 1, Add: 1, Replace: 1 })
    assert.equal(JSON.stringify(storage.store), before)
    assert.equal(result, undefined)
    answer = 1
    await run("passwords")
    assert.equal(readLogins().find((row) => row.username === "user")?.id, initial.id)
    assert.equal(readLogins().find((row) => row.username === "user")?.password, secret)
    assert(detail().includes("Saved: 2"))
    const imported = JSON.stringify(storage.store)
    await run("passwords")
    assert.equal(JSON.stringify(storage.store), imported, "repeat import has no encrypted-store write")
    reviewCounts({ Add: 0, Replace: 0, Unchanged: 2 })
    console.log("PASS imports: picker/review cancellation, counts, last-row-wins, stable IDs and repeated no-op")

    storage.delete("vault")
    storage.set("credentials", [
      {
        origin: initial.origin,
        username: initial.username,
        encrypted: safeStorage.encryptString("legacy").toString("base64"),
      },
    ])
    const legacy = JSON.stringify(storage.store)
    const legacyID = readLogins(false)[0].id
    assert.equal(readLogins(false)[0].id, legacyID)
    answer = 0
    await run("passwords")
    assert.equal(JSON.stringify(storage.store), legacy, "cancel cannot migrate legacy vault")
    answer = 1
    await run("passwords")
    assert.equal(readLogins()[0].id, legacyID)
    assert.equal(storage.has("credentials"), false)
    console.log("PASS imports: legacy preview is non-mutating with stable IDs")

    for (const phase of ["picker", "review"] as const) {
      const change = async () => {
        vaultAccess.lock()
        await vaultAccess.unlock(win)
      }
      if (phase === "picker") pickerHook = change
      else reviewHook = change
      const before = JSON.stringify(storage.store)
      await run("passwords", true)
      assert.equal(JSON.stringify(storage.store), before)
      pickerHook = async () => {}
      reviewHook = async () => {}
    }
    vaultAccess.lock()
    await run("passwords", true)
    await vaultAccess.unlock(win)
    safeStorage.isEncryptionAvailable = () => false
    await run("passwords", true)
    safeStorage.isEncryptionAvailable = originals.encryption
    for (const change of [
      async () => {
        browserLinkContext(owner, "other", "other")
        browserLinkContext(owner, "smoke", "imports")
      },
      async () => {
        win.hide()
        win.showInactive()
        await vaultAccess.unlock(win)
      },
      async () => {
        await win.reload()
        await new Promise<void>((resolve) => win.webContents.once("did-finish-load", () => resolve()))
        await vaultAccess.unlock(win)
      },
    ]) {
      pickerHook = change
      const before = JSON.stringify(storage.store)
      await run("passwords", true)
      assert.equal(JSON.stringify(storage.store), before)
      pickerHook = async () => {}
    }
    reviewHook = async () => {
      writeLogins([{ ...initial, password: "concurrent" }])
    }
    await run("passwords", true)
    assert.equal(readLogins()[0].password, "concurrent")
    reviewHook = async () => {
      await assert.rejects(command("bookmarks"))
    }
    answer = 0
    await run("passwords")
    reviewHook = async () => {}
    answer = 1
    console.log(
      "PASS imports: original vault, task round-trip, hide/show, renderer reload, stale destination and concurrent admission",
    )

    for (const [kind, text] of [
      ["passwords", 'url,username,password\nhttps://example.test,user,PRIVATE_SECRET"bad'],
      ["cookies", '[{"value":"PRIVATE_SECRET"'],
      [
        "cookies",
        JSON.stringify([
          { domain: "example.test", name: "s", value: secret, partitionKey: { topLevelSite: "https://example.test" } },
        ]),
      ],
      ["bookmarks", "<p>not a bookmark export</p>"],
    ] as const) {
      fs.writeFileSync(source, text)
      const before = JSON.stringify(storage.store)
      await run(kind, true)
      assert.equal(JSON.stringify(storage.store), before)
      assert.equal(sets, 0)
      assert.equal(review, undefined)
    }
    fs.unlinkSync(source)
    await run("passwords", true)
    fs.mkdirSync(source)
    await run("passwords", true)
    fs.rmdirSync(source)
    fs.writeFileSync(source, "x".repeat(5 * 1024 * 1024 + 1))
    await run("passwords", true)
    fs.writeFileSync(source, csv)
    let closed = 0
    fs.promises.open = (async (...args: Parameters<typeof fs.promises.open>) => {
      const handle = await originals.open(...args)
      const close = handle.close.bind(handle)
      handle.close = async () => {
        closed++
        return close()
      }
      handle.read = async () => {
        throw new Error(source + secret)
      }
      return handle
    }) as typeof fs.promises.open
    syncBuiltinESMExports()
    await run("passwords", true)
    assert.equal(closed, 1, "read failure closes descriptor")
    fs.promises.open = originals.open
    syncBuiltinESMExports()
    fs.renameSync = () => {
      throw new Error(source + secret)
    }
    syncBuiltinESMExports()
    const beforeFailure = JSON.stringify(storage.store)
    await run("passwords", true)
    assert.equal(JSON.stringify(storage.store), beforeFailure, "atomic write failure preserves destination")
    fs.renameSync = originals.rename
    syncBuiltinESMExports()
    console.log(
      "PASS imports: malformed/unsupported/missing/directory/oversized/read-failed exports, descriptor cleanup and atomic write failure",
    )

    saveBookmark({ url: "https://example.test/", title: "Keep", pinned: true, folder: ["Existing"] })
    fs.writeFileSync(
      source,
      '<DL><DT><A HREF="https://example.test:443">Replace?</A><DT><H3>Imported</H3><DL><DT><A HREF="https://new.test">First</A><A HREF="https://new.test/">Second</A><A HREF="javascript:alert(1)">Unsafe</A></DL></DL>',
    )
    const beforeBookmarks = JSON.stringify(storage.store)
    answer = 0
    await run("bookmarks")
    assert.equal(JSON.stringify(storage.store), beforeBookmarks)
    reviewCounts({ "Valid rows": 3, "Duplicate source rows": 1, Add: 1, Unchanged: 1, "Unsupported rows skipped": 1 })
    answer = 1
    await run("bookmarks")
    assert.equal(bookmarks().find((row) => row.url === "https://example.test/")?.title, "Keep")
    assert.deepEqual(bookmarks().find((row) => row.url === "https://example.test/")?.folder, ["Existing"])
    assert.equal(bookmarks().find((row) => row.url === "https://example.test/")?.pinned, true)
    assert.equal(bookmarks().find((row) => row.url === "https://new.test/")?.title, "First")
    assert.deepEqual(bookmarks().find((row) => row.url === "https://new.test/")?.folder, ["Imported"])
    const afterBookmarks = JSON.stringify(storage.store)
    await run("bookmarks")
    assert.equal(JSON.stringify(storage.store), afterBookmarks)
    reviewHook = async () => {
      saveBookmark({ url: "https://new.test/", title: "Concurrent", pinned: false })
    }
    await run("bookmarks", true)
    assert.equal(bookmarks().find((row) => row.url === "https://new.test/")?.title, "Concurrent")
    reviewHook = async () => {}
    console.log(
      "PASS imports: bookmark review, normalized existing preservation, first-row wins, repeat no-op and stale destination",
    )

    const rows = [0, 1, 2].map((index) => ({
      domain: ".imports.test",
      name: `cookie${index}`,
      value: secret,
      secure: true,
      httpOnly: true,
      sameSite: "lax",
      path: "/",
      session: true,
    }))
    fs.writeFileSync(source, JSON.stringify([rows[0], { ...rows[0], value: "last" }, ...rows.slice(1)]))
    answer = 0
    await run("cookies")
    assert.equal(sets, 0)
    assert.equal(flushes, 0)
    answer = 1
    await run("cookies")
    assert.equal(sets, 3)
    assert.equal(flushes, 1)
    assert.equal((await originals.get.call(cookies, { name: "cookie0" }))[0].value, "last")
    reviewHook = async () => {}
    fs.writeFileSync(
      source,
      JSON.stringify(
        [{ ...rows[0], value: "last" }, ...rows.slice(1)].map((row) => ({ ...row, domain: "IMPORTS.test" })),
      ),
    )
    await run("cookies")
    assert.equal(sets, 3)
    assert.equal(flushes, 1)
    reviewCounts({ Add: 0, Replace: 0, Unchanged: 3 })
    reviewHook = async () => {
      await originals.set.call(cookies, {
        url: "https://imports.test",
        domain: ".imports.test",
        name: "cookie0",
        value: "concurrent",
        path: "/",
        secure: true,
        httpOnly: true,
        sameSite: "lax",
      })
    }
    await run("cookies")
    assert.equal(sets, 3)
    assert(detail().includes("Unattempted writes: 0"))
    assert(detail().includes("destination changed"))
    reviewHook = async () => {}
    console.log("PASS imports: cookie cancellation, dedup/last-row wins, repeated no-op and stale destination")

    for (const mode of ["middle", "flush", "owner", "destination"] as const) {
      await session.fromPartition(BROWSER_PARTITION).clearStorageData({ storages: ["cookies"] })
      fs.writeFileSync(source, JSON.stringify(rows))
      sets = 0
      flushes = 0
      cookies.set = async (row) => {
        sets++
        if (sets === 2 && (mode === "middle" || mode === "flush")) throw new Error(source + secret)
        await originals.set.call(cookies, row)
        if (sets === 1 && mode === "owner") {
          browserLinkContext(owner, "other", "other")
          browserLinkContext(owner, "smoke", "imports")
        }
        if (sets === 1 && mode === "destination")
          await originals.set.call(cookies, {
            url: "https://imports.test",
            domain: ".imports.test",
            name: "cookie1",
            value: "concurrent",
            path: "/",
          })
      }
      cookies.flushStore = async () => {
        flushes++
        if (mode === "flush") throw new Error(source + secret)
        return originals.flush.call(cookies)
      }
      await run("cookies")
      assert.equal(flushes, 1)
      assert.equal(sets, mode === "middle" || mode === "flush" ? 2 : 1)
      assert(detail().includes("Successful writes: 1"))
      assert(detail().includes(`Failed writes: ${mode === "middle" || mode === "flush" ? 1 : 0}`))
      assert(detail().includes(`Unattempted writes: ${mode === "middle" || mode === "flush" ? 1 : 2}`))
      assert(detail().includes(mode === "flush" ? "durable saving is not confirmed" : "were flushed"))
      assert.equal((await originals.get.call(cookies, { name: "cookie0" })).length, 1)
    }
    console.log(
      "PASS imports: cookie middle failure, flush failure, owner interruption and per-write destination recheck",
    )
    await session.fromPartition(BROWSER_PARTITION).clearStorageData({ storages: ["cookies"] })
    fs.writeFileSync(source, JSON.stringify([rows[0]]))
    sets = 0
    flushes = 0
    cookies.set = async (row) => {
      sets++
      return originals.set.call(cookies, row)
    }
    cookies.flushStore = async () => {
      flushes++
      await originals.flush.call(cookies)
      browserLinkContext(owner, "other", "other")
      browserLinkContext(owner, "smoke", "imports")
    }
    await run("cookies")
    assert.equal(sets, 1)
    assert.equal(flushes, 1)
    assert(detail().includes("Successful writes: 1"))
    assert(detail().includes("were flushed"))
    assert(detail().includes("destination changed"))
    cookies.flushStore = async () => {
      flushes++
      return originals.flush.call(cookies)
    }
    fs.writeFileSync(source, JSON.stringify([{ ...rows[0], value: "replacement" }]))
    await run("cookies")
    reviewCounts({ Add: 0, Replace: 1, Unchanged: 0 })
    assert.equal((await originals.get.call(cookies, { name: "cookie0" }))[0].value, "replacement")
    assert(detail().includes("Successful writes: 1"))
    console.log("PASS imports: post-flush invalidation and reviewed cookie replacement")
    const ipFailures: unknown[] = []
    for (const mode of ["replace", "noop", "destination", "dedup"] as const) {
      try {
        const ip = {
          domain: "127.0.0.1",
          name: `ip-${mode}`,
          value: mode === "noop" ? "before" : "after",
          path: "/",
          secure: true,
          httpOnly: true,
          sameSite: "lax" as const,
        }
        const seed = { ...ip, url: "https://127.0.0.1/", value: "before" }
        if (mode !== "dedup") {
          await originals.set.call(cookies, seed)
          const stored = await originals.get.call(cookies, { name: ip.name })
          assert.equal(stored.length, 1)
          assert.equal(stored[0].domain, "127.0.0.1")
          assert.equal(stored[0].hostOnly, true, "Chromium canonicalizes an IPv4 Domain attribute to host-only")
        }
        fs.writeFileSync(
          source,
          JSON.stringify(
            mode === "dedup"
              ? [ip, { ...ip, hostOnly: true, value: "middle" }, { ...ip, domain: ".127.0.0.1", value: "last" }]
              : [ip],
          ),
        )
        sets = 0
        flushes = 0
        reviewHook = async () => {
          if (mode === "destination") await originals.set.call(cookies, { ...seed, value: "concurrent" })
        }
        await run("cookies")
        if (mode === "replace") {
          reviewCounts({ Add: 0, Replace: 1, Unchanged: 0 })
          assert.equal(sets, 1)
          assert.equal(flushes, 1)
          await run("cookies")
          reviewCounts({ Add: 0, Replace: 0, Unchanged: 1 })
          assert.equal(sets, 1, "repeated IPv4 import must not write again")
          assert.equal(flushes, 1)
        }
        if (mode === "noop") {
          reviewCounts({ Add: 0, Replace: 0, Unchanged: 1 })
          assert.equal(sets, 0)
          assert.equal(flushes, 0)
        }
        if (mode === "destination") {
          assert.equal(sets, 0, "a concurrent IPv4 destination change must prevent import writes")
          assert.equal(flushes, 0)
          assert(detail().includes("destination changed"))
          assert(detail().includes("Unattempted writes: 1"))
        }
        if (mode === "dedup") {
          reviewCounts({ "Valid rows": 3, "Duplicate source rows": 2, Add: 1, Replace: 0 })
          assert.equal(sets, 1)
          assert.equal(flushes, 1)
          assert(detail().includes("Import processing finished"))
          assert(detail().includes("Successful writes: 1"))
        }
        const stored = await originals.get.call(cookies, { name: ip.name })
        assert.equal(stored.length, 1)
        assert.equal(stored[0].hostOnly, true)
        assert.equal(stored[0].value, mode === "destination" ? "concurrent" : mode === "dedup" ? "last" : ip.value)
        console.log(`PASS imports: IPv4 ${mode}`)
      } catch (error) {
        console.error(`FAIL imports: IPv4 ${mode}`, error)
        ipFailures.push(error)
      } finally {
        reviewHook = async () => {}
      }
    }
    assert.equal(ipFailures.length, 0, "IPv4 production-command regressions")
    console.log(`PASS imports: ${cases} production-flow cases; listeners and native ownership released`)
  } finally {
    dialog.showOpenDialog = originals.picker
    dialog.showMessageBox = originals.message
    vaultAuthentication.verify = originals.verify
    safeStorage.isEncryptionAvailable = originals.encryption
    cookies.set = originals.set
    cookies.get = originals.get
    cookies.flushStore = originals.flush
    fs.promises.open = originals.open
    fs.renameSync = originals.rename
    syncBuiltinESMExports()
    vaultAccess.lock()
  }
}
