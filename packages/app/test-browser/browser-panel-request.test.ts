import { expect, test } from "bun:test"
import { mkdtemp, rm } from "node:fs/promises"
import { join, resolve } from "node:path"
import { pathToFileURL } from "node:url"
import { build } from "vite"
import solid from "vite-plugin-solid"
import type { BrowserPanelPlatform, DesktopPanelAcknowledgement, DesktopPanelRequest } from "../src/browser-panel"

test("renderer panel requests wait for reached state and reject stale, cancelled and expired work", async () => {
  const directory = await mkdtemp(resolve("test-browser/.panel-request-"))
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
          name: "panel-request-fixture",
          enforce: "pre",
          resolveId(id) {
            const name = ["panel-request-fixture", "@/context/platform", "@/context/language", "@/utils/toast"].find(
              (name) =>
                id === name || id.replaceAll("\\", "/") === resolve(name.replace("@/", "src/")).replaceAll("\\", "/"),
            )
            return name ? "\0" + name : undefined
          },
          load(id) {
            if (id === "\0@/context/platform")
              return "export let platform; export const setup = value => platform = value; export const usePlatform = () => platform"
            if (id === "\0@/context/language") return "export const useLanguage = () => ({ t: key => key })"
            if (id === "\0@/utils/toast") return "export const showToast = () => {}"
            if (id === "\0panel-request-fixture")
              return `import { createComponent } from "solid-js";
                import { createStore } from "solid-js/store";
                import { render } from "solid-js/web";
                import { setup } from "@/context/platform";
                import { useBrowserLinks } from ${JSON.stringify(resolve("src/components/browser-panel/browser-links.ts"))};
                export function mount(host, browser, callbacks) {
                  setup({ browserPanel: browser });
                  const [state, setState] = createStore({ sessionID: "task" });
                  const dispose = render(() => createComponent(() => {
                    useBrowserLinks({ sessionID: () => state.sessionID, ...callbacks });
                    return null;
                  }, {}), host);
                  return { dispose, selectSession: id => setState("sessionID", id) };
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
        lib: { entry: "panel-request-fixture", formats: ["es"], fileName: () => "panel-request.mjs" },
      },
    })
    const fixture = await import(pathToFileURL(join(directory, "panel-request.mjs")).href)
    let request: (input: DesktopPanelRequest) => void = () => {}
    let cancel: (id: string) => void = () => {}
    let opened: (sessionID: string) => void = () => {}
    const links: (string | null)[] = []
    const applied: DesktopPanelRequest[] = []
    const acknowledgements: DesktopPanelAcknowledgement[] = []
    const nextAck = () => Promise.withResolvers<DesktopPanelAcknowledgement>()
    let ack = nextAck()
    let ready = false
    let accepted = false
    let legacy = 0
    let unsubscribed = 0
    let gate: Promise<boolean> | undefined
    let checked = Promise.withResolvers<void>()
    const browser = {
      linkContext: async (sessionID) => {
        links.push(sessionID)
      },
      onOpened: (callback) => {
        opened = callback
        return () => {
          unsubscribed++
        }
      },
      onPanelRequest: (callback) => {
        request = callback
        return () => {
          unsubscribed++
        }
      },
      onPanelCancel: (callback) => {
        cancel = callback
        return () => {
          unsubscribed++
        }
      },
      panelRequestCurrent: async () => {
        checked.resolve()
        return gate ?? true
      },
      acknowledgePanel: async (input) => {
        acknowledgements.push(input)
        ack.resolve(input)
        return accepted
      },
    } satisfies Partial<BrowserPanelPlatform>
    const mounted = fixture.mount(host, browser, {
      open: () => {
        legacy++
      },
      setPanel: (input: DesktopPanelRequest) => {
        applied.push(input)
      },
      reached: () => ready,
    })
    dispose = mounted.dispose
    const panel = (id: string, view: "review" | "hidden" = "review"): DesktopPanelRequest => ({
      id,
      sessionID: "task",
      deadline: Date.now() + 10_000,
      view,
    })
    const frame = () => new Promise<void>((resolve) => requestAnimationFrame(() => resolve()))

    opened("foreign")
    opened("task")
    expect(legacy).toBe(1)
    request(panel("first"))
    await checked.promise
    await frame()
    expect(applied.map((input) => input.id)).toEqual(["first"])
    expect(acknowledgements).toEqual([])
    ready = true
    expect(await ack.promise).toEqual({ id: "first", sessionID: "task", view: "review" })
    // A native viewport not yet ready returns false; the same request must wait for settlement.
    ack = nextAck()
    accepted = true
    await ack.promise
    await frame()
    const completed = acknowledgements.length
    await frame()
    expect(acknowledgements.length).toBe(completed)

    ack = nextAck()
    request({ ...panel("browser"), view: "browser", tabID: "native" })
    expect(await ack.promise).toEqual({ id: "browser", sessionID: "task", view: "browser", tabID: "native" })
    ack = nextAck()
    request(panel("hidden", "hidden"))
    expect(await ack.promise).toEqual({ id: "hidden", sessionID: "task", view: "hidden" })

    const rejectedCount = applied.length
    gate = Promise.resolve(false)
    checked = Promise.withResolvers<void>()
    request(panel("not-current"))
    await checked.promise
    await frame()
    request({ ...panel("foreign"), sessionID: "foreign" })
    request({ ...panel("expired"), deadline: Date.now() - 1 })
    expect(applied.length).toBe(rejectedCount)
    gate = undefined
    ready = false
    checked = Promise.withResolvers<void>()
    request(panel("cancel-after-switch"))
    await checked.promise
    await frame()
    expect(applied.at(-1)?.id).toBe("cancel-after-switch")
    cancel("cancel-after-switch")
    const cancelledCount = acknowledgements.length
    ready = true
    await frame()
    expect(acknowledgements.length).toBe(cancelledCount)

    for (const invalidation of ["cancel", "session", "supersede", "deadline", "dispose"] as const) {
      const held = Promise.withResolvers<boolean>()
      gate = held.promise
      checked = Promise.withResolvers<void>()
      const count = applied.length
      const waiting = panel(invalidation)
      request(waiting)
      await checked.promise
      if (invalidation === "cancel") cancel(invalidation)
      if (invalidation === "session") mounted.selectSession("other")
      if (invalidation === "supersede") {
        request(panel("newer"))
        cancel("newer")
      }
      if (invalidation === "deadline") waiting.deadline = Date.now() - 1
      if (invalidation === "dispose") {
        dispose?.()
        dispose = undefined
      }
      held.resolve(true)
      await frame()
      expect(applied.length).toBe(count)
      mounted.selectSession("task")
    }
    expect(unsubscribed).toBe(3)
    expect(links).toContain("other")
    expect(links.at(-1)).toBeNull()
  } finally {
    dispose?.()
    host.remove()
    await rm(directory, { recursive: true, force: true })
  }
})
