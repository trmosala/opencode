import { expect, test } from "bun:test"
import { stableMacDownload, updatePolicy } from "./migration"

test("selects the signed stable installer for the current Mac architecture", () => {
  const artifact = {
    version: "2.0.2",
    metadata: {
      files: {
        "opencode-desktop-mac-arm64.dmg": { url: "https://files.test/OpenCode-arm64.dmg" },
        "opencode-desktop-mac-x64.dmg": { url: "https://files.test/OpenCode-x64.dmg" },
      },
    },
  }

  expect(stableMacDownload(artifact, "arm64")).toEqual({
    version: "2.0.2",
    url: "https://files.test/OpenCode-arm64.dmg",
  })
  expect(stableMacDownload(artifact, "x64")).toEqual({
    version: "2.0.2",
    url: "https://files.test/OpenCode-x64.dmg",
  })
  expect(stableMacDownload(artifact, "ia32")).toBeUndefined()
  expect(stableMacDownload({ version: "2.0.2", metadata: { files: {} } }, "arm64")).toBeUndefined()
})

test.each([
  ["CookieMonster", "darwin", "prod", true, true, true],
  ["CookieMonster", "darwin", "prod", false, false, true],
  ["CookieMonster", "darwin", "dev", true, false, true],
  ["CookieMonster", "darwin", "beta", true, false, true],
  ["CookieMonster", "linux", "prod", true, true, true],
  ["CookieMonster", "win32", "prod", true, true, true],
  ["CookieMonster", "linux", "prod", false, false, true],
  ["CookieMonster", "win32", "prod", false, false, true],
  ["CookieMonster", "linux", "beta", true, false, true],
  ["CookieMonster", "win32", "dev", true, false, true],
  ["OpenCode", "darwin", "prod", true, true, false],
  ["OpenCode Beta", "darwin", "beta", true, true, false],
  ["OpenCode Dev", "linux", "dev", true, false, false],
] as const)("update policy: %s %s %s packaged=%s", (name, platform, channel, packaged, enabled, prerelease) => {
  expect(updatePolicy(name, platform, channel, packaged)).toEqual({ enabled, prerelease })
})
