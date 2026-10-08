import { expect, test } from "bun:test"
import { mkdtemp, rm } from "node:fs/promises"
import { join, resolve } from "node:path"
import { pathToFileURL } from "node:url"
import { build } from "vite"
import solid from "vite-plugin-solid"
import { paths } from "@opencode-ai/ui/phosphor"

test("both icon renderers use Regular assets with the correct scale and panel orientation", async () => {
  const directory = await mkdtemp(resolve("test-browser/.phosphor-"))
  const host = document.createElement("div")
  document.body.append(host)
  try {
    await Bun.write(
      join(directory, "fixture.tsx"),
      `
      import { render } from "solid-js/web"
      import { Icon } from "@opencode-ai/ui/icon"
      import { ProviderIcon } from "@opencode-ai/ui/provider-icon"
      import { FileIcon } from "@opencode-ai/ui/file-icon"
      import { AppIcon } from "@opencode-ai/ui/app-icon"
      export async function mount(host) {
        const v2 = await import("@opencode-ai/ui/v2/icon")
        return render(() => <>
          <Icon name="copy" />
          <Icon name="terminal-active" />
          <v2.Icon name="outline-copy" />
          <v2.Icon name="sidebar-right" />
          <ProviderIcon id="cookiemonster" />
          <FileIcon node={{ path: "report.pdf", type: "file" }} />
          <AppIcon id="terminal" alt="Terminal" />
        </>, host)
      }
    `,
    )
    await build({
      configFile: false,
      root: resolve("."),
      logLevel: "warn",
      plugins: [solid()],
      build: {
        outDir: join(directory, "dist"),
        lib: { entry: join(directory, "fixture.tsx"), formats: ["es"], fileName: "fixture" },
      },
    })
    const fixture = await import(pathToFileURL(join(directory, "dist/fixture.js")).href)
    const dispose = await fixture.mount(host)
    try {
      expect(host.querySelectorAll('svg[viewBox="0 0 256 256"]').length).toBe(7)
      expect(host.querySelector('[data-active="true"] use')?.getAttribute("href")).toBe(
        "#opencode-icon-terminal-active",
      )
      expect(document.querySelector("#opencode-icon-copy path")?.getAttribute("d")).toBe(paths.copy)
      expect(document.querySelector("#opencode-v2-icon-outline-copy path")?.getAttribute("d")).toBe(paths.copy)
      expect(document.querySelector("#opencode-v2-icon-sidebar-right path")?.getAttribute("transform")).toBe(
        "translate(256 0) scale(-1 1)",
      )
      expect(host.querySelector('[data-component="provider-icon"] path')?.getAttribute("d")).toBe(paths.plugs)
      expect(host.querySelector('[data-component="file-icon"] path')?.getAttribute("d")).toBe(paths["file-pdf"])
      expect(host.querySelector('[data-component="app-icon"] path')?.getAttribute("d")).toBe(paths["terminal-window"])
      expect(host.querySelector('[data-component="app-icon"]')?.getAttribute("aria-label")).toBe("Terminal")
      expect(host.querySelector('[data-component="app-icon"]')?.getAttribute("width")).toBe("16")
    } finally {
      dispose()
    }
  } finally {
    host.remove()
    await rm(directory, { recursive: true, force: true })
  }
})
