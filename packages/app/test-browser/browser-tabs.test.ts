import { afterAll, afterEach, beforeAll, beforeEach, expect, test } from "bun:test"
import { mkdtemp, rm } from "node:fs/promises"
import { join, resolve } from "node:path"
import { pathToFileURL } from "node:url"
import { build } from "vite"
import solid from "vite-plugin-solid"
import type { BrowserCommand, BrowserTabs } from "../src/browser-panel"

const initial: BrowserTabs = {
  sessionID: "task",
  activeID: "preview",
  tabs: [
    { id: "preview", title: "Preview", url: "http://localhost:4444", pinned: true },
    { id: "docs", title: "Docs", url: "https://example.test/docs", pinned: false },
    { id: "blank", title: "", url: "about:blank", pinned: false },
  ].map((tab) => ({
    loading: false,
    loadFailed: false,
    canGoBack: false,
    canGoForward: false,
    agentAccess: false,
    ...tab,
  })),
}

let directory: string
let fixture: {
  mount(
    host: HTMLElement,
    tabs: BrowserTabs,
    command: (command: BrowserCommand) => Promise<unknown>,
  ): { dispose(): void; update(tabs: BrowserTabs): void }
}
let mounted: ReturnType<typeof fixture.mount>
let host: HTMLDivElement
let style: HTMLStyleElement
let state: BrowserTabs
let reply: (command: BrowserCommand) => Promise<unknown>
const calls: BrowserCommand[] = []

beforeAll(async () => {
  directory = await mkdtemp(resolve("test-browser/.tabs-"))
  await build({
    configFile: false,
    root: resolve("."),
    logLevel: "warn",
    plugins: [
      {
        name: "tabs-fixture",
        enforce: "pre",
        resolveId(id) {
          const normalized = id.replaceAll("\\", "/")
          for (const name of ["tabs-fixture", "@/context/language", "@/context/platform", "@/context/settings"]) {
            if (id === name || normalized === resolve(name.replace("@/", "src/")).replaceAll("\\", "/"))
              return "\0" + name
          }
          return null
        },
        load(id) {
          if (id === "\0@/context/settings")
            return `export const useSettings = () => ({ general: { newLayoutDesigns: () => false } });`
          if (id === "\0@/context/platform") return `export const usePlatform = () => ({ os: "windows" });`
          if (id === "\0@/context/language")
            return `import { browser } from ${JSON.stringify(resolve("src/i18n/en.ts"))};
              export const useLanguage = () => ({ t: (key, params = {}) => Object.entries(params).reduce((text, [key, value]) => text.replaceAll("{{" + key + "}}", String(value)), browser[key] ?? key) });`
          if (id === "\0tabs-fixture")
            return `import { createComponent } from "solid-js";
              import { render } from "solid-js/web";
              import { createStore, reconcile } from "solid-js/store";
              import { BrowserTabStrip } from ${JSON.stringify(resolve("src/components/browser-panel/browser-tab-strip.tsx"))};
              export function mount(host, tabs, command) {
                const [state, setState] = createStore({ tabs: structuredClone(tabs) });
                const dispose = render(() => createComponent(BrowserTabStrip, {
                  get tabs() { return state.tabs }, command
                }), host);
                return { dispose, update: tabs => setState("tabs", reconcile(structuredClone(tabs))) };
              }`
          return null
        },
      },
      solid(),
    ],
    resolve: { alias: { "@": resolve("src") } },
    build: {
      outDir: directory,
      emptyOutDir: false,
      minify: false,
      lib: { entry: "tabs-fixture", formats: ["es"], fileName: () => "tabs.mjs" },
    },
  })
  fixture = await import(pathToFileURL(join(directory, "tabs.mjs")).href)
}, 60_000)

beforeEach(() => {
  host = document.createElement("div")
  document.body.append(host)
  // Happy DOM has no stylesheet defaults or animation completion events.
  style = document.createElement("style")
  style.textContent = "[data-component=dropdown-menu-content]{animation-name:none;transition-property:none}"
  document.head.append(style)
  state = structuredClone(initial)
  calls.length = 0
  reply = async (command) => {
    if (command.op === "select") update({ ...state, activeID: command.tabID })
  }
  mounted = fixture.mount(host, state, (command) => {
    calls.push(command)
    return reply(command)
  })
})

afterEach(() => {
  mounted?.dispose()
  host?.remove()
  style?.remove()
})

afterAll(async () => {
  if (directory) await rm(directory, { recursive: true, force: true })
})

function update(tabs: BrowserTabs) {
  state = tabs
  mounted.update(tabs)
}

function tabs() {
  return [...host.querySelectorAll<HTMLButtonElement>('[role="tab"]')]
}

function button(label: string) {
  const element = [...host.querySelectorAll<HTMLButtonElement>("[data-slot=browser-tab-controls] button")].find(
    (element) => element.getAttribute("aria-label") === label,
  )
  expect(element).toBeDefined()
  return element!
}

function key(element: HTMLElement, key: string, options: KeyboardEventInit = {}) {
  const event = new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true, ...options })
  element.dispatchEvent(event)
  return event
}

function settled() {
  return new Promise<void>((resolve) => setImmediate(resolve))
}

test("selection exposes current tab ARIA and keeps pinned actions separate from the tab button", async () => {
  expect(host.querySelector('[role="tablist"]')?.getAttribute("aria-label")).toBe("Browser tabs")
  expect(tabs().map((tab) => tab.getAttribute("aria-label"))).toEqual(["Preview", "Docs", "New tab"])
  expect(tabs().map((tab) => tab.getAttribute("aria-selected"))).toEqual(["true", "false", "false"])
  expect(tabs().map((tab) => tab.tabIndex)).toEqual([0, -1, -1])
  expect(tabs().map((tab) => tab.getAttribute("aria-busy"))).toEqual(["false", "false", "false"])
  expect(tabs()[0].getAttribute("aria-description")).toBe("Pinned tab")
  expect(tabs()[1].hasAttribute("aria-description")).toBe(false)
  expect(tabs()[0].title).toBe("Preview\nhttp://localhost:4444")
  expect(tabs()[0].querySelector("[data-slot=browser-tab-icon]")?.getAttribute("aria-hidden")).toBe("true")
  expect(tabs()[0].querySelector("[data-slot=browser-tab-title]")?.textContent).toBe("Preview")
  expect(tabs()[0].querySelector("[data-slot=browser-tab-initial]")?.textContent).toBe("P")
  expect(tabs().every((tab) => !tab.querySelector("button"))).toBe(true)
  const pinned = tabs()[0].closest("[data-slot=browser-tab]")!
  expect(pinned.getAttribute("data-pinned")).toBe("true")
  expect(pinned.querySelector("[data-slot=browser-tab-close]")).toBeNull()
  expect(host.querySelectorAll("[data-slot=browser-tab-close]")).toHaveLength(2)

  tabs()[1].click()
  expect(calls).toEqual([{ op: "select", tabID: "docs" }])
  expect(tabs().map((tab) => tab.getAttribute("aria-selected"))).toEqual(["false", "true", "false"])
  expect(tabs().map((tab) => tab.tabIndex)).toEqual([-1, 0, -1])
  expect(tabs()[1].closest("[data-slot=browser-tab]")?.getAttribute("data-active")).toBe("true")

  const menu = pinned.querySelector<HTMLButtonElement>('button[aria-label="Tab actions"]')!
  expect(menu).not.toBeNull()
  key(menu, "ArrowDown")
  await settled()
  const unpin = [...document.querySelectorAll<HTMLElement>('[role="menuitem"]')].find(
    (item) => item.textContent?.trim() === "Unpin tab",
  )
  expect(unpin).toBeDefined()
  key(unpin!, "Enter")
  await settled()
  expect(calls).toEqual([
    { op: "select", tabID: "docs" },
    { op: "tab-pin", tabID: "preview", pinned: false },
  ])
  expect(document.querySelector("[data-component=dropdown-menu-content]")).toBeNull()
})

test("tab snapshots update loading, error, title fallbacks and pin state in place", () => {
  const docs = tabs()[1]
  update({
    ...state,
    tabs: [state.tabs[0], { ...state.tabs[1], loading: true }, state.tabs[2]],
  })
  expect(tabs()[1]).toBe(docs)
  expect(docs.getAttribute("aria-busy")).toBe("true")
  expect(docs.querySelector("[data-slot=browser-tab-spinner]")).not.toBeNull()
  expect(docs.querySelector("[data-slot=browser-tab-initial]")).toBeNull()

  update({
    ...state,
    tabs: [state.tabs[0], { ...state.tabs[1], loading: false, loadFailed: true }, state.tabs[2]],
  })
  expect(docs.getAttribute("aria-busy")).toBe("false")
  expect(docs.querySelector("[data-slot=browser-tab-spinner]")).toBeNull()
  expect(docs.querySelector("[data-slot=browser-tab-icon] svg")).not.toBeNull()
  expect(docs.querySelector("[data-slot=browser-tab-initial]")).toBeNull()
  expect(docs.querySelector(".sr-only")?.textContent).toBe(
    "This page could not be loaded. Check the address and try again.",
  )

  update({
    ...state,
    tabs: [
      { ...state.tabs[0], pinned: false },
      { ...state.tabs[1], loadFailed: false, title: "", url: "https://example.test/updated" },
      state.tabs[2],
    ],
  })
  expect(docs.querySelector(".sr-only")).toBeNull()
  expect(docs.getAttribute("aria-label")).toBe("https://example.test/updated")
  expect(docs.querySelector("[data-slot=browser-tab-title]")?.textContent).toBe("https://example.test/updated")
  expect(docs.querySelector("[data-slot=browser-tab-title]")?.getAttribute("dir")).toBe("auto")
  expect(docs.title).toBe("https://example.test/updated\nhttps://example.test/updated")
  expect(tabs()[2].querySelector("[data-slot=browser-tab-title]")?.textContent).toBe("New tab")
  expect(tabs()[2].querySelector("[data-slot=browser-tab-initial]")).toBeNull()
  expect(tabs()[0].hasAttribute("aria-description")).toBe(false)
  expect(host.querySelectorAll("[data-slot=browser-tab-close]")).toHaveLength(3)
  expect(calls).toEqual([])
})

test("new tab and the all-tabs picker route commands and track the selected tab", async () => {
  button("New tab").click()
  expect(calls).toEqual([{ op: "new" }])
  // The fake command boundary publishes the snapshot; it does not reproduce tab creation logic.
  update({
    ...state,
    activeID: "created",
    tabs: [...state.tabs, { ...state.tabs[2], id: "created", title: "Created tab" }],
  })
  expect(tabs().map((tab) => tab.tabIndex)).toEqual([-1, -1, -1, 0])
  key(button("Browser tabs"), "ArrowDown")
  await settled()
  const items = [...document.querySelectorAll<HTMLElement>('[role="menuitemradio"]')]
  expect(items.map((item) => item.querySelector("[dir=auto]")?.textContent)).toEqual([
    "Preview",
    "Docs",
    "New tab",
    "Created tab",
  ])
  expect(items.map((item) => item.getAttribute("aria-checked"))).toEqual(["false", "false", "false", "true"])
  expect(items[1].querySelector("[dir=ltr]")?.textContent).toBe("https://example.test/docs")
  expect(host.contains(items[0])).toBe(false)
  items[1].focus()
  expect(document.activeElement).toBe(items[1])
  key(items[1], "Enter")
  await settled()
  expect(calls).toEqual([{ op: "new" }, { op: "select", tabID: "docs" }])
  expect(tabs().map((tab) => tab.getAttribute("aria-selected"))).toEqual(["false", "true", "false", "false"])
  expect(
    [...document.querySelectorAll('[role="menuitemradio"]')].map((item) => item.getAttribute("aria-checked")),
  ).toEqual(["false", "true", "false", "false"])
  key(document.querySelector<HTMLElement>('[role="menu"]')!, "Escape")
  await settled()
  expect(document.querySelector("[data-component=dropdown-menu-content]")).toBeNull()

  update({ sessionID: "task", tabs: [] })
  expect(tabs()).toHaveLength(0)
  expect(button("Browser tabs").disabled).toBe(true)
  expect(button("New tab").disabled).toBe(false)
})

test("unloading routes an inactive tab and shows its recoverable state without a loading spinner", async () => {
  const menu = tabs()[1]
    .closest("[data-slot=browser-tab]")!
    .querySelector<HTMLButtonElement>('button[aria-label="Tab actions"]')!
  key(menu, "ArrowDown")
  await settled()
  const unload = [...document.querySelectorAll<HTMLElement>('[role="menuitem"]')].find(
    (item) => item.textContent?.trim() === "Unload tab",
  )!
  expect(unload).toBeDefined()
  expect(unload.getAttribute("aria-disabled")).not.toBe("true")
  key(unload, "Enter")
  await settled()
  expect(calls).toEqual([{ op: "tab-unload", tabID: "docs" }])
  update({ ...state, tabs: [state.tabs[0], { ...state.tabs[1], id: "recovered", unloaded: true }, state.tabs[2]] })
  expect(tabs()[1].getAttribute("aria-label")).toBe("Docs (unloaded)")
  expect(tabs()[1].getAttribute("aria-busy")).toBe("false")
  expect(tabs()[1].querySelector("[data-slot=browser-tab-spinner]")).toBeNull()
  expect(tabs()[0].getAttribute("aria-selected")).toBe("true")
  tabs()[1].click()
  expect(calls.at(-1)).toEqual({ op: "select", tabID: "recovered" })
})

test.each(["active", "pinned", "loading", "agentAccess", "unloaded", "operation"] as const)(
  "Unload tab stays disabled for a %s target",
  async (protection) => {
    update({
      ...state,
      activeID: protection === "active" ? "docs" : state.activeID,
      tabs: [
        state.tabs[0],
        {
          ...state.tabs[1],
          pinned: protection === "pinned",
          loading: protection === "loading",
          agentAccess: protection === "agentAccess",
          unloaded: protection === "unloaded",
          operation: protection === "operation" ? { id: "busy", op: "navigate", status: "running" } : undefined,
        },
        state.tabs[2],
      ],
    })
    const menu = tabs()[1]
      .closest("[data-slot=browser-tab]")!
      .querySelector<HTMLButtonElement>('button[aria-label="Tab actions"]')!
    key(menu, "ArrowDown")
    await settled()
    const unload = [...document.querySelectorAll<HTMLElement>('[role="menuitem"]')].find(
      (item) => item.textContent?.trim() === "Unload tab",
    )!
    expect(unload).toBeDefined()
    expect(unload.getAttribute("aria-disabled")).toBe("true")
    key(unload, "Enter")
    await settled()
    expect(calls).toEqual([])
  },
)

test.each(["ltr", "rtl"] as const)("%s arrow, Home and End keys move selection and focus in DOM order", (direction) => {
  const list = host.querySelector<HTMLElement>('[role="tablist"]')!
  list.dir = direction
  list.style.direction = direction
  expect(getComputedStyle(list).direction).toBe(direction)
  tabs()[0].focus()
  const steps =
    direction === "ltr"
      ? ([
          ["ArrowLeft", 2],
          ["ArrowRight", 0],
          ["ArrowRight", 1],
          ["End", 2],
          ["Home", 0],
        ] as const)
      : ([
          ["ArrowRight", 2],
          ["ArrowLeft", 0],
          ["ArrowLeft", 1],
          ["End", 2],
          ["Home", 0],
        ] as const)
  for (const [press, index] of steps) {
    const focused = document.activeElement
    if (!(focused instanceof HTMLElement)) throw new Error("Expected a focused tab")
    const event = key(focused, press)
    expect(event.defaultPrevented).toBe(true)
    expect(document.activeElement).toBe(tabs()[index])
    expect(calls.at(-1)).toEqual({ op: "select", tabID: initial.tabs[index].id })
    expect(tabs().filter((tab) => tab.tabIndex === 0)).toEqual([tabs()[index]])
    expect(tabs()[index].getAttribute("aria-selected")).toBe("true")
  }
  expect(calls).toHaveLength(steps.length)
  calls.length = 0
  for (const options of [
    { altKey: true },
    { ctrlKey: true },
    { metaKey: true },
    { shiftKey: true },
    { isComposing: true },
  ]) {
    expect(key(tabs()[0], "ArrowRight", options).defaultPrevented).toBe(false)
    expect(key(tabs()[0], "Delete", options).defaultPrevented).toBe(false)
  }
  expect(key(tabs()[0], "ArrowDown").defaultPrevented).toBe(false)
  expect(calls).toEqual([])
  expect(document.activeElement).toBe(tabs()[0])
})

test("middle click closes a background tab without selecting it or moving focus", async () => {
  tabs()[0].focus()
  const docs = tabs()[1]
  const down = new MouseEvent("mousedown", { button: 1, bubbles: true, cancelable: true })
  docs.dispatchEvent(down)
  expect(down.defaultPrevented).toBe(true)
  const auxiliary = new MouseEvent("auxclick", { button: 1, bubbles: true, cancelable: true })
  docs.dispatchEvent(auxiliary)
  expect(auxiliary.defaultPrevented).toBe(true)
  expect(calls).toEqual([{ op: "close", tabID: "docs" }])
  update({ ...state, tabs: [state.tabs[0], state.tabs[2]] })
  await settled()
  expect(document.activeElement).toBe(tabs()[0])
  expect(tabs()[0].getAttribute("aria-selected")).toBe("true")
  const right = new MouseEvent("auxclick", { button: 2, bubbles: true, cancelable: true })
  tabs()[1].dispatchEvent(right)
  expect(right.defaultPrevented).toBe(false)
  expect(calls).toEqual([{ op: "close", tabID: "docs" }])
})

test("Delete restores focus after confirmed removal, and closing the final tab focuses New tab", async () => {
  const pending = Promise.withResolvers<void>()
  reply = () => pending.promise
  tabs()[1].focus()
  expect(key(tabs()[1], "Delete").defaultPrevented).toBe(true)
  expect(calls).toEqual([{ op: "close", tabID: "docs" }])
  const removed = tabs()[1]
  update({ ...state, activeID: "blank", tabs: [state.tabs[0], state.tabs[2]] })
  expect(removed.isConnected).toBe(false)
  pending.resolve()
  await settled()
  expect(document.activeElement).toBe(tabs()[1])
  expect(tabs()[1].getAttribute("aria-label")).toBe("New tab")

  update({ ...state, tabs: [state.tabs[1]] })
  const last = Promise.withResolvers<void>()
  reply = () => last.promise
  const close = host.querySelector<HTMLButtonElement>("[data-slot=browser-tab-close]")!
  close.focus()
  close.click()
  expect(calls.at(-1)).toEqual({ op: "close", tabID: "blank" })
  update({ sessionID: "task", tabs: [] })
  last.resolve()
  await settled()
  expect(document.activeElement).toBe(button("New tab"))
  expect(calls).toHaveLength(2)
})

test("cancelled and held closes preserve focus when a tab remains or the user moves elsewhere", async () => {
  const cancelled = Promise.withResolvers<void>()
  reply = () => cancelled.promise
  const docs = tabs()[1]
  docs.focus()
  key(docs, "Delete")
  await settled()
  expect(document.activeElement).toBe(docs)
  update(structuredClone(state))
  cancelled.resolve()
  await settled()
  expect(tabs()[1]).toBe(docs)
  expect(document.activeElement).toBe(docs)
  expect(calls).toEqual([{ op: "close", tabID: "docs" }])

  const held = Promise.withResolvers<void>()
  reply = () => held.promise
  key(docs, "Delete")
  const elsewhere = document.createElement("input")
  host.append(elsewhere)
  elsewhere.focus()
  update({ ...state, tabs: [state.tabs[0], state.tabs[2]] })
  held.resolve()
  await settled()
  expect(docs.isConnected).toBe(false)
  expect(document.activeElement).toBe(elsewhere)
  expect(calls).toEqual([
    { op: "close", tabID: "docs" },
    { op: "close", tabID: "docs" },
  ])
})

test("selection and pin updates reveal the whole tab including its actions", async () => {
  await settled()
  const docs = tabs()[1]
  const row = docs.closest<HTMLElement>("[data-slot=browser-tab]")!
  const revealed: (boolean | ScrollIntoViewOptions | undefined)[] = []
  // Happy DOM does not lay out or scroll; observe only this tab's browser API boundary.
  row.scrollIntoView = (options) => revealed.push(options)
  docs.click()
  await settled()
  expect(revealed).toEqual([{ block: "nearest", inline: "nearest" }])
  expect(row.contains(docs)).toBe(true)
  expect(row.querySelector("[data-slot=browser-tab-close]")).not.toBeNull()
  expect(row.querySelector("[data-slot=browser-tab-actions]")).not.toBeNull()
  revealed.length = 0
  update({ ...state, tabs: [state.tabs[0], { ...state.tabs[1], pinned: true }, state.tabs[2]] })
  await settled()
  expect(revealed).toEqual([{ block: "nearest", inline: "nearest" }])
})

test("reordered snapshots retain tab identity and navigation uses the updated order", () => {
  const preview = tabs()[0]
  const docs = tabs()[1]
  docs.focus()
  update({
    ...state,
    activeID: "docs",
    tabs: [
      { ...state.tabs[1], pinned: true, title: "Updated docs" },
      state.tabs[0],
      { ...state.tabs[2], title: "Third tab" },
    ],
  })
  expect(tabs()[0]).toBe(docs)
  expect(tabs()[1]).toBe(preview)
  expect(document.activeElement).toBe(docs)
  expect(tabs().map((tab) => tab.getAttribute("aria-label"))).toEqual(["Updated docs", "Preview", "Third tab"])
  expect(tabs().map((tab) => tab.tabIndex)).toEqual([0, -1, -1])
  expect(docs.querySelector("[data-slot=browser-tab-initial]")?.textContent).toBe("U")
  expect(docs.closest("[data-slot=browser-tab]")?.querySelector("[data-slot=browser-tab-close]")).toBeNull()
  key(docs, "ArrowRight")
  expect(calls).toEqual([{ op: "select", tabID: "preview" }])
  expect(document.activeElement).toBe(preview)
  key(preview, "End")
  expect(calls.at(-1)).toEqual({ op: "select", tabID: "blank" })
  expect(document.activeElement).toBe(tabs()[2])
})
