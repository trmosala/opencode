import assert from "node:assert/strict"
import { BrowserWindow, dialog, session } from "electron"
import type { browserCommand, registerBrowserOwner } from "./tabs"
import { browserRegistration } from "./registry"
import { getStore } from "../store"
import { bookmarks, saveBookmark } from "./bookmarks"

const wait = async (check: () => boolean | Promise<boolean>) => {
  for (let i = 0; i < 150; i++) {
    if (await check()) return
    await new Promise((resolve) => setTimeout(resolve, 40))
  }
  throw new Error("Site-data fixture timed out")
}

export async function siteDataSmoke(
  win: BrowserWindow,
  owner: ReturnType<typeof registerBrowserOwner>,
  command: (value: Parameters<typeof browserCommand>[2]) => ReturnType<typeof browserCommand>,
  port: number,
) {
  const primary = `http://a.site-data.test:${port}/`
  const sibling = `http://b.site-data.test:${port}/`
  const unrelated = `http://unrelated.test:${port}/`
  const create = async (url: string) => {
    const id = (await command({ op: "new" })).activeID!
    await command({ op: "navigate", tabID: id, url })
    const contents = owner.groups.get("smoke")!.tabs.find((tab) => tab.id === id)!.view.webContents
    await wait(() => !contents.isLoadingMainFrame())
    assert(browserRegistration("smoke", id))
    return { id, contents }
  }
  const first = await create(primary)
  const matching = await create(primary)
  const siblingTab = await create(sibling)
  const unrelatedTab = await create(unrelated)
  await first.contents.executeJavaScript(
    `Promise.all([
    new Promise((resolve, reject) => {
      const request = indexedDB.open("site-data", 1)
      request.onupgradeneeded = () => request.result.createObjectStore("records")
      request.onerror = () => reject(request.error)
      request.onsuccess = () => {
        const transaction = request.result.transaction("records", "readwrite")
        transaction.objectStore("records").put("x".repeat(65536), "stored")
        transaction.oncomplete = () => { request.result.close(); resolve(true) }
        transaction.onerror = () => reject(transaction.error)
      }
    }),
    Promise.resolve(localStorage.setItem("primary", "remove")),
  ])`,
    true,
  )
  await siblingTab.contents.executeJavaScript(`localStorage.setItem("sibling", "keep")`, true)
  await unrelatedTab.contents.executeJavaScript(`localStorage.setItem("unrelated", "keep")`, true)
  await first.contents.session.cookies.set({
    url: primary,
    domain: ".site-data.test",
    name: "parent-cookie",
    value: "remove",
  })
  await first.contents.session.cookies.set({ url: unrelated, name: "unrelated-cookie", value: "keep" })
  await session.defaultSession.cookies.set({ url: primary, name: "app-cookie", value: "keep" })
  await session.fromPartition("persist:wpp").cookies.set({ url: primary, name: "wpp-cookie", value: "keep" })
  getStore("cm-browser").set("history", [{ id: "site-data-history", url: primary, title: "Keep", time: Date.now() }])
  saveBookmark({ url: primary, title: "Keep", pinned: false })

  let inspected = await command({ op: "inspect-site", tabID: first.id })
  await wait(async () => {
    inspected = await command({ op: "inspect-site", tabID: first.id })
    const data = inspected.tabs.find((tab) => tab.id === first.id)?.siteData
    return !!data?.usage && data.storage.includes("indexedDB")
  })
  const before = inspected.tabs.find((tab) => tab.id === first.id)?.siteData
  assert.equal(before?.origin, new URL(primary).origin)
  assert.equal(before?.cookies, 1)
  assert(before.usage! > 0)

  let firstLoads = 0
  let matchingLoads = 0
  let siblingLoads = 0
  let unrelatedLoads = 0
  first.contents.on("did-finish-load", () => firstLoads++)
  matching.contents.on("did-finish-load", () => matchingLoads++)
  siblingTab.contents.on("did-finish-load", () => siblingLoads++)
  unrelatedTab.contents.on("did-finish-load", () => unrelatedLoads++)
  const showMessageBox = dialog.showMessageBox.bind(dialog)
  dialog.showMessageBox = (async () => ({ response: 1, checkboxChecked: false })) as typeof dialog.showMessageBox
  try {
    await command({ op: "clear-site", tabID: first.id })
  } finally {
    dialog.showMessageBox = showMessageBox
  }
  await wait(() => firstLoads === 1 && matchingLoads === 1)
  await wait(() => !first.contents.isLoadingMainFrame() && !matching.contents.isLoadingMainFrame())
  assert.equal(siblingLoads, 0)
  assert.equal(unrelatedLoads, 0)
  assert.equal(await first.contents.executeJavaScript(`localStorage.getItem("primary")`), null)
  assert.equal(
    await first.contents.executeJavaScript(
      `indexedDB.databases().then((rows) => rows.some((row) => row.name === "site-data"))`,
    ),
    false,
  )
  assert.equal(await siblingTab.contents.executeJavaScript(`localStorage.getItem("sibling")`), "keep")
  assert.equal(await unrelatedTab.contents.executeJavaScript(`localStorage.getItem("unrelated")`), "keep")
  assert.equal((await first.contents.session.cookies.get({ url: sibling, name: "parent-cookie" })).length, 0)
  assert.equal(
    (await first.contents.session.cookies.get({ url: unrelated, name: "unrelated-cookie" }))[0].value,
    "keep",
  )
  assert.equal((await session.defaultSession.cookies.get({ url: primary, name: "app-cookie" }))[0].value, "keep")
  assert.equal(
    (await session.fromPartition("persist:wpp").cookies.get({ url: primary, name: "wpp-cookie" }))[0].value,
    "keep",
  )
  const history = getStore("cm-browser").get("history", [])
  assert(Array.isArray(history))
  assert.equal(history.length, 1)
  assert.equal(bookmarks().length, 1)
  const after = await command({ op: "inspect-site", tabID: first.id })
  assert.equal(after.tabs.find((tab) => tab.id === first.id)?.siteData?.cookies, 0)
}
