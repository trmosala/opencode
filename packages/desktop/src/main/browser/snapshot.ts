const MAX_ELEMENTS = 200
const MAX_ELEMENT_TEXT = 160
const MAX_VISIBLE_TEXT = 12_000

export type SnapshotElement = {
  readonly tag: string
  readonly role: string
  readonly label: string
  readonly text: string
  readonly fingerprint: string
  readonly rect: { readonly x: number; readonly y: number; readonly width: number; readonly height: number }
}

export type PageSnapshot = {
  readonly url: string
  readonly title: string
  readonly visibleText: string
  readonly elements: readonly SnapshotElement[]
}

const INTERACTIVE_SELECTOR = [
  "a[href]",
  "button:not([disabled])",
  "input:not([disabled]):not([type=hidden])",
  "select:not([disabled])",
  "textarea:not([disabled])",
  "summary",
  '[contenteditable="true"]',
  '[role="button"]',
  '[role="link"]',
  '[role="tab"]',
  '[role="menuitem"]',
  '[role="checkbox"]',
  '[role="radio"]',
  '[role="switch"]',
  '[role="option"]',
  '[role="textbox"]',
  '[tabindex]:not([tabindex="-1"])',
].join(",")

export const snapshotScript = () => `(() => {
  const compact = (value, limit = ${MAX_ELEMENT_TEXT}) => String(value == null ? "" : value).replace(/\\s+/g, " ").trim().slice(0, limit)
  const visible = (el, rect) => {
    if (rect.width <= 0 || rect.height <= 0 || rect.bottom < 0 || rect.right < 0) return false
    if (rect.top > (window.innerHeight || 0) || rect.left > (window.innerWidth || 0)) return false
    const style = window.getComputedStyle(el)
    return style.visibility !== "hidden" && style.display !== "none" && style.opacity !== "0"
  }
  const elements = []
  for (const el of document.querySelectorAll(${JSON.stringify(INTERACTIVE_SELECTOR)})) {
    if (elements.length >= ${MAX_ELEMENTS}) break
    const rect = el.getBoundingClientRect()
    if (!visible(el, rect)) continue
    const tag = el.tagName.toLowerCase()
    const role = compact(el.getAttribute("role") || "")
    const label = compact(el.getAttribute("aria-label") || el.getAttribute("title") || el.getAttribute("placeholder") || el.getAttribute("name") || "")
    const text = compact(el.innerText || el.textContent || el.value || "")
    elements.push({
      tag,
      role,
      label,
      text,
      fingerprint: [tag, el.getAttribute("type") || "", el.id || "", el.getAttribute("name") || "", role, label, text].join("\\u001f"),
      rect: { x: rect.x, y: rect.y, width: rect.width, height: rect.height },
    })
  }
  return {
    url: document.location.href,
    title: document.title,
    visibleText: compact(document.body?.innerText || "", ${MAX_VISIBLE_TEXT}),
    elements,
  }
})()`

const number = (value: unknown) => (typeof value === "number" && Number.isFinite(value) ? value : 0)
const text = (value: unknown) => (typeof value === "string" ? value : "")

function parseElement(value: unknown): SnapshotElement | undefined {
  if (!value || typeof value !== "object") return
  const input = value as Record<string, unknown>
  const rect = (input.rect && typeof input.rect === "object" ? input.rect : {}) as Record<string, unknown>
  return {
    tag: text(input.tag),
    role: text(input.role),
    label: text(input.label),
    text: text(input.text),
    fingerprint: text(input.fingerprint),
    rect: {
      x: number(rect.x),
      y: number(rect.y),
      width: number(rect.width),
      height: number(rect.height),
    },
  }
}

export function parseSnapshot(value: unknown): PageSnapshot | undefined {
  if (!value || typeof value !== "object" || !("result" in value)) return
  const inner = (value as { result?: unknown }).result
  if (!inner || typeof inner !== "object" || !("value" in inner)) return
  const payload = (inner as { value?: unknown }).value
  if (!payload || typeof payload !== "object") return
  const input = payload as Record<string, unknown>
  const elements = (Array.isArray(input.elements) ? input.elements : []).flatMap((entry) => {
    const element = parseElement(entry)
    return element ? [element] : []
  })
  return {
    url: text(input.url),
    title: text(input.title),
    visibleText: text(input.visibleText),
    elements,
  }
}
