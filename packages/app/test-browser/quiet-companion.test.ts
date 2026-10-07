import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from "bun:test"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import { pathToFileURL } from "node:url"
import { build } from "vite"
import solid from "vite-plugin-solid"
import type { Platform } from "../src/context/platform"

type Fixture = typeof import("./quiet-companion.fixture")

const state: { directory?: string; fixture?: Fixture; css?: string } = {}
const cleanups: (() => void)[] = []

beforeAll(async () => {
  state.directory = await mkdtemp(join(tmpdir(), "cm-quiet-companion-test-"))
  await build({
    configFile: false,
    root: resolve("."),
    logLevel: "error",
    plugins: [solid()],
    resolve: { alias: { "@": resolve("src") } },
    build: {
      outDir: state.directory,
      emptyOutDir: false,
      minify: false,
      cssTarget: "chrome100",
      cssMinify: "esbuild",
      lib: {
        entry: resolve("test-browser/quiet-companion.fixture.tsx"),
        formats: ["es"],
        fileName: () => "quiet-companion.mjs",
        cssFileName: "quiet-companion",
      },
      rollupOptions: { output: { inlineDynamicImports: true } },
    },
  })
  state.fixture = await import(pathToFileURL(join(state.directory, "quiet-companion.mjs")).href)
  state.css = await Bun.file(join(state.directory, "quiet-companion.css")).text()
}, 60_000)

const device = (window as Window & { happyDOM: { settings: { device: { prefersColorScheme: string } } } }).happyDOM
  .settings.device

beforeEach(() => {
  const keys = ["opencode-theme-id", "opencode-color-scheme"]
  const stored = keys.map((key) => [key, localStorage.getItem(key)] as const)
  const attributes = ["data-theme", "data-color-scheme", "style"].map(
    (name) => [name, document.documentElement.getAttribute(name)] as const,
  )
  const previous = device.prefersColorScheme
  const themeCss = document.getElementById("oc-theme")?.textContent
  keys.forEach((key) => localStorage.removeItem(key))
  device.prefersColorScheme = "light"
  const style = document.createElement("style")
  style.textContent = state.css!
  document.head.append(style)
  cleanups.push(() => {
    style.remove()
    stored.forEach(([key, value]) => {
      if (value === null) localStorage.removeItem(key)
      else localStorage.setItem(key, value)
    })
    attributes.forEach(([name, value]) => {
      if (value === null) document.documentElement.removeAttribute(name)
      else document.documentElement.setAttribute(name, value)
    })
    const theme = document.getElementById("oc-theme")
    if (theme && themeCss !== undefined) theme.textContent = themeCss
    if (themeCss === undefined) theme?.remove()
    device.prefersColorScheme = previous
  })
})

afterEach(() => {
  cleanups
    .splice(0)
    .reverse()
    .forEach((cleanup) => cleanup())
})

afterAll(async () => {
  if (state.directory) await rm(state.directory, { recursive: true, force: true })
})

function setup(stored?: string) {
  const storage = new Map<string, string>()
  if (stored) storage.set("default:settings.v3", stored)
  const external: string[] = []
  const platform: Platform = {
    platform: "desktop",
    os: "windows",
    openExternal(url) {
      external.push(url)
    },
    restart: async () => {},
    notify: async () => {},
    openDirectoryPickerDialog: async () => [],
    storage: (name = "default") => ({
      getItem: async (key) => storage.get(`${name}:${key}`) ?? null,
      setItem: async (key, value) => {
        storage.set(`${name}:${key}`, value)
      },
      removeItem: async (key) => {
        storage.delete(`${name}:${key}`)
      },
    }),
  }
  const mount = () => {
    const host = document.createElement("div")
    document.body.append(host)
    const mounted = state.fixture!.mount(host, platform)
    cleanups.push(() => {
      mounted.dispose()
      host.remove()
    })
    return { ...mounted, host }
  }
  return { mount, storage, external }
}

async function ready(mounted: ReturnType<ReturnType<typeof setup>["mount"]>) {
  const deadline = Date.now() + 2_000
  while (!mounted.ready() && Date.now() < deadline) await Bun.sleep(10)
  expect(mounted.ready()).toBe(true)
  await Bun.sleep(0)
}

describe("CM3 live shell", () => {
  test("keeps one live child mounted and its draft across UI switches", async () => {
    const mounted = setup().mount()
    await ready(mounted)
    const child = mounted.host.querySelector<HTMLTextAreaElement>('[data-testid="draft"]')!
    child.value = "Unsaved real draft"
    child.dispatchEvent(new Event("input", { bubbles: true }))
    const current = mounted.host.querySelector<HTMLElement>('[data-component="current-ui"]')!
    for (const enabled of [true, false, true, false]) {
      mounted.enable(enabled)
      await Bun.sleep(0)
      expect(current.classList.contains("cm3-live")).toBe(enabled)
      expect(current.inert).toBe(false)
      expect(current.hidden).toBe(false)
      expect(mounted.host.querySelector('[data-testid="draft"]')).toBe(child)
      expect(child.value).toBe("Unsaved real draft")
      expect(mounted.counts.mounts).toBe(1)
      expect(mounted.counts.cleanups).toBe(0)
      expect(mounted.host.querySelector(".qc-composer")).toBeNull()
    }
  })

  test("keeps production commands available in CM3", async () => {
    const mounted = setup().mount()
    await ready(mounted)
    mounted.enable(true)
    await Bun.sleep(0)
    expect(mounted.suspended()).toBe(false)
    document.dispatchEvent(new KeyboardEvent("keydown", { key: "q", altKey: true, bubbles: true }))
    expect(mounted.counts.commands).toBe(1)
  })

  test("persists CM3 preference and returns through its visible control", async () => {
    const fixture = setup()
    const first = fixture.mount()
    await ready(first)
    first.enable(true)
    await Bun.sleep(0)
    expect(JSON.parse(fixture.storage.get("default:settings.v3")!).general.quietCompanion).toBe(true)
    first.dispose()
    const second = fixture.mount()
    await ready(second)
    expect(second.enabled()).toBe(true)
    second.host.querySelector<HTMLButtonElement>('[data-action="quiet-companion-return"]')!.click()
    await Bun.sleep(0)
    expect(second.enabled()).toBe(false)
    expect(JSON.parse(fixture.storage.get("default:settings.v3")!).general.quietCompanion).toBe(false)
  })

  test("uses the shared theme controls", async () => {
    const mounted = setup().mount()
    await ready(mounted)
    mounted.enable(true)
    await Bun.sleep(0)
    const select = mounted.host.querySelector<HTMLSelectElement>('[data-action="quiet-companion-scheme"]')!
    select.value = "dark"
    select.dispatchEvent(new Event("change", { bubbles: true }))
    expect(mounted.theme().colorScheme()).toBe("dark")
    expect(mounted.theme().mode()).toBe("dark")
  })

  test.each([undefined, JSON.stringify({ general: { autoSave: false } })])(
    "defaults existing users to Current UI",
    async (stored) => {
      const mounted = setup(stored).mount()
      await ready(mounted)
      expect(mounted.enabled()).toBe(false)
      expect(mounted.host.querySelector(".cm3-live")).toBeNull()
      expect(mounted.host.querySelector<HTMLElement>('[data-component="current-ui"]')!.style.display).toBe("contents")
    },
  )
})
