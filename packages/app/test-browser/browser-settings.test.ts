import { expect, test } from "bun:test"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import { pathToFileURL } from "node:url"
import { build } from "vite"
import solid from "vite-plugin-solid"
import type { BrowserCommand, BrowserTabs } from "../src/browser-panel"

test("mounted settings show main eligibility and allow revocation during pending consent", async () => {
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
          },
          load(id) {
            if (id === "\0settings-language")
              return `import { browser } from ${JSON.stringify(resolve("src/i18n/en.ts"))};
                export const useLanguage = () => ({ t: (key, params = {}) => Object.entries(params).reduce((text, [key, value]) => text.replaceAll("{{" + key + "}}", String(value)), browser[key] ?? key) })`
            if (id === "\0settings-fixture")
              return `import { createComponent } from "solid-js";
                import { render } from "solid-js/web";
                import { createStore } from "solid-js/store";
                import { BrowserTools } from ${JSON.stringify(resolve("src/components/browser-panel/browser-tools.tsx"))};
                export function mount(host, tabs, command) {
                  const [state, setState] = createStore({ tabs: structuredClone(tabs), panel: "settings" });
                  const dispose = render(() => createComponent(BrowserTools, {
                    get panel() { return state.panel }, get tabs() { return state.tabs },
                    get tab() { return state.tabs.tabs.find(tab => tab.id === state.tabs.activeID) },
                    command, close() {}, open() {}
                  }), host);
                  return { dispose, update: tabs => setState("tabs", structuredClone(tabs)), panel: panel => setState("panel", panel) };
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
        agentHosts: ["display.example"],
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
    const button = (text: string) => {
      const element = [...host.querySelectorAll("button")].find((element) => element.textContent?.trim() === text)
      expect(element).toBeDefined()
      return element!
    }
    expect(calls).toEqual([])
    expect(row().textContent).toContain("loaded host is not allowed")
    expect(row().textContent).not.toContain("Page tools eligible")
    expect(row().textContent).toContain("Resolved transfer policy: default")
    const uploads = [...host.querySelectorAll("label")]
      .find((label) => label.textContent?.trim().startsWith("Uploads"))!
      .querySelector("select")!
    expect([...uploads.options].map((option) => option.value)).toEqual(["block", "ask"])
    expect(host.textContent).toContain("Main history-search policy: Allow")
    const search = [...host.querySelectorAll("label")]
      .find((label) => label.textContent?.includes("Default search engine"))!
      .querySelector("select")!
    expect([...search.options].map((option) => option.value)).toEqual(["duckduckgo", "google", "bing"])
    search.value = "google"
    search.dispatchEvent(new Event("change", { bubbles: true }))
    await new Promise<void>((resolve) => setImmediate(resolve))
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
    expect(row().textContent).toContain("Page tools eligible in main; OpenCode tool approval still applies")
    mounted.update({
      ...tabs,
      tabs: [{ ...tabs.tabs[0], access: { ...tabs.tabs[0].access!, hostAllowed: true, loading: true } }],
    })
    expect(row().textContent).toContain("main page is loading")
    expect(row().textContent).not.toContain("Page tools eligible")
    expect(row().textContent).not.toContain("loaded host is not allowed")
    mounted.update({
      ...tabs,
      profile: { ...tabs.profile!, preferences: { ...tabs.profile!.preferences!, agentEnabled: false } },
    })
    expect(row().textContent).toContain("global agent access is off")
    expect(host.textContent).toContain("Agent history tools are blocked by the global switch")

    await new Promise<void>((resolve) => setImmediate(resolve))
    expect(button("Save site permissions").disabled).toBe(false)
    const selectors = (text: string) =>
      [...host.querySelectorAll("label")]
        .filter((label) => label.textContent?.trim().startsWith(text))
        .map((label) => label.querySelector("select")!)
    const site = { origin: "https://display.example", camera: "allow" as const, microphone: "ask" as const }
    for (const panel of ["settings", "site"]) {
      mounted.panel(panel)
      for (const notificationsSupported of [undefined, false, true]) {
        mounted.update({
          ...tabs,
          activeID: "one",
          profile: { ...tabs.profile!, notificationsSupported, sites: [site] },
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
        expect(selectors("Notifications").at(-1)!.value).toBe("block")
        expect([...selectors("Notifications").at(-1)!.options].map((option) => option.value)).toEqual([
          "block",
          "ask",
          "allow",
        ])
        for (const [label, field] of [
          ["Notifications", "notifications"],
          ["Camera", "camera"],
          ["Microphone", "microphone"],
        ]) {
          for (const value of ["ask", "allow", "block"]) {
            // Let BrowserTools finish its async command before the next user edit.
            await new Promise<void>((resolve) => setImmediate(resolve))
            const select = selectors(label).at(-1)!
            expect(select.disabled).toBe(false)
            const count = calls.length
            select.value = value
            select.dispatchEvent(new Event("change", { bubbles: true }))
            expect(calls).toHaveLength(count + 1)
            expect(calls.at(-1)).toEqual({ op: "site-permission", origin: site.origin, [field]: value })
          }
        }
        await new Promise<void>((resolve) => setImmediate(resolve))
      }
    }
  } finally {
    dispose?.()
    host.remove()
    await rm(directory, { recursive: true, force: true })
  }
}, 30_000)
