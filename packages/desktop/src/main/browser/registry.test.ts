import { expect, test } from "bun:test"
import { registerKnownBrowserWebview, resolveBrowserTarget } from "./registry"

function guest(ownerID: number, id = 10) {
  let destroyed = false
  let onDestroyed = () => {}
  const value = {
    id,
    isDestroyed: () => destroyed,
    getType: () => "webview" as const,
    hostWebContents: { id: ownerID },
    once: (_event: "destroyed", listener: () => void) => {
      onDestroyed = listener
      return undefined as never
    },
  }
  return {
    value,
    setOwner: (next: number) => {
      ;(value.hostWebContents as { id: number }).id = next
    },
    destroy: () => {
      destroyed = true
      onDestroyed()
    },
  }
}

test("routes only the webview registered to the exact session", () => {
  const view = guest(1)
  view.setOwner(1)
  registerKnownBrowserWebview(1, "ses_exact", view.value)
  expect(resolveBrowserTarget("ses_exact")?.contents).toBe(view.value)
  expect(resolveBrowserTarget("ses_other")).toBeUndefined()
  view.destroy()
  expect(resolveBrowserTarget("ses_exact")).toBeUndefined()
})

test("rejects a guest owned by another renderer", () => {
  const view = guest(2)
  view.setOwner(2)
  expect(() => registerKnownBrowserWebview(1, "ses_wrong_owner", view.value)).toThrow(/does not belong/)
})
