import type { BrowserPreferences } from "@opencode-ai/app/browser-panel"
import { browserURL } from "./policy"

export function linkDestination(url: string, preferences: Pick<BrowserPreferences, "webLinks" | "localLinks">) {
  if (!browserURL(url) || url === "about:blank") return "external"
  const host = new URL(url).hostname.toLowerCase()
  const local =
    host === "localhost" || host.endsWith(".localhost") || host === "[::1]" || /^127\.\d+\.\d+\.\d+$/.test(host)
  return local ? preferences.localLinks : preferences.webLinks
}
