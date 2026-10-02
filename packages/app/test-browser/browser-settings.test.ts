import { expect, test } from "bun:test"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import { pathToFileURL } from "node:url"
import { build } from "vite"
import solid from "vite-plugin-solid"
import type { BrowserCommand, BrowserTabs } from "../src/browser-panel"

test("mounted settings show eligibility, allow revocation during consent and route download recovery", async () => {
  const directory = await mkdtemp(join(tmpdir(), "cm-settings-test-"))
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
          name: "settings-fixture",
          enforce: "pre",
          resolveId(id) {
            if (
              id === "settings-fixture" ||
              id.replaceAll("\\", "/") === resolve("settings-fixture").replaceAll("\\", "/")
            )
              return "\0settings-fixture"
            if (
              id === "@/context/language" ||
              id.replaceAll("\\", "/") === resolve("src/context/language").replaceAll("\\", "/")
            )
              return "\0settings-language"
            if (
              id === "@/context/settings" ||
              id.replaceAll("\\", "/") === resolve("src/context/settings").replaceAll("\\", "/")
            )
              return "\0settings-preferences"
          },
          load(id) {
            if (id === "\0settings-language")
              return `import { browser } from ${JSON.stringify(resolve("src/i18n/en.ts"))};
                export const useLanguage = () => ({ direction: () => document.documentElement.dir === "rtl" ? "rtl" : "ltr", t: (key, params = {}) => Object.entries(params).reduce((text, [key, value]) => text.replaceAll("{{" + key + "}}", String(value)), browser[key] ?? key) })`
            if (id === "\0settings-preferences")
              return `import { createSignal } from "solid-js";
                const [newLayout, setNewLayout] = createSignal(false);
                export const useSettings = () => ({ general: { newLayoutDesigns: newLayout } });
                export const setLayoutDesigns = setNewLayout;`
            if (id === "\0settings-fixture")
              return `import { createComponent } from "solid-js";
                import { render } from "solid-js/web";
                import { createStore } from "solid-js/store";
                import { setLayoutDesigns } from "@/context/settings";
                import { BrowserTools } from ${JSON.stringify(resolve("src/components/browser-panel/browser-tools.tsx"))};
                export function mount(host, tabs, command) {
                  const [state, setState] = createStore({ tabs: structuredClone(tabs), panel: "settings" });
                  const dispose = render(() => createComponent(BrowserTools, {
                    get panel() { return state.panel }, get tabs() { return state.tabs },
                    get tab() { return state.tabs.tabs.find(tab => tab.id === state.tabs.activeID) },
                    command, close() {}, open() {}
                  }), host);
                  return { dispose, update: tabs => setState("tabs", structuredClone(tabs)), panel: panel => setState("panel", panel), layout: setLayoutDesigns };
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
        lib: { entry: "settings-fixture", formats: ["es"], fileName: () => "settings.mjs" },
      },
    })
    const fixture = await import(pathToFileURL(join(directory, "settings.mjs")).href)
    const tabs: BrowserTabs = {
      sessionID: "current",
      tabs: [
        {
          id: "one",
          title: "Current tab",
          url: "https://display.example",
          loading: false,
          canGoBack: false,
          canGoForward: false,
          loadFailed: false,
          agentAccess: true,
          access: {
            loading: false,
            hostAllowed: false,
            blank: false,
            transferGuarded: true,
            transferSource: "default",
            transferRule: { origin: "*", uploads: "ask", downloads: "ask" },
          },
        },
      ],
      profile: {
        history: [],
        credentials: [],
        rememberHistory: true,
        vaultAvailable: false,
        transferRules: [{ origin: "*", uploads: "ask", downloads: "ask" }],
        preferences: {
          agentEnabled: true,
          agentHistory: "allow",
          offerSaveLogins: false,
          webLinks: "external",
          localLinks: "browser",
          showFullURL: true,
          selectionScreenshots: false,
          askDownloadLocation: true,
          restoreTabs: true,
          searchEngine: "duckduckgo",
        },
      },
    }
    const calls: BrowserCommand[] = []
    let finish: (() => void) | undefined
    const mounted = fixture.mount(host, tabs, async (command: BrowserCommand) => {
      calls.push(command)
      if (command.op === "access" && command.enabled)
        await new Promise<void>((resolve) => {
          finish = resolve
        })
    })
    dispose = mounted.dispose
    const row = () => host.querySelector("[data-access-tab=one]")!
    const select = (label: string) =>
      [...host.querySelectorAll<HTMLElement>("[data-component=select]")].find(
        (element) => element.getAttribute("aria-label") === label,
      )!
    const choose = async (element: HTMLElement, label: string, expected?: string[]) => {
      const trigger = element.querySelector<HTMLButtonElement>("button")!
      trigger.focus()
      trigger.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }))
      await Promise.resolve()
      const listbox = document.getElementById(`${element.id}-listbox`)
      const options = [...(listbox?.querySelectorAll<HTMLElement>('[role="option"]') ?? [])]
      if (expected) expect(options.map((option) => option.textContent?.trim())).toEqual(expected)
      const option = options.find((value) => value.textContent?.trim() === label)
      expect(option).toBeDefined()
      option!.click()
      await new Promise<void>((resolve) => setImmediate(resolve))
    }
    const button = (text: string) => {
      const element = [...host.querySelectorAll("button")].find((element) => element.textContent?.trim() === text)
      expect(element).toBeDefined()
      return element!
    }
    expect(host.textContent).not.toContain("Add host")
    expect(calls).toEqual([])
    expect(row().textContent).toContain("Agent Access is on for this entire tab")
    expect(row().textContent).toContain("Page tools need no further approval")
    expect(row().textContent).not.toContain("Page tools eligible")
    expect(row().textContent).toContain("Resolved transfer policy: default")
    mounted.layout(true)
    expect(host.querySelector('[data-component="settings-v2-row"]')).not.toBeNull()
    mounted.layout(false)
    const uploads = [...host.querySelectorAll("label")]
      .find((label) => label.textContent?.trim().startsWith("Uploads"))!
      .querySelector("select")!
    expect([...uploads.options].map((option) => option.value)).toEqual(["block", "ask"])
    expect(host.textContent).toContain("Main history-search policy: Allow")
    const search = select("Default search engine")
    expect(search.querySelector("button")?.textContent).toContain("DuckDuckGo")
    await choose(search, "Google", ["DuckDuckGo (duck.com)", "Google", "Bing"])
    expect(calls.at(-1)).toEqual({ op: "preferences", values: { searchEngine: "google" } })
    calls.length = 0
    mounted.update({ ...tabs, tabs: [{ ...tabs.tabs[0], access: undefined }] })
    expect(row().textContent).toContain("Effective access unavailable")
    expect(row().textContent).not.toContain("Page tools eligible")
    mounted.update({
      ...tabs,
      tabs: [
        {
          ...tabs.tabs[0],
          agentAccess: false,
          access: {
            ...tabs.tabs[0].access!,
            hostAllowed: true,
            transferSource: "exception",
            transferRule: { origin: "https://actual.example:8443", uploads: "block", downloads: "allow" },
          },
        },
      ],
    })
    expect(row().textContent).toContain("tab grant is off")
    expect(row().textContent).toContain("Transfer rules remain enforced")
    expect(row().textContent).toContain("exception for https://actual.example:8443")
    expect(row().textContent).toContain("Uploads: Block")
    button("Request tab access").click()
    expect(finish).toBeDefined()
    button("Revoke tab access / cancel pending grant").click()
    const global = [...host.querySelectorAll("input")].find((input) => input.type === "checkbox")!
    expect(global.disabled).toBe(false)
    global.checked = false
    global.dispatchEvent(new Event("change", { bubbles: true }))
    expect(calls).toEqual([
      { op: "access", tabID: "one", enabled: true },
      { op: "access", tabID: "one", enabled: false },
      { op: "preferences", values: { agentEnabled: false } },
    ])
    finish!()
    await Promise.resolve()
    mounted.update({ ...tabs, tabs: [{ ...tabs.tabs[0], access: { ...tabs.tabs[0].access!, hostAllowed: true } }] })
    expect(row().textContent).toContain("Agent Access is on for this entire tab. Page tools need no further approval.")
    mounted.update({
      ...tabs,
      tabs: [{ ...tabs.tabs[0], access: { ...tabs.tabs[0].access!, hostAllowed: true, loading: true } }],
    })
    expect(row().textContent).toContain("main page is loading")
    expect(row().textContent).not.toContain("Page tools eligible")
    expect(row().textContent).not.toContain("Open a website in this tab")
    mounted.update({
      ...tabs,
      profile: { ...tabs.profile!, preferences: { ...tabs.profile!.preferences!, agentEnabled: false } },
    })
    expect(row().textContent).toContain("global agent access is off")
    expect(host.textContent).toContain("Agent history tools are blocked by the global switch")

    await new Promise<void>((resolve) => setImmediate(resolve))
    expect(button("Save site permissions").disabled).toBe(false)
    const selectors = (text: string) => [
      ...[...host.querySelectorAll("label")]
        .filter((label) => label.textContent?.trim().startsWith(text))
        .flatMap((label) => [...label.querySelectorAll<HTMLSelectElement>("select")]),
      ...[...host.querySelectorAll<HTMLElement>("[data-component=select]")].filter(
        (element) => element.querySelector("button")?.getAttribute("aria-label") === text,
      ),
    ]
    const site = { origin: "https://display.example", camera: "allow" as const, microphone: "ask" as const }
    for (const panel of ["settings", "site"]) {
      mounted.panel(panel)
      for (const notificationsSupported of [undefined, false, true]) {
        mounted.update({
          ...tabs,
          activeID: "one",
          profile: {
            ...tabs.profile!,
            notificationsSupported,
            displayCaptureSupported: true,
            clipboardSupported: true,
            sites: [site],
          },
        })
        expect(selectors("Notifications")).toHaveLength(
          notificationsSupported === true ? (panel === "settings" ? 2 : 1) : 0,
        )
        if (notificationsSupported !== true) {
          expect(host.textContent).toContain(
            notificationsSupported === false
              ? "Native notifications are unavailable"
              : "Notification controls require a supported main process",
          )
          continue
        }
        const notificationControl = selectors("Notifications").at(-1)!
        if (notificationControl instanceof HTMLSelectElement) {
          expect(notificationControl.value).toBe("block")
          expect([...notificationControl.options].map((option) => option.value)).toEqual(["block", "ask", "allow"])
        } else {
          expect(notificationControl.querySelector("button")?.textContent).toContain("Block")
        }
        for (const [label, field] of [
          ["Notifications", "notifications"],
          ["Screen sharing", "displayCapture"],
          ["Clipboard", "clipboard"],
          ["Camera", "camera"],
          ["Microphone", "microphone"],
        ]) {
          const current = field === "camera" ? "allow" : field === "microphone" ? "ask" : "block"
          for (const value of ["ask", "allow", "block"]) {
            // Let BrowserTools finish its async command before the next user edit.
            await new Promise<void>((resolve) => setImmediate(resolve))
            const control = selectors(label).at(-1)!
            const count = calls.length
            if (control instanceof HTMLSelectElement) {
              expect(control.disabled).toBe(false)
              expect([...control.options].map((option) => option.value)).toEqual(["block", "ask", "allow"])
              control.value = value
              control.dispatchEvent(new Event("change", { bubbles: true }))
            } else {
              expect(control.querySelector("button")?.hasAttribute("disabled")).toBe(false)
              await choose(control, value === "ask" ? "Ask" : value === "allow" ? "Allow" : "Block", [
                "Block",
                "Ask",
                "Allow",
              ])
            }
            expect(calls).toHaveLength(count + (control instanceof HTMLSelectElement || value !== current ? 1 : 0))
            if (value !== current)
              expect(calls.at(-1)).toEqual({ op: "site-permission", origin: site.origin, [field]: value })
          }
        }
        await new Promise<void>((resolve) => setImmediate(resolve))
      }
    }
    mounted.update({
      ...tabs,
      activeID: "one",
      profile: {
        ...tabs.profile!,
        notificationsSupported: true,
        displayCaptureSupported: false,
        clipboardSupported: false,
        sites: [site],
      },
    })
    expect(selectors("Screen sharing")).toHaveLength(0)
    expect(selectors("Clipboard")).toHaveLength(0)
    expect(host.textContent).toContain("Location stays blocked")
    mounted.panel("downloads")
    mounted.update({
      ...tabs,
      downloads: [{ id: "recoverable", filename: "file.bin", state: "interrupted", canResume: true }],
    })
    expect(host.textContent).toContain("Resume if the server still supports it")
    button("Resume saved download").click()
    expect(calls.at(-1)).toEqual({ op: "recover-download", id: "recoverable" })
    await new Promise<void>((resolve) => setImmediate(resolve))
    mounted.update({
      ...tabs,
      downloads: [{ id: "recoverable", filename: "file.bin", state: "saving", canControl: true, canPause: false }],
    })
    expect([...host.querySelectorAll("button")].some((entry) => entry.textContent?.trim() === "Pause")).toBe(false)
    expect(
      [...host.querySelectorAll("button")].some((entry) => entry.textContent?.trim() === "Resume saved download"),
    ).toBe(false)
    button("Cancel").click()
    expect(calls.at(-1)).toEqual({ op: "download-control", id: "recoverable", action: "cancel" })
    await new Promise<void>((resolve) => setImmediate(resolve))
    mounted.update({ ...tabs, downloads: [{ id: "legacy", filename: "file.bin", state: "interrupted" }] })
    expect(host.textContent).toContain("Try again from the page")
    expect(
      [...host.querySelectorAll("button")].some((entry) => entry.textContent?.trim() === "Resume saved download"),
    ).toBe(false)
  } finally {
    dispose?.()
    host.remove()
    await rm(directory, { recursive: true, force: true })
  }
}, 30_000)
