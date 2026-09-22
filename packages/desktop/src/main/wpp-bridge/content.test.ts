import { describe, expect, test } from "bun:test"
import { join } from "node:path"
import vm from "node:vm"

type ContentHarness = {
  imageAttachmentDesync: (error: Error) => Error & { statusCode?: number; type?: string }
  pickTokenPill: (elements: unknown[]) => { value: number; text: string } | null
  waitForUpdatedTokenPill: (
    before: { totalTokens: number } | null,
    options: {
      read: () => { totalTokens: number; source: string; scope: string; fidelity: string } | null
      sleep: () => Promise<void>
      timeoutMs: number
      pollMs: number
    },
  ) => Promise<{ measurement: Record<string, unknown> | null; observation: Record<string, unknown> }>
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

describe("WPP token pill settlement", () => {
  test("reads the current response tag aria-label and chooses the newest pill", () => {
    const element = (value: string) => ({
      textContent: value,
      getAttribute: (name: string) => (name === "aria-label" ? `${value} tokens` : null),
      getBoundingClientRect: () => ({ width: 40, height: 16 }),
      querySelectorAll: () => [],
    })

    expect(harness.pickTokenPill([element("3,891"), element("4,120")])).toMatchObject({
      value: 4120,
      text: "4,120 tokens",
    })
  })

  test("rejects the unchanged network-complete pill and accepts its delayed update", async () => {
    const values = [
      { totalTokens: 100, source: "dom-pill", scope: "context", fidelity: "confirmed" },
      { totalTokens: 125, source: "dom-pill", scope: "context", fidelity: "confirmed" },
    ]
    const result = await harness.waitForUpdatedTokenPill(
      { totalTokens: 100 },
      {
        read: () => values.shift() ?? null,
        sleep: async () => {},
        timeoutMs: 10,
        pollMs: 1,
      },
    )

    expect(result.measurement).toMatchObject({ totalTokens: 125, source: "dom-pill", fidelity: "confirmed" })
    expect(result.observation).toMatchObject({ before: 100, networkComplete: 100, settled: 125 })
  })

  test("returns no measurement when the pill never changes", async () => {
    const result = await harness.waitForUpdatedTokenPill(
      { totalTokens: 100 },
      {
        read: () => ({ totalTokens: 100, source: "dom-pill", scope: "context", fidelity: "confirmed" }),
        sleep: async () => {},
        timeoutMs: 0,
        pollMs: 1,
      },
    )

    expect(result.measurement).toBeNull()
    expect(result.observation).toMatchObject({ before: 100, networkComplete: 100, settled: 100 })
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
    getComputedStyle: () => ({ visibility: "visible", display: "block" }),
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
      typeof Reflect.get(value, "imageAttachmentDesync") === "function" &&
      typeof Reflect.get(value, "pickTokenPill") === "function" &&
      typeof Reflect.get(value, "waitForUpdatedTokenPill") === "function",
  )
}
