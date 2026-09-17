import { expect, test } from "bun:test"
import { browserDeviceSize, BROWSER_DEVICE_DEFAULT } from "../../../../app/src/browser-panel"
import { deviceEmulation } from "./device-preview"

test("device size rejects malformed, non-finite, fractional and out-of-bounds IPC values", () => {
  for (const value of [undefined, null, true, [], "390x844", {}, { width: 390 }])
    expect(browserDeviceSize(value)).toBeUndefined()
  for (const value of [NaN, Infinity, -Infinity, -1, 0, 159, 4097, 390.5, "390", null, undefined, true]) {
    expect(browserDeviceSize({ width: value, height: 844 })).toBeUndefined()
    expect(browserDeviceSize({ width: 390, height: value })).toBeUndefined()
  }
  expect(browserDeviceSize({ width: 160, height: 4096 })).toEqual({ width: 160, height: 4096 })
  expect(browserDeviceSize({ width: 4096, height: 160 })).toEqual({ width: 4096, height: 160 })
  expect(browserDeviceSize({ width: 390, height: 844, userAgent: "fake", touch: true })).toEqual(BROWSER_DEVICE_DEFAULT)
})

test("device emulation fits both orientations without changing dimensions or pixel ratio", () => {
  expect(deviceEmulation(BROWSER_DEVICE_DEFAULT, 1000, 1000)).toEqual({
    screenPosition: "mobile",
    screenSize: { width: 390, height: 844 },
    viewPosition: { x: 0, y: 0 },
    deviceScaleFactor: 1,
    viewSize: { width: 390, height: 844 },
    scale: 1,
  })
  for (const size of [
    { width: 360, height: 800 },
    { width: 800, height: 360 },
  ]) {
    const small = deviceEmulation(size, 200, 300)
    expect(small.scale).toBe(Math.min(200 / size.width, 300 / size.height))
    expect(small.viewSize).toEqual(size)
    expect(small.screenSize).toEqual(size)
    expect(small.deviceScaleFactor).toBe(1)
    const large = deviceEmulation(size, 1600, 1600)
    expect(large.scale).toBe(1)
    expect(large.viewSize).toEqual(size)
    expect(size).toEqual(small.viewSize)
  }
})
