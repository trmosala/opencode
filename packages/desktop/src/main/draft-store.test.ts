import { expect, test } from "bun:test"

// draft-store persists through node:sqlite, which Electron's Node runtime provides but Bun does not
// implement, so `bun test` cannot exercise it. Skip rather than fail the desktop suite; the import
// is dynamic so the missing built-in module does not abort this file at link time.
let hasNodeSqlite = false
try {
  await import("node:sqlite")
  hasNodeSqlite = true
} catch {
  hasNodeSqlite = false
}

test.skipIf(!hasNodeSqlite)("flushes the latest buffered draft and stores blobs", async () => {
  const { createDesktopDraftStore } = await import("./draft-store")
  const store = createDesktopDraftStore(":memory:")
  store.set("prompt", "first")
  store.set("prompt", "latest")
  expect(store.get("prompt")).toBe("latest")
  store.flush()
  expect(store.get("prompt")).toBe("latest")

  const bytes = new TextEncoder().encode("image")
  const id = store.putBlob(bytes)
  expect(store.getBlob(id)).toEqual(bytes)
  store.close()
})
