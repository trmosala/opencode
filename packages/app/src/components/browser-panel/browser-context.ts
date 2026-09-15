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

export function resolveBrowserAddress(input: string) {
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
  const search = new URL("https://duck.com/")
  search.searchParams.set("q", value)
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
