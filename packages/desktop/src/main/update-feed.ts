// CookieMonster releases live on the fork. Both packaging (app-update.yml) and the runtime updater use this
// feed, so a packaging-flag mistake can never point installed apps at upstream OpenCode releases.
export const CM_UPDATE_FEED = { provider: "github", owner: "trmosala", repo: "opencode", channel: "latest" } as const
