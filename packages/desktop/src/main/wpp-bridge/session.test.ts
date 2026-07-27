import { expect, mock, test } from "bun:test"

let onResponseStarted: (details: {
  statusCode: number
  url: string
  webContents?: typeof webContents
}) => void
const calls: unknown[] = []
const fakeSession = {
  webRequest: {
    onResponseStarted(listener: typeof onResponseStarted) {
      onResponseStarted = listener
    },
  },
  clearStorageData: async (options: unknown) => {
    calls.push(options)
  },
}
const webContents = {
  id: 1,
  isDestroyed: () => false,
  reloadIgnoringCache: () => calls.push("reload"),
}

mock.module("electron", () => ({
  BrowserWindow: Object,
  session: { fromPartition: () => fakeSession },
}))

const { wppSession } = await import("./session")

test("returns an expired WPP session to sign-in once", async () => {
  wppSession()
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
