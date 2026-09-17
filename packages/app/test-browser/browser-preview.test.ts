import { expect, test } from "bun:test"
import { mkdtemp, rm } from "node:fs/promises"
import { join, resolve } from "node:path"
import { pathToFileURL } from "node:url"
import { build } from "vite"
import solid from "vite-plugin-solid"
import type { BrowserCommand, BrowserPanelPlatform, BrowserTabs } from "../src/browser-panel"

test("mounted preview validates sizes and waits for menu disposal and viewport acknowledgement before capture", async () => {
  const directory = await mkdtemp(resolve("test-browser/.preview-"))
  const host = document.createElement("div")
  document.body.append(host)
  // Happy DOM has no stylesheet defaults or animation completion events.
  const style = document.createElement("style")
  style.textContent = "[data-component=dropdown-menu-content]{animation-name:none;transition-property:none}"
  document.head.append(style)
  const visibility = HTMLElement.prototype.checkVisibility
  const rect = HTMLElement.prototype.getBoundingClientRect
  const point = document.elementFromPoint
  HTMLElement.prototype.checkVisibility = function () {
    return this.isConnected
  }
  HTMLElement.prototype.getBoundingClientRect = () => new DOMRect(0, 0, 600, 400)
  document.elementFromPoint = () => host.querySelector(".min-h-0.flex-1")!
  let dispose: (() => void) | undefined
  try {
    await build({
      configFile: false,
      root: resolve("."),
      logLevel: "warn",
      plugins: [
        {
          name: "preview-fixture",
          enforce: "pre",
          resolveId(id) {
            const normalized = id.replaceAll("\\", "/")
            for (const name of [
              "preview-fixture",
              "@/context/language",
              "@/context/platform",
              "@/context/prompt",
              "@/utils/toast",
            ]) {
              if (id === name || normalized === resolve(name.replace("@/", "src/")).replaceAll("\\", "/"))
                return "\0" + name
            }
          },
          load(id) {
            if (id === "\0@/context/language")
              return `import { browser } from ${JSON.stringify(resolve("src/i18n/en.ts"))};
            export const useLanguage = () => ({ t: (key, params = {}) => Object.entries(params).reduce((text, [key, value]) => text.replaceAll("{{" + key + "}}", String(value)), browser[key] ?? key) });`
            if (id === "\0@/context/platform")
              return `export let platform; export const usePlatform = () => platform; export const setup = value => platform = value;`
            if (id === "\0@/context/prompt")
              return `export const parts = []; export const delivered = Promise.withResolvers(); export const usePrompt = () => ({ capture: () => ({ current: () => parts, cursor: () => 0, set: next => { parts.splice(0, parts.length, ...next); delivered.resolve(); } }) });`
            if (id === "\0@/utils/toast")
              return `export const errors = []; export const showToast = value => errors.push(value);`
            if (id === "\0preview-fixture")
              return `import { createComponent, createSignal } from "solid-js";
            import { render } from "solid-js/web";
            import { setup } from "@/context/platform";
            import { BrowserPanel } from ${JSON.stringify(resolve("src/components/browser-panel/browser-panel.tsx"))};
            export { parts, delivered } from "@/context/prompt";
            export { errors } from "@/utils/toast";
            export let selectSession;
            export function mount(host, browser) {
              setup({ browserPanel: browser });
              const [session, select] = createSignal("task"); selectSession = select;
              return render(() => createComponent(BrowserPanel, {get sessionKey() { return session() }, get sessionID() { return session() }}), host);
            }`
          },
        },
        solid(),
      ],
      resolve: { alias: { "@": resolve("src") } },
      build: {
        outDir: directory,
        emptyOutDir: false,
        minify: false,
        lib: { entry: "preview-fixture", formats: ["es"], fileName: () => "preview.mjs" },
      },
    })
    const fixture = await import(pathToFileURL(join(directory, "preview.mjs")).href)
    let tabs: BrowserTabs = {
      sessionID: "task",
      activeID: "tab",
      tabs: [
        {
          id: "tab",
          revision: 1,
          url: "https://example.test/",
          title: "Preview",
          loading: false,
          canGoBack: false,
          canGoForward: false,
          agentAccess: false,
          device: true,
          deviceSize: { width: 390, height: 844 },
        },
      ],
    }
    let accept: (value: BrowserTabs) => void = () => {}
    let viewport = Promise.withResolvers<void>()
    let requested = Promise.withResolvers<void>()
    let captured = Promise.withResolvers<void>()
    let image = Promise.withResolvers<string>()
    let captures = 0
    const calls: BrowserCommand[] = []
    const browser: BrowserPanelPlatform = {
      command: async (sessionID, command) => {
        if (command.op === "state") return { ...tabs, sessionID }
        if (command.op === "select") {
          tabs = { ...tabs, activeID: command.tabID }
          accept(tabs)
        }
        if (command.op === "device") {
          calls.push(command)
          tabs = {
            ...tabs,
            tabs: [
              {
                ...tabs.tabs[0],
                revision: (tabs.tabs[0].revision ?? 0) + 1,
                deviceSize: command.size,
                device: command.enabled,
              },
            ],
          }
          accept(tabs)
        }
        return tabs
      },
      subscribe: (callback) => {
        accept = callback
        return () => {}
      },
      viewport: async (input) => {
        if (!input.bounds) return
        expect(document.querySelector("[data-component=dropdown-menu-content]")).toBeNull()
        requested.resolve()
        await viewport.promise
      },
      screenshot: async () => {
        captures++
        captured.resolve()
        return image.promise
      },
      selection: async () => "",
      pick: async () => undefined,
    }
    dispose = fixture.mount(host, browser)
    await Promise.resolve()
    const button = (text: string) => {
      const value = [...document.querySelectorAll<HTMLButtonElement>("button")].find(
        (value) => value.textContent?.trim() === text,
      )
      expect(value).toBeDefined()
      return value!
    }
    const inputs = [...host.querySelectorAll<HTMLInputElement>('input[type="number"]')]
    expect(inputs.map((input) => input.value)).toEqual(["390", "844"])
    inputs[0].value = "159"
    inputs[0].dispatchEvent(new Event("input", { bubbles: true }))
    host.querySelector("form[aria-label]")!.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }))
    expect(calls).toEqual([])
    inputs[0].value = "360"
    inputs[0].dispatchEvent(new Event("input", { bubbles: true }))
    host.querySelector("form[aria-label]")!.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }))
    await Promise.resolve()
    expect(calls[0]).toMatchObject({ op: "device", size: { width: 360, height: 844 } })

    const menu = host.querySelector<HTMLButtonElement>('[data-slot="dropdown-menu-trigger"]')!
    menu.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowDown", bubbles: true }))
    await Promise.resolve()
    const item = [...document.querySelectorAll<HTMLElement>('[role="menuitem"]')].find(
      (value) => value.textContent?.trim() === "Take a screenshot and add to chat",
    )!
    expect(item).toBeDefined()
    item.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }))
    expect(captures).toBe(0)
    await requested.promise
    expect(document.querySelector("[data-component=dropdown-menu-content]")).toBeNull()
    expect(captures).toBe(0)
    viewport.resolve()
    await captured.promise
    image.resolve("data:image/png;base64,AAAA")
    await fixture.delivered.promise
    expect(fixture.parts.filter((part: { type: string }) => part.type === "image")).toHaveLength(1)
    expect(fixture.errors).toEqual([])

    for (const action of ["Apply size", "Swap width and height"]) {
      viewport = Promise.withResolvers<void>()
      requested = Promise.withResolvers<void>()
      captured = Promise.withResolvers<void>()
      image = Promise.withResolvers<string>()
      button("Add Screenshot").click()
      await requested.promise
      viewport.resolve()
      await captured.promise
      if (action === "Apply size")
        host.querySelector("form[aria-label]")!.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }))
      else button(action).click()
      image.resolve("data:image/png;base64,AAAA")
      // Drain promise continuations before asserting that no late image was delivered.
      await new Promise<void>((resolve) => setImmediate(resolve))
      expect(fixture.parts.filter((part: { type: string }) => part.type === "image")).toHaveLength(1)
    }
    expect(calls.at(-1)).toMatchObject({ size: { width: 844, height: 360 } })
    tabs = { ...tabs, tabs: [...tabs.tabs, { ...tabs.tabs[0], id: "other", title: "Other" }] }
    accept(tabs)
    viewport.resolve()
    const roundTrips: { operation: string; change: string; timing: string; delivered: number; errors: number }[] = []
    for (const operation of ["screenshot", "selection", "pick"] as const) {
      for (const change of ["tab", "session"]) {
        for (const timing of ["held", "post-native"]) {
          const started = Promise.withResolvers<void>()
          const pending = Promise.withResolvers<unknown>()
          browser.selection = async () => ""
          // This promise is the preload result, with no extra async wrapper before the panel continuation.
          browser[operation] = (() => {
            started.resolve()
            return pending.promise
          }) as (typeof browser)[typeof operation]
          fixture.errors.length = 0
          const parts = fixture.parts.length
          button(operation === "screenshot" ? "Add Screenshot" : "Add Selection").click()
          await started.promise
          const value =
            operation === "screenshot"
              ? "data:image/png;base64,AAAA"
              : operation === "selection"
                ? "selected text"
                : { tag: "button", text: "Pick", role: "", label: "", id: "", className: "" }
          if (timing === "post-native") pending.resolve(value)
          if (change === "tab") {
            host.querySelector<HTMLButtonElement>('[role="tab"]:not([aria-selected="true"])')!.click()
            host.querySelector<HTMLButtonElement>('[role="tab"]:not([aria-selected="true"])')!.click()
          } else {
            fixture.selectSession("other-task")
            fixture.selectSession("task")
            accept(tabs)
          }
          expect(host.querySelector('[role="tab"][aria-selected="true"]')?.textContent).toBe("Preview")
          if (timing === "held") pending.resolve(value)
          await new Promise<void>((resolve) => setImmediate(resolve))
          roundTrips.push({
            operation,
            change,
            timing,
            delivered: fixture.parts.length - parts,
            errors: fixture.errors.filter((value: { variant?: string }) => value.variant === "error").length,
          })
        }
      }
    }
    expect(roundTrips).toEqual(roundTrips.map((row) => ({ ...row, delivered: 0, errors: 0 })))
    for (const operation of ["selection", "pick", "screenshot"] as const) {
      for (const stale of [true, false]) {
        const started = Promise.withResolvers<void>()
        const pending = Promise.withResolvers<never>()
        browser.selection = async () => ""
        browser[operation] = async () => {
          started.resolve()
          return pending.promise
        }
        fixture.errors.length = 0
        const parts = fixture.parts.length
        button(operation === "screenshot" ? "Add Screenshot" : "Add Selection").click()
        await started.promise
        if (stale) {
          tabs = { ...tabs, tabs: [{ ...tabs.tabs[0], revision: (tabs.tabs[0].revision ?? 0) + 1 }] }
          accept(tabs)
        }
        pending.reject(new Error("Browser tab not visible"))
        await new Promise<void>((resolve) => setImmediate(resolve))
        expect(fixture.parts).toHaveLength(parts)
        expect(fixture.errors.filter((value: { variant?: string }) => value.variant === "error")).toHaveLength(
          stale ? 0 : 1,
        )
      }
    }
  } finally {
    dispose?.()
    host.remove()
    style.remove()
    HTMLElement.prototype.checkVisibility = visibility
    HTMLElement.prototype.getBoundingClientRect = rect
    document.elementFromPoint = point
    await rm(directory, { recursive: true, force: true })
  }
}, 30_000)
