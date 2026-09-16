import { render } from "solid-js/web"
import { BrowserPanel } from "../src/components/browser-panel/browser-panel"
import type { BrowserPanelPlatform, BrowserTabs } from "../src/browser-panel"

declare global {
  interface Window {
    fixture: {
      browser: BrowserPanelPlatform
      errors: number
      accept(state: BrowserTabs): void
      resolve(id: number, value: unknown, error?: boolean): void
    }
    fixtureRequest(value: string): void
  }
}

let sequence = 0
let acknowledgedViewport = false
const requests = new Map<number, { resolve(value: unknown): void; reject(error: Error): void; viewport?: boolean }>()
const request = (op: string, args: unknown[]) =>
  new Promise<unknown>((resolve, reject) => {
    const id = ++sequence
    const viewport = op === "viewport" ? !!(args[0] as { bounds: unknown }).bounds : undefined
    if (op === "viewport") acknowledgedViewport = false
    requests.set(id, { resolve, reject, viewport })
    window.fixtureRequest(
      JSON.stringify({
        id,
        op,
        args,
        acknowledgedViewport,
        menuOpen: !!document.querySelector("[data-component=dropdown-menu-content]"),
        accounts: document.querySelectorAll("[data-account-id]").length,
      }),
    )
  })

window.fixture = {
  errors: 0,
  accept: () => {},
  resolve(id, value, error) {
    const pending = requests.get(id)
    requests.delete(id)
    if (pending?.viewport !== undefined) acknowledgedViewport = !error && pending.viewport
    if (error) pending?.reject(new Error("Fixture command rejected"))
    else pending?.resolve(value)
  },
  browser: {
    command: (session, command) => request("command", [session, command]) as Promise<BrowserTabs>,
    viewport: (input) => request("viewport", [input]) as Promise<void>,
    subscribe(callback) {
      window.fixture.accept = callback
      return () => {
        window.fixture.accept = () => {}
      }
    },
    onShortcut: () => () => {},
    selection: async () => "",
    pick: async () => undefined,
    screenshot: async () => "",
  },
}
// Minimal layout utilities; real panel, menu, and viewport code run in Chromium.
const style = document.createElement("style")
style.textContent = `.size-full{width:100%;height:100%}.flex{display:flex}.flex-col{flex-direction:column}.flex-1{flex:1}.shrink-0{flex-shrink:0}.min-h-0{min-height:0}.contents{display:contents}.hidden{display:none}.flex-wrap{flex-wrap:wrap}[data-component=dropdown-menu-content]{background:white;max-height:320px;overflow:auto}`
document.head.append(style)
document.body.style.cssText = "margin:0;height:100vh"
const host = document.createElement("div")
host.style.cssText = "height:100vh"
document.body.append(host)
render(() => <BrowserPanel sessionKey="smoke" sessionID="smoke" />, host)
