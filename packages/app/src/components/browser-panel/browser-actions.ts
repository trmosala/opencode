import type { ImageAttachmentPart, Prompt } from "@/context/prompt"
import { uuid } from "@/utils/uuid"
import type { BrowserElementSelection } from "./browser-context"

export type WebviewElement = HTMLElement & {
  src: string
  getTitle?: () => string
  getURL?: () => string
  canGoBack?: () => boolean
  canGoForward?: () => boolean
  goBack?: () => void
  goForward?: () => void
  reload?: () => void
  stop?: () => void
  capturePage?: () => Promise<{ toDataURL: () => string }>
  executeJavaScript?: <T>(code: string) => Promise<T>
}

// Minimal structural view of usePrompt() so this module (and its tests) stay free of Solid context.
type PromptTarget = {
  current: () => Prompt
  cursor: () => number | undefined
  set: (prompt: Prompt, cursor?: number) => void
}
type PromptInput = { capture: () => PromptTarget }

export type NavAction = "back" | "forward" | "reload" | "stop"

export function appendText(prompt: PromptInput, text: string) {
  const target = prompt.capture()
  const current = target.current()
  const last = current[current.length - 1]
  const prefix = last && "content" in last && last.content.trim() ? "\n\n" : ""
  const content = `${prefix}${text}`
  target.set([...current, { type: "text", content, start: 0, end: content.length }], target.cursor())
}

export function addImage(prompt: PromptInput, part: ImageAttachmentPart) {
  const target = prompt.capture()
  target.set([...target.current(), part], target.cursor())
}

export function imagePart(dataUrl: string): ImageAttachmentPart | undefined {
  if (!dataUrl.startsWith("data:image/png;base64,")) return
  return {
    type: "image",
    id: uuid(),
    filename: `browser-screenshot-${Date.now()}.png`,
    mime: "image/png",
    dataUrl,
  }
}

export function navigate(webview: WebviewElement | undefined, action: NavAction) {
  if (action === "back") return webview?.goBack?.()
  if (action === "forward") return webview?.goForward?.()
  if (action === "reload") return webview?.reload?.()
  if (action === "stop") return webview?.stop?.()
}

export async function captureScreenshot(webview: WebviewElement | undefined) {
  const dataUrl = await webview
    ?.capturePage?.()
    .then((image) => image.toDataURL())
    .catch(() => "")
  return imagePart(dataUrl ?? "")
}

export async function readSelectionText(webview: WebviewElement | undefined) {
  if (!webview?.executeJavaScript) return ""
  const selection = await webview
    .executeJavaScript<string>("window.getSelection()?.toString() ?? ''")
    .catch(() => "")
  return (selection ?? "").trim()
}

export async function pickElement(webview: WebviewElement | undefined) {
  if (!webview?.executeJavaScript) return
  return webview.executeJavaScript<BrowserElementSelection | undefined>(pickElementScript()).catch(() => undefined)
}

function pickElementScript() {
  return `(() => new Promise((resolve) => {
  const previous = window.__cookieMonsterCancelPickElement
  if (previous) previous()

  let hovered
  let previousOutline = ""
  const previousCursor = document.documentElement.style.cursor
  const compact = (value) => String(value || "").replace(/\\s+/g, " ").trim().slice(0, 2000)
  const describe = (el) => {
    if (!el) return undefined
    const ariaLabel = el.getAttribute("aria-label")
    const title = el.getAttribute("title")
    const label = ariaLabel || title || ""
    return {
      tag: el.tagName.toLowerCase(),
      text: compact(el.innerText || el.textContent || el.value || ""),
      role: compact(el.getAttribute("role") || ""),
      label: compact(label),
      id: compact(el.id || ""),
      className: compact(typeof el.className === "string" ? el.className : ""),
    }
  }
  const unhover = () => {
    if (!hovered) return
    if (hovered.style) hovered.style.outline = previousOutline
    hovered = undefined
    previousOutline = ""
  }
  const cleanup = () => {
    unhover()
    document.documentElement.style.cursor = previousCursor
    document.removeEventListener("mousemove", move, true)
    document.removeEventListener("click", click, true)
    document.removeEventListener("keydown", keydown, true)
    delete window.__cookieMonsterCancelPickElement
  }
  const move = (event) => {
    const next = document.elementFromPoint(event.clientX, event.clientY)
    if (!next || next === hovered) return
    unhover()
    hovered = next
    previousOutline = hovered.style?.outline || ""
    if (hovered.style) hovered.style.outline = "2px solid #0ea5e9"
  }
  const click = (event) => {
    event.preventDefault()
    event.stopPropagation()
    const picked = describe(document.elementFromPoint(event.clientX, event.clientY) || event.target)
    cleanup()
    resolve(picked)
  }
  const keydown = (event) => {
    if (event.key !== "Escape") return
    event.preventDefault()
    event.stopPropagation()
    cleanup()
    resolve(undefined)
  }
  window.__cookieMonsterCancelPickElement = () => {
    cleanup()
    resolve(undefined)
  }
  document.documentElement.style.cursor = "crosshair"
  document.addEventListener("mousemove", move, true)
  document.addEventListener("click", click, true)
  document.addEventListener("keydown", keydown, true)
}))()`
}
