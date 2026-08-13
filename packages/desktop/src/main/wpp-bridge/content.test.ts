import { describe, expect, test } from "bun:test"
import { join } from "node:path"
import vm from "node:vm"

type ContentHarness = {
  imageAttachmentDesync: (error: Error) => Error & { statusCode?: number; type?: string }
}

const harness = await loadContentHarness()

describe("WPP content image attachment", () => {
  test("classifies an unknown trusted-paste outcome as a pre-submit attachment desync", () => {
    const error = harness.imageAttachmentDesync(
      new Error('Timed out waiting for main action "pasteImages" after 60000 ms.'),
    )

    expect(error).toMatchObject({
      statusCode: 502,
      type: "o1_code_image_attachment_desync",
    })
  })
})

async function loadContentHarness(): Promise<ContentHarness> {
  const source = await Bun.file(join(import.meta.dir, "injected", "content.js")).text()
  const listeners = new Map<string, (...args: unknown[]) => void>()
  const window = {
    addEventListener(name: string, listener: (...args: unknown[]) => void) {
      listeners.set(name, listener)
    },
    postMessage() {},
  }
  const context = vm.createContext({
    window,
    location: { hostname: "open-web-assistant-cs.wpp.ai", href: "https://open-web-assistant-cs.wpp.ai/" },
    process: { versions: { node: "test" } },
    __O1_CODE_BRIDGE_TEST_HOOKS__: true,
    URL,
    Date,
    Math,
    Map,
    Set,
    Error,
    Promise,
    setTimeout,
    clearTimeout,
  })
  vm.runInContext(source, context)
  const value: unknown = vm.runInContext("__o1CodeBridgeContentTest", context)
  if (!isContentHarness(value)) throw new Error("Content test harness was not installed")
  return value
}

function isContentHarness(value: unknown): value is ContentHarness {
  return Boolean(
    value &&
      typeof value === "object" &&
      typeof Reflect.get(value, "imageAttachmentDesync") === "function",
  )
}
