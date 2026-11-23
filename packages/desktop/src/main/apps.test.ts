import { afterEach, expect, test } from "bun:test"
import { join } from "node:path"
import { checkAppExists, launchableApp, openWithApps, resolveAppPath } from "./apps"

const platform = Object.getOwnPropertyDescriptor(process, "platform")!

afterEach(() => {
  Object.defineProperty(process, "platform", platform)
})

test("main's open-with allowlist matches the renderer's per-platform lists", async () => {
  const source = await Bun.file(join(import.meta.dir, "../../../app/src/components/session/open-in-app.tsx")).text()
  const list = (name: string) => {
    const start = source.indexOf(`export const ${name}`)
    const body = source.slice(start, source.indexOf("] as const", start))
    return [...body.matchAll(/openWith: "([^"]+)"/g)].map((match) => match[1])
  }
  expect(openWithApps("darwin")).toEqual(list("MAC_OPEN_APPS"))
  expect(openWithApps("win32")).toEqual(list("WINDOWS_OPEN_APPS"))
  expect(openWithApps("linux")).toEqual(list("LINUX_OPEN_APPS"))
  expect(openWithApps("freebsd")).toEqual([])
})

test("only allowlisted names are checked, resolved or launchable", async () => {
  Object.defineProperty(process, "platform", { value: "linux" })
  for (const app of ["code", "zed"]) {
    expect(await checkAppExists(app)).toBe(true)
    expect(await resolveAppPath(app)).toBe(app)
    expect(launchableApp(app)).toBe(true)
  }
  for (const app of ["sh", "node", "/tmp/evil", "python3", "", undefined, ["code"]]) {
    expect(await checkAppExists(app as string)).toBe(false)
    expect(await resolveAppPath(app as string)).toBeNull()
    expect(launchableApp(app)).toBe(false)
  }
})

test("Windows launches only a path main resolved itself, never a renderer-supplied path", async () => {
  Object.defineProperty(process, "platform", { value: "win32" })
  expect(launchableApp("code")).toBe(false)
  expect(launchableApp("C:\\Windows\\System32\\cmd.exe")).toBe(false)
  expect(await resolveAppPath("cmd")).toBeNull()
})
