import { expect, test } from "bun:test"
import { mkdtemp, rm } from "node:fs/promises"
import { join, resolve } from "node:path"
import { pathToFileURL } from "node:url"
import { build } from "vite"
import solid from "vite-plugin-solid"

test("browser layout swaps preserve actions, accessible state and native menu shortcuts", async () => {
  const directory = await mkdtemp(resolve("test-browser/.native-controls-"))
  const host = document.createElement("div")
  const direction = document.documentElement.dir
  document.body.append(host)
  let dispose: (() => void) | undefined
  try {
    await build({
      configFile: false,
      root: resolve("."),
      logLevel: "warn",
      plugins: [
        {
          name: "native-controls-fixture",
          enforce: "pre",
          resolveId(id) {
            const normalized = id.replaceAll("\\", "/")
            if (
              id === "native-controls-fixture" ||
              normalized === resolve("native-controls-fixture").replaceAll("\\", "/")
            )
              return "\0native-controls-fixture.tsx"
            if (id === "@/context/settings" || normalized === resolve("src/context/settings").replaceAll("\\", "/"))
              return "\0settings"
          },
          load(id) {
            if (id === "\0settings")
              return `import { createStore } from "solid-js/store";
                const [state, setState] = createStore({ layout: false });
                export const setLayout = value => setState("layout", value);
                export const useSettings = () => ({ general: { newLayoutDesigns: () => state.layout } });`
            if (id === "\0native-controls-fixture.tsx")
              return `import { render } from "solid-js/web";
                import { createComponent } from "solid-js";
                import { createStore } from "solid-js/store";
                import { setLayout } from "@/context/settings";
                import { BrowserButton, BrowserIconButton, BrowserDropdownMenu } from ${JSON.stringify(resolve("src/components/browser-panel/browser-native-controls.tsx"))};
                export { setLayout };
                export function mount(host) {
                  const [state, setState] = createStore({ count: 0, pressed: false, disabled: false });
                  const dispose = render(() => [
                    createComponent(BrowserButton, { "data-test": "action", icon: "plus", get disabled() { return state.disabled }, onClick: () => setState("count", state.count + 1), children: "Run" }),
                    createComponent(BrowserIconButton, { "data-test": "toggle", icon: "star", variant: "ghost", "aria-label": "Pin", get "aria-pressed"() { return state.pressed }, get disabled() { return state.disabled }, onClick: () => setState("pressed", !state.pressed) }),
                    createComponent(BrowserDropdownMenu, { get children() { return [
                      createComponent(BrowserDropdownMenu.Trigger, { as: BrowserIconButton, icon: "dot-grid", variant: "ghost", "aria-label": "Actions" }),
                      createComponent(BrowserDropdownMenu.Portal, { get children() { return createComponent(BrowserDropdownMenu.Content, { get children() {
                        return createComponent(BrowserDropdownMenu.Item, { shortcut: "Ctrl+F", onSelect: () => setState("count", state.count + 1), get children() { return createComponent(BrowserDropdownMenu.ItemLabel, { children: "Find" }) } });
                      } }); } })
                    ]; } })
                  ], host);
                  return { dispose, state, setDisabled: value => setState("disabled", value) };
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
        lib: { entry: "native-controls-fixture", formats: ["es"], fileName: () => "controls.mjs" },
      },
    })
    const fixture = await import(pathToFileURL(join(directory, "controls.mjs")).href)
    const mounted = fixture.mount(host)
    dispose = mounted.dispose
    for (const [layout, dir] of [
      [false, "ltr"],
      [true, "ltr"],
      [false, "rtl"],
      [true, "rtl"],
      [false, "ltr"],
    ] as const) {
      document.documentElement.dir = dir
      fixture.setLayout(layout)
      await Promise.resolve()
      const action = host.querySelector<HTMLButtonElement>('[data-test="action"]')!
      const toggle = host.querySelector<HTMLButtonElement>('[data-test="toggle"]')!
      expect(action.dataset.component).toBe(layout ? "button-v2" : "button")
      expect(toggle.dataset.component).toBe(layout ? "icon-button-v2" : "icon-button")
      expect(toggle.getAttribute("aria-label")).toBe("Pin")
      const count = mounted.state.count
      action.click()
      expect(mounted.state.count).toBe(count + 1)
      const pressed = mounted.state.pressed
      toggle.click()
      expect(toggle.getAttribute("aria-pressed")).toBe(String(!pressed))
      if (layout) expect(toggle.dataset.state).toBe(!pressed ? "pressed" : "rest")
      mounted.setDisabled(true)
      action.click()
      toggle.click()
      expect(mounted.state.count).toBe(count + 1)
      expect(mounted.state.pressed).toBe(!pressed)
      mounted.setDisabled(false)
      const trigger = host.querySelector<HTMLButtonElement>('[aria-label="Actions"]')!
      trigger.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true, button: 0, pointerType: "mouse" }))
      trigger.click()
      await new Promise((resolve) => setTimeout(resolve, 20))
      const menu = document.querySelector('[role="menu"]')!
      expect(menu).toHaveProperty("dir", "ltr")
      expect(menu.getAttribute("data-component")).toBe(layout ? "menu-v2-content" : "dropdown-menu-content")
      const hint = menu.querySelector(
        layout ? '[data-slot="menu-v2-item-shortcut"]' : '[data-slot="dropdown-menu-item-description"]',
      )!
      expect(hint.textContent).toBe("Ctrl+F")
      expect(layout ? hint.querySelector('[dir="ltr"]') : hint).toHaveProperty("dir", "ltr")
      menu.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }))
      await new Promise((resolve) => setTimeout(resolve, 20))
    }
  } finally {
    dispose?.()
    host.remove()
    document.documentElement.dir = direction
    await rm(directory, { recursive: true, force: true })
  }
})
