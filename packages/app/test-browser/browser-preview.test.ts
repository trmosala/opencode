import { expect, test } from "bun:test"
import { mkdtemp, rm } from "node:fs/promises"
import { join, resolve } from "node:path"
import { pathToFileURL } from "node:url"
import { build } from "vite"
import solid from "vite-plugin-solid"
import type { BrowserCommand, BrowserPanelPlatform, BrowserTabs } from "../src/browser-panel"

test("mounted address navigation supersedes by tab while other tabs and stop stay responsive", async () => {
  const directory = await mkdtemp(resolve("test-browser/.navigation-"))
  const host = document.createElement("div")
  document.body.append(host)
  let dispose: (() => void) | undefined
  try {
    await build({
      configFile: false,
      root: resolve("."),
      logLevel: "warn",
      plugins: [
        {
          name: "navigation-fixture",
          enforce: "pre",
          resolveId(id) {
            const normalized = id.replaceAll("\\", "/")
            for (const name of [
              "navigation-fixture",
              "@/context/language",
              "@/context/platform",
              "@/context/prompt",
              "@/context/settings",
              "@/utils/toast",
            ]) {
              if (id === name || normalized === resolve(name.replace("@/", "src/")).replaceAll("\\", "/"))
                return "\0" + name
            }
            return undefined
          },
          load(id) {
            if (id === "\0@/context/language")
              return `export const useLanguage = () => ({ direction: () => document.documentElement.dir === "rtl" ? "rtl" : "ltr", t: key => key });`
            if (id === "\0@/context/platform")
              return `export let platform; export const usePlatform = () => platform; export const setup = value => platform = value;`
            if (id === "\0@/context/settings")
              return `export const useSettings = () => ({ general: { newLayoutDesigns: () => false } });`
            if (id === "\0@/context/prompt")
              return `export const parts = []; export const usePrompt = () => ({ capture: () => ({ current: () => parts, cursor: () => 0, set: next => parts.splice(0, parts.length, ...next) }) });`
            if (id === "\0@/utils/toast")
              return `export const errors = []; export const showToast = value => errors.push(value);`
            if (id === "\0navigation-fixture")
              return `import { createComponent, createSignal } from "solid-js";
            import { render } from "solid-js/web";
            import { setup } from "@/context/platform";
            import { BrowserPanel } from ${JSON.stringify(resolve("src/components/browser-panel/browser-panel.tsx"))};
            export { errors } from "@/utils/toast";
            export let selectSession;
            export function mount(host, browser) {
              setup({ browserPanel: browser });
              const [session, select] = createSignal("task"); selectSession = select;
              return render(() => createComponent(BrowserPanel, {get sessionKey() { return session() }, get sessionID() { return session() }}), host);
              }`
            return undefined
          },
        },
        solid(),
      ],
      resolve: { alias: { "@": resolve("src") } },
      build: {
        outDir: directory,
        emptyOutDir: false,
        minify: false,
        lib: { entry: "navigation-fixture", formats: ["es"], fileName: () => "navigation.mjs" },
      },
    })
    const fixture = await import(pathToFileURL(join(directory, "navigation.mjs")).href)
    const tab = (id: string, url: string) => ({
      id,
      revision: 1,
      url,
      title: id,
      loading: false,
      canGoBack: false,
      canGoForward: false,
      agentAccess: false,
      device: false,
      pinned: false,
      loadFailed: false,
    })
    let tabs: BrowserTabs = {
      sessionID: "task",
      activeID: "first",
      profile: { history: [], credentials: [], rememberHistory: true, vaultAvailable: false },
      tabs: [tab("first", "https://first.test/"), tab("second", "https://second.test/")],
    }
    let publish: (value: BrowserTabs) => void = () => {}
    const navigations: {
      tabID: string
      url: string
      result: BrowserTabs
      resolve(value: BrowserTabs): void
      reject(error: Error): void
    }[] = []
    const calls: BrowserCommand[] = []
    const created = Promise.withResolvers<BrowserTabs>()
    const browser: BrowserPanelPlatform = {
      command: async (sessionID, command) => {
        calls.push(command)
        if (command.op === "new") return created.promise
        if (command.op === "state")
          return {
            ...tabs,
            sessionID,
            tabs:
              sessionID === "other-task"
                ? tabs.tabs.map((row) => ({ ...row, url: "https://other-task.test/", loading: false }))
                : tabs.tabs,
          }
        if (command.op === "select") {
          tabs = { ...tabs, activeID: command.tabID }
          publish(tabs)
          return tabs
        }
        if (command.op === "navigate") {
          let resolve!: (value: BrowserTabs) => void
          let reject!: (error: Error) => void
          const result = new Promise<BrowserTabs>((yes, no) => {
            resolve = yes
            reject = no
          })
          const snapshot = {
            ...tabs,
            tabs: tabs.tabs.map((row) =>
              row.id === command.tabID ? { ...row, url: command.url, revision: row.revision! + 1, loading: true } : row,
            ),
          }
          tabs = snapshot
          publish(tabs)
          navigations.push({ tabID: command.tabID, url: command.url, result: snapshot, resolve, reject })
          return result
        }
        if (command.op === "stop") {
          tabs = {
            ...tabs,
            tabs: tabs.tabs.map((row) => (row.id === command.tabID ? { ...row, loading: false } : row)),
          }
          publish(tabs)
        }
        return tabs
      },
      subscribe: (callback) => {
        publish = callback
        return () => {}
      },
      viewport: async () => {},
      selection: async () => "",
      pick: async () => undefined,
      screenshot: async () => "",
    }
    dispose = fixture.mount(host, browser)
    await new Promise<void>((resolve) => setImmediate(resolve))
    const address = host.querySelector<HTMLInputElement>('input[role="combobox"]')!
    const submit = async (url: string) => {
      address.value = url
      address.dispatchEvent(new Event("input", { bubbles: true }))
      address.closest("form")!.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }))
      await new Promise<void>((resolve) => setImmediate(resolve))
    }
    const finish = (index: number, url = navigations[index].url) => {
      const navigation = navigations[index]
      navigation.resolve({
        ...navigation.result,
        tabs: navigation.result.tabs.map((row) =>
          row.id === navigation.tabID ? { ...row, url, loading: false } : row,
        ),
      })
    }

    await submit("https://first-new.test/")
    await submit("https://first-newer.test/")
    await submit("https://first-newest.test/")
    expect(navigations.map((item) => [item.tabID, item.url])).toEqual([
      ["first", "https://first-new.test/"],
      ["first", "https://first-newer.test/"],
      ["first", "https://first-newest.test/"],
    ])
    navigations[0].reject(new Error("ERR_ABORTED"))
    finish(1, "https://stale-first.test/")
    await new Promise<void>((resolve) => setImmediate(resolve))
    expect(fixture.errors).toEqual([])
    expect(address.value).toBe("https://first-newest.test/")

    host.querySelectorAll<HTMLButtonElement>('[role="tab"]')[1].click()
    await submit("https://second-new.test/")
    expect(navigations.map((item) => item.tabID)).toEqual(["first", "first", "first", "second"])
    finish(2, "https://first-newest.test/")
    await new Promise<void>((resolve) => setImmediate(resolve))
    expect(address.value).toBe("https://second-new.test/")

    host.querySelector<HTMLButtonElement>('button[aria-label="browser.action.stop"]')?.click()
    const stop = calls.findLast((call) => call.op === "stop")
    expect(stop).toEqual({ op: "stop", tabID: "second" })
    finish(3, "https://stale-second.test/")
    await new Promise<void>((resolve) => setImmediate(resolve))
    expect(address.value).toBe("https://second-new.test/")

    await submit("https://task-switch-stale.test/")
    fixture.selectSession("other-task")
    await new Promise<void>((resolve) => setImmediate(resolve))
    finish(4, "https://task-switch-stale.test/")
    await new Promise<void>((resolve) => setImmediate(resolve))
    expect(address.value).toBe("https://other-task.test/")
    expect(fixture.errors).toEqual([])

    fixture.selectSession("task")
    await new Promise<void>((resolve) => setImmediate(resolve))
    tabs = {
      ...tabs,
      revision: 20,
      tabs: tabs.tabs.map((row) =>
        row.id === tabs.activeID
          ? { ...row, agentAccess: true, operation: { id: "operation", op: "press_key", status: "running" as const } }
          : row,
      ),
    }
    publish(tabs)
    expect(host.querySelector("[data-browser-operation]")?.getAttribute("role")).toBe("status")
    expect(host.querySelector("[data-browser-operation]")?.textContent).toContain("browser.operation.running")
    publish({ ...tabs, revision: 19, tabs: tabs.tabs.map((row) => ({ ...row, operation: undefined })) })
    expect(host.querySelector("[data-browser-operation]")?.textContent).toContain("browser.operation.running")
    const takeover = [...host.querySelectorAll<HTMLButtonElement>("[data-browser-operation] button")].find((button) =>
      button.textContent?.includes("browser.operation.takeover"),
    )!
    expect(takeover.type).toBe("button")
    takeover.click()
    await new Promise<void>((resolve) => setImmediate(resolve))
    expect(calls.at(-1)).toEqual({ op: "access", tabID: tabs.activeID, enabled: false })
    tabs = {
      ...tabs,
      revision: 21,
      tabs: tabs.tabs.map((row) =>
        row.id === tabs.activeID
          ? {
              ...row,
              agentAccess: false,
              operation: {
                id: "operation",
                op: "press_key",
                status: "quarantined" as const,
                actionStatus: "dispatched_uncertain" as const,
                code: "input_held",
              },
            }
          : row,
      ),
    }
    publish(tabs)
    expect(host.querySelector("[data-browser-operation]")?.getAttribute("role")).toBe("alert")
    expect(host.querySelector("[data-browser-operation]")?.textContent).toContain("browser.operation.uncertain")
    expect(host.querySelector("[data-browser-operation]")?.textContent).toContain("browser.operation.recovery")
    const close = host.querySelector<HTMLButtonElement>("[data-browser-operation] button")!
    close.click()
    await new Promise<void>((resolve) => setImmediate(resolve))
    expect(calls.at(-1)).toEqual({ op: "close", tabID: tabs.activeID })

    publish({
      ...tabs,
      revision: 22,
      tabs: tabs.tabs.map((row) => ({
        ...row,
        operation: undefined,
        notice: { code: "untracked_leave", message: "Use the browser controls to confirm this destination." },
      })),
    })
    expect(host.querySelector("[data-browser-operation]")?.getAttribute("role")).toBe("alert")
    expect(host.querySelector("[data-browser-operation]")?.textContent).toContain("Use the browser controls")

    tabs = { ...tabs, sessionID: "empty-task", activeID: undefined, tabs: [] }
    fixture.selectSession("empty-task")
    await new Promise<void>((resolve) => setImmediate(resolve))
    await submit("https://older-before-creation.test/")
    await submit("https://newer-before-creation.test/")
    expect(calls.filter((call) => call.op === "new")).toHaveLength(1)
    tabs = { ...tabs, activeID: "created", tabs: [tab("created", "about:blank")] }
    created.resolve(tabs)
    await new Promise<void>((resolve) => setImmediate(resolve))
    expect(navigations.slice(5).map((item) => item.url)).toEqual(["https://newer-before-creation.test/"])
    finish(5)
    await new Promise<void>((resolve) => setImmediate(resolve))
    expect(address.value).toBe("https://newer-before-creation.test/")
  } finally {
    dispose?.()
    host.remove()
    await rm(directory, { recursive: true, force: true })
  }
}, 30_000)

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
    return (
      this.isConnected && this.getAttribute("data-expanded") !== "false" && this.getAttribute("aria-hidden") !== "true"
    )
  }
  HTMLElement.prototype.getBoundingClientRect = function () {
    if (this.matches('[role="tooltip"], [role="menu"], [role="dialog"]') && this.style.width && this.style.height) {
      const left = Number.parseFloat(this.style.left || "0")
      const top = Number.parseFloat(this.style.top || "0")
      const width = Number.parseFloat(this.style.width || "0")
      const height = Number.parseFloat(this.style.height || "0")
      return new DOMRect(left, top, width, height)
    }
    return new DOMRect(0, 0, 600, 400)
  }
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
              "@/context/settings",
              "@/utils/toast",
            ]) {
              if (id === name || normalized === resolve(name.replace("@/", "src/")).replaceAll("\\", "/"))
                return "\0" + name
            }
          },
          load(id) {
            if (id === "\0@/context/language")
              return `import { browser } from ${JSON.stringify(resolve("src/i18n/en.ts"))};
            export const useLanguage = () => ({ direction: () => document.documentElement.dir === "rtl" ? "rtl" : "ltr", t: (key, params = {}) => Object.entries(params).reduce((text, [key, value]) => text.replaceAll("{{" + key + "}}", String(value)), browser[key] ?? key) });`
            if (id === "\0@/context/platform")
              return `export let platform; export const usePlatform = () => platform; export const setup = value => platform = value;`
            if (id === "\0@/context/settings")
              return `export const useSettings = () => ({ general: { newLayoutDesigns: () => false } });`
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
      profile: {
        history: [],
        credentials: [],
        rememberHistory: true,
        vaultAvailable: false,
        devicePresets: [
          {
            id: "00000000-0000-4000-8000-000000000001",
            name: "Saved phone",
            size: { width: 412, height: 915 },
          },
        ],
      },
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
        (value) => value.textContent?.trim() === text || value.getAttribute("aria-label") === text,
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

    const menu = host.querySelector<HTMLButtonElement>('button[aria-label="Browser menu"]')!
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
          expect(
            host.querySelector('[role="tab"][aria-selected="true"] [data-slot=browser-tab-title]')?.textContent,
          ).toBe("Preview")
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
    const viewports: Parameters<BrowserPanelPlatform["viewport"]>[0][] = []
    browser.viewport = async (input) => {
      viewports.push(input)
    }
    window.dispatchEvent(new Event("resize"))
    await new Promise((resolve) => setTimeout(resolve, 100))
    expect(viewports.at(-1)?.bounds).not.toBeNull()
    const before = viewports.length
    // Main can discard an acknowledged viewport after the renderer's resize notification.
    // With unchanged geometry, the renderer must renew it without another UI action.
    await new Promise((resolve) => setTimeout(resolve, 1200))
    expect(viewports.length).toBeGreaterThan(before)
    expect(viewports.at(-1)?.bounds).toEqual(viewports[0].bounds)
    const overlay = document.createElement("div")
    overlay.setAttribute("role", "tooltip")
    overlay.style.cssText = "position:fixed;left:700px;top:500px;width:100px;height:40px"
    host.append(overlay)
    await new Promise((resolve) => setTimeout(resolve, 100))
    expect(viewports.at(-1)?.bounds).toEqual(viewports[0].bounds)
    overlay.style.left = "100px"
    overlay.style.top = "100px"
    await new Promise((resolve) => setTimeout(resolve, 100))
    expect(viewports.at(-1)?.bounds).toBeNull()
    const hidden = viewports.length
    await new Promise((resolve) => setTimeout(resolve, 1200))
    expect(viewports.length).toBe(hidden)
    overlay.remove()
    await new Promise((resolve) => setTimeout(resolve, 100))
    expect(viewports.at(-1)?.bounds).not.toBeNull()
    const appMenu = document.createElement("div")
    appMenu.setAttribute("role", "menu")
    appMenu.style.cssText = "position:fixed;left:700px;top:500px;width:100px;height:40px"
    host.append(appMenu)
    await new Promise((resolve) => setTimeout(resolve, 100))
    expect(viewports.at(-1)?.bounds).not.toBeNull()
    appMenu.style.left = "100px"
    appMenu.style.top = "100px"
    await new Promise((resolve) => setTimeout(resolve, 100))
    expect(viewports.at(-1)?.bounds).toBeNull()
    appMenu.remove()
    await new Promise((resolve) => setTimeout(resolve, 100))
    expect(viewports.at(-1)?.bounds).not.toBeNull()
    const modal = document.createElement("div")
    modal.setAttribute("role", "dialog")
    modal.setAttribute("aria-modal", "true")
    modal.style.cssText = "position:fixed;left:100px;top:100px;width:100px;height:100px"
    host.append(modal)
    await new Promise((resolve) => setTimeout(resolve, 100))
    expect(viewports.at(-1)?.bounds).toBeNull()
    modal.style.left = "700px"
    modal.style.top = "500px"
    await new Promise((resolve) => setTimeout(resolve, 100))
    expect(viewports.at(-1)?.bounds).toBeNull()
    modal.remove()
    await new Promise((resolve) => setTimeout(resolve, 100))
    expect(viewports.at(-1)?.bounds).not.toBeNull()
    const held = Promise.withResolvers<void>()
    browser.viewport = async (input) => {
      viewports.push(input)
      if (input.bounds) await held.promise
    }
    window.dispatchEvent(new Event("resize"))
    await new Promise((resolve) => setTimeout(resolve, 100))
    const waiting = viewports.length
    await new Promise((resolve) => setTimeout(resolve, 1200))
    expect(viewports.length).toBe(waiting)
    host.append(overlay)
    await new Promise((resolve) => setTimeout(resolve, 100))
    expect(viewports.at(-1)?.bounds).toBeNull()
    held.resolve()
    overlay.remove()

    const presets = host.querySelector<HTMLElement>('[data-slot="browser-device-toolbar"] [data-component="select"]')!
    const trigger = presets.querySelector<HTMLButtonElement>("button")!
    trigger.focus()
    trigger.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowDown", bubbles: true }))
    await Promise.resolve()
    expect(trigger.getAttribute("aria-expanded")).toBe("true")
    expect(
      [...document.querySelectorAll<HTMLElement>('[role="option"]')].map((option) => option.textContent?.trim()),
    ).toEqual(["Custom size", "Saved phone"])
    document.activeElement!.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowDown", bubbles: true }))
    document.activeElement!.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }))
    await Promise.resolve()
    expect(calls.at(-1)).toMatchObject({ op: "device", size: { width: 412, height: 915 } })

    const browserMenu = host.querySelector<HTMLButtonElement>('button[aria-label="Browser menu"]')!
    browserMenu.focus()
    browserMenu.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowDown", bubbles: true }))
    await Promise.resolve()
    const clear = [...document.querySelectorAll<HTMLElement>('[role="menuitem"]')].find(
      (value) => value.textContent?.trim() === "Clear browsing data",
    )!
    clear.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }))
    await Promise.resolve()
    const range = host.querySelector<HTMLElement>('[data-slot="browser-tools"] [data-component="select"]')!
    const rangeTrigger = range.querySelector<HTMLButtonElement>("button")!
    rangeTrigger.focus()
    rangeTrigger.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowDown", bubbles: true }))
    await Promise.resolve()
    expect(rangeTrigger.getAttribute("aria-expanded")).toBe("true")
    const day = [...document.querySelectorAll<HTMLElement>('[role="option"]')].find(
      (value) => value.textContent?.trim() === "Last 24 hours",
    )!
    day.click()
    await Promise.resolve()
    const cache = [...host.querySelectorAll("label")]
      .find((label) => label.textContent?.trim() === "Cached files")
      ?.querySelector<HTMLInputElement>('input[type="checkbox"]')
    expect(cache?.disabled).toBe(true)

    browserMenu.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowDown", bubbles: true }))
    await Promise.resolve()
    const find = [...document.querySelectorAll<HTMLElement>('[role="menuitem"]')].find(
      (value) => value.querySelector('[data-slot="dropdown-menu-item-label"]')?.textContent?.trim() === "Find in page",
    )!
    find.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }))
    await Promise.resolve()
    expect(host.querySelector('[data-slot="browser-tools"] input[aria-label="Find in page"]')).not.toBeNull()
    expect(host.querySelector('[data-slot="browser-tools"] [data-component="select"]')).toBeNull()

    dispose?.()
    dispose = undefined
    const closed = viewports.length
    await new Promise((resolve) => setTimeout(resolve, 1200))
    expect(viewports.length).toBe(closed)
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
