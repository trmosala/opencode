import { expect, test } from "bun:test"
import {
  devicePresetRows,
  MAX_DEVICE_PRESETS,
  MAX_ZOOM_RULES,
  presentationOrigin,
  setDevicePreset,
  setZoomRule,
  zoomRuleRows,
} from "./presentation-preferences"

const phone = {
  id: "00000000-0000-4000-8000-000000000001",
  name: "Phone",
  size: { width: 390, height: 844 },
}

test("long native page URLs keep zoom preferences scoped to the exact origin", () => {
  const url = `https://example.test/?state=${"x".repeat(8192)}`
  expect(presentationOrigin(url)).toBe("https://example.test")
  expect(setZoomRule([], url, 1.25)).toEqual([{ origin: "https://example.test", factor: 1.25 }])
})

test("presentation origins match exact HTTP origins including ports", () => {
  expect(presentationOrigin("https://example.com/path?q=1")).toBe("https://example.com")
  expect(presentationOrigin("https://example.com:8443/path")).toBe("https://example.com:8443")
  expect(presentationOrigin("http://localhost:4096/path")).toBe("http://localhost:4096")
  for (const value of [undefined, null, "", "about:blank", "file:///tmp/x", "https://user:pass@example.com"])
    expect(presentationOrigin(value)).toBeUndefined()
})

test("zoom rules validate, replace exact origins, and reset at 100 percent", () => {
  const first = setZoomRule([], "https://example.com/page", 1.25)
  expect(first).toEqual([{ origin: "https://example.com", factor: 1.25 }])
  expect(setZoomRule(first, "https://example.com/other", 1.5)).toEqual([{ origin: "https://example.com", factor: 1.5 }])
  expect(setZoomRule(first, "https://example.com:8443", 0.8)).toEqual([
    { origin: "https://example.com:8443", factor: 0.8 },
    ...first,
  ])
  expect(setZoomRule(first, "https://example.com", 1)).toEqual([])
  for (const value of [null, {}, [{ origin: "https://example.com", factor: 4 }], [...first, ...first]])
    expect(() => zoomRuleRows(value)).toThrow("Invalid browser zoom preferences")
  expect(() => zoomRuleRows(Array(MAX_ZOOM_RULES + 1).fill(first[0]))).toThrow()
})

test("device presets validate names, sizes, uniqueness, updates, and limits", () => {
  expect(devicePresetRows([phone])).toEqual([phone])
  expect(
    setDevicePreset([phone], {
      id: phone.id,
      name: "Phone landscape",
      size: { width: 844, height: 390 },
    }),
  ).toEqual([
    {
      id: phone.id,
      name: "Phone landscape",
      size: { width: 844, height: 390 },
    },
  ])
  expect(setDevicePreset([], { name: "Tablet", size: { width: 1024, height: 768 } })[0]).toMatchObject({
    name: "Tablet",
    size: { width: 1024, height: 768 },
  })
  for (const value of [
    null,
    {},
    [{ ...phone, id: "bad" }],
    [{ ...phone, name: "" }],
    [{ ...phone, name: "bad\nname" }],
    [{ ...phone, size: { width: 159, height: 844 } }],
    [phone, { ...phone, id: "00000000-0000-4000-8000-000000000002" }],
  ])
    expect(() => devicePresetRows(value)).toThrow("Invalid browser device presets")
  expect(() => devicePresetRows(Array(MAX_DEVICE_PRESETS + 1).fill(phone))).toThrow()
})
