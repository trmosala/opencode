import { expect, test } from "bun:test"
import { linkDestination } from "./link-destination"

test("link defaults distinguish loopback from lookalike remote hosts", () => {
  const preferences = { webLinks: "external", localLinks: "browser" } as const
  for (const url of ["http://localhost:3000", "http://127.0.0.2:99", "http://[::1]", "http://app.localhost"])
    expect(linkDestination(url, preferences)).toBe("browser")
  for (const url of [
    "https://localhost.example.com",
    "https://127.example.com",
    "https://example.com",
    "mailto:user@example.com",
  ])
    expect(linkDestination(url, preferences)).toBe("external")
  expect(linkDestination("http://localhost", { webLinks: "browser", localLinks: "external" })).toBe("external")
})

test("long native links retain the configured internal destination", () => {
  const preferences = { webLinks: "browser", localLinks: "browser" } as const
  expect(linkDestination(`https://example.test/?state=${"x".repeat(8192)}`, preferences)).toBe("browser")
  expect(linkDestination(`http://localhost/?state=${"x".repeat(8192)}`, preferences)).toBe("browser")
  expect(linkDestination(`https://example.test/?state=${"x".repeat(65536)}`, preferences)).toBe("external")
})
