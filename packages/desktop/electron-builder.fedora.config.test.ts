import { expect, test } from "bun:test"

import config from "./electron-builder.fedora.config"

test("builds an installable CookieMonster RPM", async () => {
  expect(config.appId).toBe("com.ogilvy.cookiemonster")
  expect(config.productName).toBe("CookieMonster")
  expect(config.artifactName).toBe("cookiemonster-${os}-${arch}.${ext}")
  expect(config.extraMetadata?.desktopName).toBe("com.ogilvy.cookiemonster.desktop")
  expect(config.linux?.executableName).toBe("com.ogilvy.cookiemonster")
  expect(config.linux?.desktop?.entry?.StartupWMClass).toBe("com.ogilvy.cookiemonster")
  expect(config.linux?.target).toEqual(["rpm"])
  expect(config.rpm?.packageName).toBe("cookiemonster")
  expect(config.rpm?.fpm).toContainEqual(
    expect.stringContaining("/usr/share/metainfo/com.ogilvy.cookiemonster.metainfo.xml"),
  )
  expect(await Bun.file("resources/linux/com.ogilvy.cookiemonster.metainfo.xml").exists()).toBe(true)
})
