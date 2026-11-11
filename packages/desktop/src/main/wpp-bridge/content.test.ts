import { describe, expect, test } from "bun:test"
import { join } from "node:path"
import vm from "node:vm"

type ContentHarness = {
  imageAttachmentDesync: (error: Error) => Error & { statusCode?: number; type?: string }
  isAttachmentReady: (textarea: unknown, minChips?: number) => boolean
  hasUploadProgressIndicator: (textarea: unknown) => boolean
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

  test("ambient chat spinner does not block attachment ready when upload chips meet minChips", () => {
    const textarea = fakeComposer({
      chips: 1,
      ambientSpinner: true,
      chipSpinner: false,
    })

    expect(harness.hasUploadProgressIndicator(textarea)).toBe(false)
    expect(harness.isAttachmentReady(textarea, 1)).toBe(true)
  })

  test("chip-region upload spinner still blocks attachment ready", () => {
    const textarea = fakeComposer({
      chips: 1,
      ambientSpinner: false,
      chipSpinner: true,
    })

    expect(harness.hasUploadProgressIndicator(textarea)).toBe(true)
    expect(harness.isAttachmentReady(textarea, 1)).toBe(false)
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
      typeof Reflect.get(value, "isAttachmentReady") === "function" &&
      typeof Reflect.get(value, "hasUploadProgressIndicator") === "function" &&
      typeof Reflect.get(value, "pickTokenPill") === "function" &&
      typeof Reflect.get(value, "waitForUpdatedTokenPill") === "function",
  )
}

type FakeEl = {
  className: string
  parentElement: FakeEl | null
  children: FakeEl[]
  attrs: Record<string, string>
  closest: (selector: string) => FakeEl | null
  matches: (selector: string) => boolean
  querySelector: (selector: string) => FakeEl | null
  querySelectorAll: (selector: string) => FakeEl[]
  getAttribute: (name: string) => string | null
  getBoundingClientRect: () => { width: number; height: number }
}

function fakeEl(className = "", attrs: Record<string, string> = {}): FakeEl {
  const el: FakeEl = {
    className,
    parentElement: null,
    children: [],
    attrs: { class: className, ...attrs },
    closest(selector) {
      let current: FakeEl | null = el
      while (current) {
        if (current.matches(selector)) return current
        current = current.parentElement
      }
      return null
    },
    matches(selector) {
      return selector.split(",").some((part) => matchSimpleSelector(el, part.trim()))
    },
    querySelector(selector) {
      return el.querySelectorAll(selector)[0] || null
    },
    querySelectorAll(selector) {
      const out: FakeEl[] = []
      const visit = (node: FakeEl) => {
        if (node !== el && node.matches(selector)) out.push(node)
        for (const child of node.children) visit(child)
      }
      visit(el)
      return out
    },
    getAttribute(name) {
      return el.attrs[name] ?? null
    },
    getBoundingClientRect() {
      return { width: 40, height: 16 }
    },
  }
  return el
}

function matchSimpleSelector(el: FakeEl, selector: string) {
  if (selector === ".chat-input") return el.className.split(/\s+/).includes("chat-input")
  if (selector === "progress") return el.className === "progress"
  if (selector === "[class], [aria-label], [title]") {
    return Boolean(el.attrs.class || el.attrs["aria-label"] || el.attrs.title)
  }
  if (selector === "[class]") return Boolean(el.attrs.class)
  if (selector === "[aria-label]") return Boolean(el.attrs["aria-label"])
  if (selector === "[title]") return Boolean(el.attrs.title)
  if (selector === "[aria-busy='true']") return el.attrs["aria-busy"] === "true"
  if (selector === "[role='progressbar']") return el.attrs.role === "progressbar"
  const classContains = selector.match(/^\[class\*='([^']+)'\]$/)
  if (classContains) return el.className.includes(classContains[1])
  return false
}

function append(parent: FakeEl, child: FakeEl) {
  child.parentElement = parent
  parent.children.push(child)
  return child
}

function fakeComposer(opts: { chips: number; ambientSpinner: boolean; chipSpinner: boolean }) {
  const root = fakeEl("chat-input")
  const list = append(root, fakeEl("file-upload-list"))
  for (let i = 0; i < opts.chips; i++) append(list, fakeEl("file-upload-list-item"))
  if (opts.chipSpinner) append(list, fakeEl("upload-spinner loading"))
  if (opts.ambientSpinner) append(root, fakeEl("thinking-spinner loading"))
  const textarea = fakeEl("composer")
  append(root, textarea)
  return textarea
}
