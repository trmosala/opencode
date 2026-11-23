import { app } from "electron"

type Channel = "dev" | "beta" | "prod"
const raw = import.meta.env.OPENCODE_CHANNEL
export const CHANNEL: Channel = raw === "dev" || raw === "beta" || raw === "prod" ? raw : "dev"

export function resolveAppIdentity(channel: Channel, branded: boolean, packaged: boolean) {
  if (!packaged) {
    return {
      name: "OpenCode Dev",
      appId: "ai.opencode.desktop.dev",
    }
  }
  if (branded) {
    return {
      name: "CookieMonster",
      appId: "com.ogilvy.cookiemonster",
    }
  }
  return {
    name: {
      dev: "OpenCode Dev",
      beta: "OpenCode Beta",
      prod: "OpenCode",
    }[channel],
    appId: {
      dev: "ai.opencode.desktop.dev",
      beta: "ai.opencode.desktop.beta",
      prod: "ai.opencode.desktop",
    }[channel],
  }
}

export const APP_IDENTITY = resolveAppIdentity(CHANNEL, import.meta.env.CM_BRAND, app.isPackaged)
// Only branded CookieMonster builds update, and only from the fork (see update-feed.ts). Unbranded builds would
// otherwise follow upstream OpenCode release feeds and replace CookieMonster with stock OpenCode.
export const UPDATER_ENABLED = app.isPackaged && CHANNEL !== "dev" && import.meta.env.CM_BRAND
