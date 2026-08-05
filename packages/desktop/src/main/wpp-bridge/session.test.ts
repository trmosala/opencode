import { expect, test } from "bun:test"
import { desktopElectronMock } from "../../../test/preload"
import { WPP_PARTITION, wppSession } from "./session"

// Drives the real onResponseStarted callback that session.ts registers on the shared electron stub
// from the desktop test preload. Registering the stub there rather than here keeps the assertion
// independent of which test file links session.ts first.
const calls: unknown[] = []
const partitionSession = desktopElectronMock.session.fromPartition(WPP_PARTITION)
partitionSession.clearStorageData = async (options?: unknown) => {
  calls.push(options)
}

const webContents = {
  id: 1,
  isDestroyed: () => false,
  reloadIgnoringCache: () => calls.push("reload"),
}

test("returns an expired WPP session to sign-in once", async () => {
  wppSession()
  const onResponseStarted = desktopElectronMock.responseStartedListeners.at(-1)
  expect(onResponseStarted).toBeDefined()
  if (!onResponseStarted) return

  onResponseStarted({
    statusCode: 401,
    url: "https://ogilvy.os.wpp.com/api/users/me",
    webContents,
  })
  await Bun.sleep(0)

  expect(calls).toEqual([
    {
      origin: "https://ogilvy.os.wpp.com",
      storages: ["cookies", "localstorage"],
    },
    "reload",
  ])

  onResponseStarted({
    statusCode: 401,
    url: "https://ogilvy.os.wpp.com/api/users/me",
    webContents,
  })
  await Bun.sleep(0)

  expect(calls).toHaveLength(2)
})
