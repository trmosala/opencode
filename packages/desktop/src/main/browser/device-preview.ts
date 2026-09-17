import type { BrowserDeviceSize } from "@opencode-ai/app/browser-panel"

export function deviceEmulation(size: BrowserDeviceSize, width: number, height: number) {
  return {
    screenPosition: "mobile" as const,
    screenSize: { ...size },
    viewPosition: { x: 0, y: 0 },
    deviceScaleFactor: 1,
    viewSize: { ...size },
    // Fit changes presentation scale, not CSS dimensions, page zoom or device pixel ratio.
    scale: Math.min(1, width / size.width, height / size.height),
  }
}
