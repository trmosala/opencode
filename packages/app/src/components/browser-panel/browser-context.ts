import type { BrowserSearchEngine } from "@/browser-panel"

export type BrowserPageContext = {
  title?: string
  url: string
}

export type BrowserElementSelection = {
  tag: string
  text?: string
  role?: string
  label?: string
  id?: string
  className?: string
}

export function normalizeBrowserUrl(input: string) {
  const trimmed = input.trim()
  if (!trimmed) return

  const scheme = trimmed.match(/^([a-zA-Z][a-zA-Z\d+.-]*):/)
  const hostPort = /^[\w.-]+:\d+(?:[/?#].*)?$/.test(trimmed)
  const withProtocol = !scheme || hostPort ? `http://${trimmed}` : trimmed

  try {
    const url = new URL(withProtocol)
    if ((url.protocol !== "http:" && url.protocol !== "https:") || url.username || url.password) return
    return url.toString()
  } catch {
    return
  }
}

const searchTemplates: Record<BrowserSearchEngine, { url: string; parameter: string }> = {
  duckduckgo: { url: "https://duck.com/", parameter: "q" },
  google: { url: "https://www.google.com/search", parameter: "q" },
  bing: { url: "https://www.bing.com/search", parameter: "q" },
}

export function browserSearchTemplate(value: unknown): { url: string; parameter: string } | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined
  if (
    !("url" in value) ||
    !("parameter" in value) ||
    typeof value.url !== "string" ||
    typeof value.parameter !== "string" ||
    !/^[a-z][a-z\d_]{0,31}$/i.test(value.parameter) ||
    !URL.canParse(value.url)
  )
    return undefined
  const url = new URL(value.url)
  if (url.protocol !== "https:" || url.username || url.password || url.hash || url.searchParams.has(value.parameter))
    return undefined
  return { url: url.toString(), parameter: value.parameter }
}

export function resolveBrowserAddress(input: string, engine: BrowserSearchEngine = "duckduckgo") {
  const value = input.trim()
  if (!value) return
  if (value === "about:blank") return value
  const hostPort = /^[\w.-]+:\d+(?:[/?#].*)?$/.test(value)
  if (/^[a-z][a-z\d+.-]*:/i.test(value) && !hostPort && !/^(site|filetype|intitle|inurl):/i.test(value))
    return normalizeBrowserUrl(value)
  const url = normalizeBrowserUrl(value)
  if (url && !/\s/.test(value)) {
    const parsed = new URL(url)
    if (parsed.hostname.includes(".") || parsed.hostname === "localhost" || parsed.hostname.startsWith("[") || hostPort)
      return url
  }
  const template = browserSearchTemplate(searchTemplates[engine]) ?? browserSearchTemplate(searchTemplates.duckduckgo)!
  const search = new URL(template.url)
  search.searchParams.set(template.parameter, value)
  return search.toString()
}

export function formatBrowserUrlContext(page: BrowserPageContext) {
  const title = page.title?.trim()
  if (!title) return `Browser URL:\n${page.url}`
  return `Browser URL:\n${title}\n${page.url}`
}

export function formatBrowserSelectionContext(page: BrowserPageContext, selection: string) {
  const text = selection.trim()
  if (!text) return

  const title = page.title?.trim()
  const header = title ? `Browser selection from ${title}` : "Browser selection"
  return `${header}:\n${page.url}\n\n${text}`
}

export function formatBrowserElementContext(page: BrowserPageContext, selection: BrowserElementSelection | undefined) {
  if (!selection) return

  const lines = [
    selection.label?.trim() ? `Label: ${selection.label.trim()}` : undefined,
    selection.role?.trim() ? `Role: ${selection.role.trim()}` : undefined,
    selection.tag.trim() ? `Element: ${selection.tag.trim()}` : undefined,
    selection.id?.trim() ? `ID: ${selection.id.trim()}` : undefined,
    selection.className?.trim() ? `Class: ${selection.className.trim()}` : undefined,
    selection.text?.trim() ? `Text:\n${selection.text.trim()}` : undefined,
  ].filter(Boolean)

  if (!lines.length) return
  const title = page.title?.trim()
  const header = title ? `Browser element from ${title}` : "Browser element"
  return `${header}:\n${page.url}\n\n${lines.join("\n")}`
}
