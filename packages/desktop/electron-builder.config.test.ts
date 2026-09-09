import { expect, test } from "bun:test"
import type { Configuration } from "electron-builder"

const legacyDesktopEntry = "resources/linux/opencode-desktop.desktop"

const channels = [
  { channel: "dev", appId: "ai.opencode.desktop.dev" },
  { channel: "beta", appId: "ai.opencode.desktop.beta" },
  { channel: "prod", appId: "ai.opencode.desktop" },
] as const

for (const channel of channels) {
  test(`uses one Linux desktop identity for ${channel.channel}`, async () => {
    const previous = process.env.OPENCODE_CHANNEL
    process.env.OPENCODE_CHANNEL = channel.channel

    const module = await import(`./electron-builder.config.ts?channel=${channel.channel}`)
    const config = module.default as Configuration

    if (previous === undefined) delete process.env.OPENCODE_CHANNEL
    else process.env.OPENCODE_CHANNEL = previous

    expect(config.appId).toBe(channel.appId)
    expect(config.extraMetadata?.desktopName).toBe(`${channel.appId}.desktop`)
    expect(config.linux?.executableName).toBe(channel.appId)
    expect(config.linux?.desktop?.entry?.StartupWMClass).toBe(channel.appId)
    expect(config.deb?.fpm).toContainEqual(expect.stringContaining(`/usr/share/metainfo/${channel.appId}.metainfo.xml`))
    expect(config.rpm?.fpm).toContainEqual(expect.stringContaining(`/usr/share/metainfo/${channel.appId}.metainfo.xml`))
  })
}

test("keeps a hidden prod launcher for old Linux pins", async () => {
  const previous = process.env.OPENCODE_CHANNEL
  process.env.OPENCODE_CHANNEL = "prod"

  const module = await import("./electron-builder.config.ts?compat=prod")
  const config = module.default as Configuration

  if (previous === undefined) delete process.env.OPENCODE_CHANNEL
  else process.env.OPENCODE_CHANNEL = previous

  expect(
    config.deb?.fpm?.some((entry) =>
      entry.endsWith("opencode-desktop.desktop=/usr/share/applications/opencode-desktop.desktop"),
    ),
  ).toBe(true)
  expect(
    config.rpm?.fpm?.some((entry) =>
      entry.endsWith("opencode-desktop.desktop=/usr/share/applications/opencode-desktop.desktop"),
    ),
  ).toBe(true)

  const desktop = await Bun.file(legacyDesktopEntry).text()
  expect(desktop).toContain("Exec=/opt/OpenCode/ai.opencode.desktop %U")
  expect(desktop).toContain("Icon=ai.opencode.desktop")
  expect(desktop).toContain("StartupWMClass=ai.opencode.desktop")
  expect(desktop).toContain("NoDisplay=true")
})

test("copies runtime icons outside the app archive for windows and tray", async () => {
  const module = await import("./electron-builder.config.ts?runtime-icons")
  const config = module.default as Configuration

  expect(config.extraResources).toContainEqual({
    from: "resources/icons",
    to: "icons",
  })
})

test("bundles the CLI outside the dev app archive", async () => {
  const previous = process.env.OPENCODE_CHANNEL
  process.env.OPENCODE_CHANNEL = "dev"
  const module = await import("./electron-builder.config.ts?cli-resource")
  const config = module.default as Configuration
  if (previous === undefined) delete process.env.OPENCODE_CHANNEL
  else process.env.OPENCODE_CHANNEL = previous

  expect(config.files).toContain("!resources/opencode-cli*")
  expect(config.extraResources).toContainEqual({
    from: "resources/",
    to: "",
    filter: ["opencode-cli*"],
  })
})

test("CM_UNSIGNED strips every signing and notarization step", async () => {
  const previousChannel = process.env.OPENCODE_CHANNEL
  const previousUnsigned = process.env.CM_UNSIGNED
  process.env.OPENCODE_CHANNEL = "dev"
  process.env.CM_UNSIGNED = "1"

  const module = await import("./electron-builder.config.ts?unsigned")
  const config = module.default as Configuration

  if (previousChannel === undefined) delete process.env.OPENCODE_CHANNEL
  else process.env.OPENCODE_CHANNEL = previousChannel
  if (previousUnsigned === undefined) delete process.env.CM_UNSIGNED
  else process.env.CM_UNSIGNED = previousUnsigned

  expect(config.mac?.identity).toBeNull()
  expect(config.mac?.hardenedRuntime).toBe(false)
  expect(config.mac?.notarize).toBe(false)
  expect(config.dmg?.sign).toBe(false)
  expect(config.win?.signtoolOptions).toBeUndefined()
  // The installer formats the workflow uploads must survive the unsigned rewrite.
  expect(config.mac?.target).toContain("dmg")
  expect(config.win?.target).toContain("nsis")
})

test("keeps signing enabled by default", async () => {
  const previousChannel = process.env.OPENCODE_CHANNEL
  const previousUnsigned = process.env.CM_UNSIGNED
  process.env.OPENCODE_CHANNEL = "dev"
  delete process.env.CM_UNSIGNED

  const module = await import("./electron-builder.config.ts?signed")
  const config = module.default as Configuration

  if (previousChannel === undefined) delete process.env.OPENCODE_CHANNEL
  else process.env.OPENCODE_CHANNEL = previousChannel
  if (previousUnsigned !== undefined) process.env.CM_UNSIGNED = previousUnsigned

  expect(config.mac?.hardenedRuntime).toBe(true)
  expect(config.mac?.notarize).toBe(true)
  expect(config.dmg?.sign).toBe(true)
  expect(config.win?.signtoolOptions?.sign).toBeDefined()
})

for (const channel of ["beta", "prod"] as const) {
  test(`does not bundle the CLI in ${channel} builds`, async () => {
    const previous = process.env.OPENCODE_CHANNEL
    process.env.OPENCODE_CHANNEL = channel
    const module = await import(`./electron-builder.config.ts?no-cli-resource=${channel}`)
    const config = module.default as Configuration
    if (previous === undefined) delete process.env.OPENCODE_CHANNEL
    else process.env.OPENCODE_CHANNEL = previous

    expect(config.extraResources).not.toContainEqual({
      from: "resources/",
      to: "",
      filter: ["opencode-cli*"],
    })
  })
}
