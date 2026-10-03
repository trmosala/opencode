import { expect, test } from "bun:test"
import { permissionValue, siteOrigin, sitePermissionRows } from "./site-permissions"

test("long native page URLs resolve site rules to their exact secure origin", () => {
  expect(siteOrigin(`https://example.test/?state=${"x".repeat(8192)}`)).toBe("https://example.test")
  expect(siteOrigin(`https://user:pass@example.test/?state=${"x".repeat(8192)}`)).toBeUndefined()
  expect(siteOrigin(`https://example.test/?state=${"x".repeat(65536)}`)).toBeUndefined()
})

test("site rules validate exact origins and preserve legacy media settings", () => {
  const legacy = { origin: "https://example.com:8443", camera: "allow", microphone: "ask" }
  expect(sitePermissionRows([legacy])).toEqual([
    { ...legacy, notifications: "block", displayCapture: "block", clipboard: "block" },
  ])
  expect(
    sitePermissionRows([{ ...legacy, notifications: "allow", displayCapture: "ask", clipboard: "allow" }])[0],
  ).toMatchObject({ notifications: "allow", displayCapture: "ask", clipboard: "allow" })
  for (const origin of ["http://localhost:4000", "http://127.0.0.1:4001", "http://[::1]:4002", "https://example.com"])
    expect(siteOrigin(origin)).toBe(origin)
  for (const value of [
    null,
    {},
    "",
    "null",
    "file:///x",
    "data:text/html,x",
    "http://example.com",
    "https://u:p@example.com",
  ])
    expect(siteOrigin(value)).toBeUndefined()
  expect(siteOrigin("https://example.com/path")).toBe("https://example.com")
  for (const value of [
    null,
    {},
    [null],
    [{ ...legacy, notifications: true }],
    [{ ...legacy, displayCapture: true }],
    [{ ...legacy, clipboard: true }],
    [{ ...legacy, camera: "yes" }],
    [{ ...legacy, origin: legacy.origin + "/" }],
    [legacy, legacy],
    Array(201).fill(legacy),
  ])
    expect(() => sitePermissionRows(value)).toThrow("Invalid site permissions")
  expect(permissionValue("ask")).toBe(true)
  for (const value of [undefined, null, true, {}, ["allow"], "ALLOW"]) expect(permissionValue(value)).toBe(false)
})
