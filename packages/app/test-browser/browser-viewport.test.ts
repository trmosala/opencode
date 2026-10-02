import { expect, test } from "bun:test"
import { browserViewportBounds } from "../src/components/browser-panel/browser-viewport"

test("native browser bounds ignore disjoint overlays and yield to overlapping or modal overlays", () => {
  const viewport = document.createElement("div")
  document.body.append(viewport)
  const bounds = new WeakMap<HTMLElement, DOMRect>()
  const visibility = HTMLElement.prototype.checkVisibility
  const rect = HTMLElement.prototype.getBoundingClientRect
  const point = document.elementFromPoint
  HTMLElement.prototype.checkVisibility = function () {
    return this.isConnected
  }
  HTMLElement.prototype.getBoundingClientRect = function () {
    return bounds.get(this) ?? new DOMRect()
  }
  document.elementFromPoint = () => viewport
  bounds.set(viewport, new DOMRect(100, 100, 300, 200))

  const overlay = document.createElement("div")
  overlay.setAttribute("role", "tooltip")
  document.body.append(overlay)
  try {
    const measure = () => browserViewportBounds(viewport)
    expect(measure()).toEqual({ x: 100, y: 100, width: 300, height: 200 })

    bounds.set(overlay, new DOMRect(500, 400, 100, 40))
    expect(measure()).toEqual({ x: 100, y: 100, width: 300, height: 200 })
    bounds.set(overlay, new DOMRect(200, 120, 100, 40))
    expect(measure()).toBeNull()

    overlay.setAttribute("role", "menu")
    bounds.set(overlay, new DOMRect(500, 400, 100, 40))
    expect(measure()).toEqual({ x: 100, y: 100, width: 300, height: 200 })
    bounds.set(overlay, new DOMRect(200, 120, 100, 40))
    expect(measure()).toBeNull()

    overlay.setAttribute("role", "dialog")
    overlay.setAttribute("aria-modal", "true")
    bounds.set(overlay, new DOMRect(700, 500, 100, 80))
    expect(measure()).toBeNull()

    overlay.removeAttribute("aria-modal")
    overlay.setAttribute("data-component", "dialog-overlay")
    bounds.set(overlay, new DOMRect(0, 0, 800, 600))
    expect(measure()).toBeNull()
  } finally {
    viewport.remove()
    overlay.remove()
    HTMLElement.prototype.checkVisibility = visibility
    HTMLElement.prototype.getBoundingClientRect = rect
    document.elementFromPoint = point
  }
})
