import { expect, test } from "bun:test"
import { requireRendererStoreName, requireStoreName } from "./store-keys"

test("generic renderer storage cannot address private browser data or Windows aliases", () => {
  for (const name of [
    "cm-browser",
    "CM-BROWSER",
    "cm-browser.",
    "cm-browser...",
    "cm-browser-vault",
    "../cm-browser",
  ]) {
    expect(() => requireRendererStoreName(name)).toThrow()
  }
  expect(() => requireRendererStoreName("opencode.settings")).not.toThrow()
  expect(() => requireStoreName("cm-browser")).not.toThrow()
})
