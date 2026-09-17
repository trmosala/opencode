import type { WebContents } from "electron"
import type { browserPageContext } from "./tabs"
import type { BrowserSelection } from "@opencode-ai/app/browser-panel"
import { keepBrowserRendering } from "./rendering"

const WORLD = 998
const picking = new WeakSet<WebContents>()

export function cancelPicker(contents: WebContents) {
  if (!picking.has(contents) || contents.isDestroyed()) return
  void contents
    .executeJavaScriptInIsolatedWorld(WORLD, [
      {
        code: "window.__cookieMonsterCancelPickElement?.()",
      },
    ])
    .catch(() => undefined)
}

export async function captureBrowserContext(
  owner: Parameters<typeof browserPageContext>[0],
  sessionID: string,
  tabID: string,
  command: unknown,
): Promise<string | BrowserSelection | undefined> {
  const group = owner.groups.get(sessionID)
  const tab = group?.tabs.find((tab) => tab.id === tabID)
  // The menu temporarily detaches the native view. capturePage can still capture the selected tab.
  const screenshot = command === "screenshot" && group?.activeID === tabID && owner.win.isVisible()
  if (!group || !tab || (!screenshot && owner.attached !== tab) || tab.view.webContents.isDestroyed())
    throw new Error("Browser tab not visible")
  if (command !== "selection" && command !== "pick" && command !== "screenshot")
    throw new Error("Invalid browser context command")
  const contents = tab.view.webContents
  const frame = contents.mainFrame
  const revision = tab.revision
  const url = contents.getURL()
  const taskEpoch = owner.taskEpoch
  const screenshotEpoch = owner.screenshotEpoch
  let obsolete = false
  // ponytail: latch selection per capture; shared epochs also govern consent and tab settlement.
  const selectionChanged = () => {
    obsolete ||= group.activeID !== tabID
  }
  const check = () => {
    if (
      obsolete ||
      owner.shutting ||
      owner.win.isDestroyed() ||
      !owner.win.isVisible() ||
      owner.win.isMinimized() ||
      owner.taskEpoch !== taskEpoch ||
      owner.screenshotEpoch !== screenshotEpoch ||
      owner.groups.get(sessionID) !== group ||
      group?.tabs.find((entry) => entry.id === tabID) !== tab ||
      group.activeID !== tabID ||
      tab.view.webContents !== contents ||
      tab.contents !== contents ||
      contents.isDestroyed() ||
      contents.isLoadingMainFrame() ||
      contents.mainFrame !== frame ||
      frame.detached ||
      contents.getURL() !== url ||
      tab.revision !== revision ||
      (command !== "screenshot" && owner.attached !== tab)
    )
      throw new Error("Browser tab not visible")
  }
  check()
  const checks = (owner.captureChecks ??= new Set())
  checks.add(selectionChanged)
  try {
    const result = await browserContext(contents, command, check)
    check()
    return result
  } finally {
    checks.delete(selectionChanged)
  }
}

async function browserContext(contents: WebContents, command: "selection" | "pick" | "screenshot", check: () => void) {
  if (command === "screenshot") {
    const release = keepBrowserRendering(contents)
    try {
      // A reattached tab may not have submitted its first compositor frame yet.
      await contents.executeJavaScriptInIsolatedWorld(WORLD, [
        {
          code: "new Promise(resolve => { const timer = setTimeout(resolve, 1000); requestAnimationFrame(() => requestAnimationFrame(() => { clearTimeout(timer); resolve() })) })",
        },
      ])
      check()
      const image = await contents.capturePage()
      check()
      const size = image.getSize()
      if (image.isEmpty() || size.width * size.height > 32_000_000) throw new Error("Browser screenshot too large")
      const bytes = image.toPNG()
      if (bytes.length > 10 * 1024 * 1024) throw new Error("Browser screenshot too large")
      return `data:image/png;base64,${bytes.toString("base64")}`
    } finally {
      release()
    }
  }
  if (command === "selection") {
    const value: unknown = await contents.executeJavaScriptInIsolatedWorld(WORLD, [
      {
        code: "(window.getSelection()?.toString() || '').trim().slice(0, 12000)",
      },
    ])
    return typeof value === "string" ? value.slice(0, 12000) : ""
  }
  if (picking.has(contents)) throw new Error("Browser picker already active")
  picking.add(contents)
  try {
    const value: unknown = await contents.executeJavaScriptInIsolatedWorld(WORLD, [{ code: pickElementScript() }])
    if (!value || typeof value !== "object") return
    const input = value as Record<string, unknown>
    const keys = ["tag", "text", "role", "label", "id", "className"] as const
    if (!keys.every((key) => typeof input[key] === "string")) return
    return Object.fromEntries(keys.map((key) => [key, (input[key] as string).slice(0, 2000)])) as BrowserSelection
  } finally {
    picking.delete(contents)
  }
}

// The picker runs in an isolated world: site JS cannot replace its cancellation hook.
export function pickElementScript() {
  return `(() => new Promise((resolve) => {
    window.__cookieMonsterCancelPickElement?.()
    let hovered
    let outline = ""
    const cursor = document.documentElement.style.cursor
    const compact = (value) => String(value || "").replace(/\\s+/g, " ").trim().slice(0, 2000)
    const unhover = () => {
      if (hovered?.style) hovered.style.outline = outline
      hovered = undefined
    }
    const finish = (value) => {
      clearTimeout(timer)
      unhover()
      document.documentElement.style.cursor = cursor
      document.removeEventListener("mousemove", move, true)
      document.removeEventListener("click", click, true)
      document.removeEventListener("keydown", keydown, true)
      window.removeEventListener("pagehide", cancel)
      delete window.__cookieMonsterCancelPickElement
      resolve(value)
    }
    const cancel = () => finish(undefined)
    const move = (event) => {
      const next = document.elementFromPoint(event.clientX, event.clientY)
      if (!next || next === hovered) return
      unhover()
      hovered = next
      outline = hovered.style?.outline || ""
      if (hovered.style) hovered.style.outline = "2px solid #0ea5e9"
    }
    const click = (event) => {
      event.preventDefault()
      event.stopImmediatePropagation()
      const el = document.elementFromPoint(event.clientX, event.clientY) || event.target
      finish({
        tag: compact(el.tagName?.toLowerCase()), text: compact(el.innerText || el.textContent),
        role: compact(el.getAttribute("role")), label: compact(el.getAttribute("aria-label") || el.title),
        id: compact(el.id), className: compact(typeof el.className === "string" ? el.className : ""),
      })
    }
    const keydown = (event) => {
      if (event.key !== "Escape") return
      event.preventDefault()
      event.stopImmediatePropagation()
      cancel()
    }
    const timer = setTimeout(cancel, 30000)
    window.__cookieMonsterCancelPickElement = cancel
    document.documentElement.style.cursor = "crosshair"
    document.addEventListener("mousemove", move, true)
    document.addEventListener("click", click, true)
    document.addEventListener("keydown", keydown, true)
    window.addEventListener("pagehide", cancel)
  }))()`
}
