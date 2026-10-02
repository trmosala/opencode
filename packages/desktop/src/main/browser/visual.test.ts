import { describe, expect, test } from "bun:test"
import { MAX_SCREENSHOT_BYTES } from "@cookiemonster/cm-browser/protocol"
import {
  boundedJpeg,
  newVisualRef,
  validCapturedJpeg,
  visualGuardScript,
  visualPoint,
  type VisualLease,
} from "./visual"

const lease: VisualLease = {
  visualRef: "opaque",
  tabID: "tab-one",
  url: "https://example.test/",
  documentToken: "document-one",
  layoutToken: "layout-one",
  dpr: 1,
  viewportWidth: 800,
  viewportHeight: 600,
  scrollX: 0,
  scrollY: 0,
  clipX: 0,
  clipY: 0,
  scaleX: 0.5,
  scaleY: 0.5,
  width: 400,
  height: 300,
  owner: "owner-one",
  captureScale: 1,
  sourceDigest: "digest",
  frameSignature: "frames",
  documentSignature: "documents",
}

describe("visual inspection", () => {
  test("visual references are opaque cryptographic UUIDs", () => {
    const first = newVisualRef()
    expect(first).toMatch(/^[a-f0-9-]{36}$/)
    expect(newVisualRef()).not.toBe(first)
  })

  test("JPEG reduction lowers quality before scaling and never goes below half-resolution", () => {
    const attempts: { width: number; height: number; quality: number }[] = []
    const result = boundedJpeg(
      Buffer.alloc(1),
      (_source, width, height, quality) => {
        attempts.push({ width, height, quality })
        return Buffer.alloc(width * height > 130_000 ? MAX_SCREENSHOT_BYTES + 1 : 20_000)
      },
      801,
      601,
    )
    expect(attempts.slice(0, 4).map((attempt) => attempt.quality)).toEqual([82, 72, 62, 52])
    expect(result).toMatchObject({ width: 401, height: 301 })
    expect(result!.scaleX).toBeGreaterThanOrEqual(0.5)
    expect(result!.scaleY).toBeGreaterThanOrEqual(0.5)
    expect(attempts.every((attempt) => attempt.width >= 400 && attempt.height >= 300)).toBe(true)
  })

  test("a viewport that cannot fit at the supported minimum returns no JPEG", () => {
    const result = boundedJpeg(Buffer.alloc(1), () => Buffer.alloc(MAX_SCREENSHOT_BYTES + 1), 800, 600)
    expect(result).toBeUndefined()
  })

  test("minimum resolution can be expressed against CSS viewport size at browser zoom", () => {
    const result = boundedJpeg(
      Buffer.alloc(1),
      (_source, width, height) => Buffer.alloc(width * height > 250_000 ? MAX_SCREENSHOT_BYTES + 1 : 20_000),
      800,
      600,
      0.7,
    )
    expect(result).toMatchObject({ width: 560, height: 420 })
    expect(result!.scaleX).toBeGreaterThanOrEqual(0.7)
  })

  test("image pixel coordinates map through actual scale and reject out-of-image points", () => {
    expect(visualPoint(lease, 100, 50)).toEqual({ x: 201, y: 101 })
    expect(visualPoint(lease, 400, 20)).toBeUndefined()
    expect(visualPoint(lease, Number.NaN, 20)).toBeUndefined()
  })

  test("capture bytes must be bounded canonical JPEG data, and guard samples movement", () => {
    expect(validCapturedJpeg("/9j/2Q==")).toEqual(Buffer.from([255, 216, 255, 217]))
    expect(validCapturedJpeg("bad!")).toBeUndefined()
    expect(visualGuardScript).toContain("MutationObserver")
    expect(visualGuardScript).toContain("ResizeObserver")
    expect(visualGuardScript).toContain("visualViewport?.addEventListener('scroll'")
    expect(visualGuardScript).toContain("getAnimations().filter")
    expect(visualGuardScript).toContain("requestAnimationFrame(() => requestAnimationFrame(resolve))")
  })
})
