import type { BrowserTransferRule } from "@opencode-ai/app/browser-panel"

export function transferOrigin(value: string) {
  if (!URL.canParse(value)) throw new Error("Invalid transfer origin")
  const url = new URL(value)
  if (!["http:", "https:"].includes(url.protocol) || url.username || url.password)
    throw new Error("Invalid transfer origin")
  return url.origin
}

export function validateTransferRule(value: unknown): BrowserTransferRule {
  if (
    !value ||
    typeof value !== "object" ||
    !("origin" in value) ||
    typeof value.origin !== "string" ||
    !("uploads" in value) ||
    (value.uploads !== "ask" && value.uploads !== "block") ||
    !("downloads" in value) ||
    (value.downloads !== "ask" && value.downloads !== "block" && value.downloads !== "allow")
  )
    throw new Error("Invalid transfer permission")
  return {
    origin: value.origin === "*" ? "*" : transferOrigin(value.origin),
    uploads: value.uploads,
    downloads: value.downloads,
  }
}

export function transferRule(rows: BrowserTransferRule[], url: string): BrowserTransferRule {
  if (!URL.canParse(url) || !["http:", "https:"].includes(new URL(url).protocol))
    return { origin: "*", uploads: "block", downloads: "block" }
  return (
    rows.find((row) => row.origin === new URL(url).origin) ??
    rows.find((row) => row.origin === "*") ?? { origin: "*", uploads: "ask", downloads: "ask" }
  )
}
