import { describe, expect, test } from "bun:test"
import vm from "node:vm"
import { join } from "node:path"

describe("WPP content navigation", () => {
  test("asks the main process to start a fresh chat when the control moved outside the assistant frame", async () => {
    const message = element("Existing assistant response")
    let listener = (_event: unknown) => {}
    let requestedAction = ""

    const document = {
      querySelectorAll(selector: string) {
        if (selector.includes("data-message-id")) return [message]
        return []
      },
      querySelector() {
        return null
      },
    }
    const window = {
      addEventListener(_type: string, handler: (event: unknown) => void) {
        listener = handler
      },
      postMessage(frame: { type?: string; requestId?: string; action?: string }) {
        if (frame.type !== "O1_CODE_BRIDGE_MAIN_REQUEST") return
        requestedAction = frame.action || ""
        listener({
          source: window,
          data: {
            source: "o1-code-bridge-controller",
            type: "O1_CODE_BRIDGE_MAIN_RESPONSE",
            requestId: frame.requestId,
            result: { ok: true, clicked: true },
          },
        })
      },
    }
    const context = vm.createContext({
      __O1_CODE_BRIDGE_TEST_HOOKS__: true,
      document,
      window,
      location: { hostname: "open-web-assistant-cs.wpp.ai" },
      process: { versions: { node: "test" } },
      getComputedStyle: () => ({ visibility: "visible", display: "block", pointerEvents: "auto" }),
      setTimeout: (callback: () => void, timeoutMs: number) => {
        if (timeoutMs < 5000) callback()
        return 0
      },
      clearTimeout() {},
    })

    vm.runInContext(await Bun.file(join(import.meta.dir, "injected", "content.js")).text(), context)
    const hooks = vm.runInContext("__o1CodeBridgeContentTest", context)

    await hooks.startFreshChat()

    expect(requestedAction).toBe("startFreshChat")
  })
})

function element(label: string, attributes: Record<string, string> = {}) {
  return {
    clicks: 0,
    innerText: label,
    textContent: label,
    onClick: () => {},
    getAttribute(name: string) {
      return attributes[name] || null
    },
    getBoundingClientRect() {
      return { width: 24, height: 24 }
    },
    click() {
      this.clicks += 1
      this.onClick()
    },
  }
}
