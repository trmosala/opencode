import type { BrowserBounds } from "@/browser-panel"

export function browserViewportBounds(element: HTMLElement): BrowserBounds | null {
  const visible = (el: HTMLElement) => el.checkVisibility({ visibilityProperty: true, opacityProperty: true })
  if (!element.isConnected || document.visibilityState === "hidden" || !visible(element)) return null
  // Native views sit above renderer DOM. Hide rather than cover app overlays.
  const overlays = [
    '[role="dialog"]',
    '[role="alertdialog"]',
    '[aria-modal="true"]',
    '[data-component="dialog-overlay"]',
    '[data-component="popover-content"]',
    '[data-component="dropdown-menu-content"]',
    '[data-component="context-menu-content"]',
    '[data-component="select-content"]',
    '[data-component="tooltip"]',
  ].join(",")
  if ([...document.querySelectorAll<HTMLElement>(overlays)].some(visible)) return null
  const rect = element.getBoundingClientRect()
  if (
    rect.width < 1 ||
    rect.height < 1 ||
    rect.x < 0 ||
    rect.y < 0 ||
    rect.right > window.innerWidth + 1 ||
    rect.bottom > window.innerHeight + 1
  )
    return null
  const points = [
    [rect.x + 1, rect.y + 1],
    [rect.right - 1, rect.y + 1],
    [rect.x + 1, rect.bottom - 1],
    [rect.right - 1, rect.bottom - 1],
    [rect.x + rect.width / 2, rect.y + rect.height / 2],
  ]
  if (points.some(([x, y]) => !element.contains(document.elementFromPoint(x, y)))) return null
  return { x: rect.x, y: rect.y, width: rect.width, height: rect.height }
}
