import type { BrowserLogin } from "./import-data"

// HTMLFormControlsCollection omits image submitters, including external form-associated inputs.
export const loginFormElements = `[...form.elements, ...[...document.querySelectorAll('input[type=image]')].filter(el => el.form === form)]`

export const loginVisibility = `  const visible = (el) => {
    if (!el.isConnected || el.matches(':disabled') || el.readOnly || el.closest('[inert]')) return false
    const rect = el.getBoundingClientRect()
    if (rect.width <= 0 || rect.height <= 0 || rect.bottom <= 0 || rect.right <= 0 || rect.top >= innerHeight || rect.left >= innerWidth) return false
    for (let node = el; node; node = node.parentElement) {
      const style = getComputedStyle(node)
      if (style.visibility !== "visible" || style.display === "none" || Number(style.opacity) === 0) return false
    }
    const x = Math.max(0, rect.left) + (Math.min(innerWidth, rect.right) - Math.max(0, rect.left)) / 2
    const y = Math.max(0, rect.top) + (Math.min(innerHeight, rect.bottom) - Math.max(0, rect.top)) / 2
    return document.elementFromPoint(x, y) === el
  }`

// Fixed code runs only in an isolated world. The ticket lives on that world's document
// wrapper, so a new document (even at the same URL) cannot receive a pending credential.
const fields = `
  if (location.origin !== origin || !isSecureContext || top !== self) throw new Error("Unsafe login document")
  ${loginVisibility}
  const passwords = [...document.querySelectorAll('input[type="password"]')].filter(visible)
  if (field !== "username" && (passwords.length !== 1 || passwords[0].autocomplete.split(/\\s+/).includes("new-password"))) throw new Error("No unambiguous login form")
  const password = field === "username" ? undefined : passwords[0]
  const candidates = [...document.querySelectorAll('input')].filter(el => (!password || el.form === password.form) && ["text", "email"].includes(el.type) && visible(el))
  const named = candidates.filter(el => el.autocomplete.split(/\\s+/).includes("username"))
  const emails = candidates.filter(el => el.type === "email")
  const preceding = password ? candidates.filter(el => el.compareDocumentPosition(password) & Node.DOCUMENT_POSITION_FOLLOWING) : []
  const usernames = named.length ? named : emails.length ? emails : preceding
  if (field !== "password" && usernames.length !== 1) throw new Error("No unambiguous username field")
  const username = field === "password" ? undefined : usernames[0]
  const form = (password || username).form
  if (form) {
    const elements = ${loginFormElements}
    const actions = [form.action, ...elements.filter(el => el.hasAttribute("formaction")).map(el => el.formAction)]
    if (actions.some(action => new URL(action, location.href).origin !== origin)) throw new Error("Unsafe login destination")
    if (form.method !== "post" || elements.some(el => el.hasAttribute("formmethod") && el.formMethod !== "post")) throw new Error("Unsafe login method")
  }
`

export function prepareLoginScript(origin: string, token: string, field?: "username" | "password") {
  return `(() => {
    const origin = ${JSON.stringify(origin)}
    const field = ${JSON.stringify(field ?? "both")}
    ${fields}
    document.__cmLoginTicket = { token: ${JSON.stringify(token)}, username, password }
    return true
  })()`
}

export function completeLoginScript(
  origin: string,
  token: string,
  login?: BrowserLogin,
  expires = Date.now() + 5000,
  field?: "username" | "password",
) {
  return `(() => {
    if (Date.now() >= ${JSON.stringify(expires)}) throw new Error("Login delivery expired")
    const origin = ${JSON.stringify(origin)}
    const field = ${JSON.stringify(field ?? "both")}
    const ticket = document.__cmLoginTicket
    delete document.__cmLoginTicket
    if (!ticket || ticket.token !== ${JSON.stringify(token)}) throw new Error("Login document changed")
    ${fields}
    if (ticket.username !== username || ticket.password !== password) throw new Error("Login form changed")
    const fill = ${JSON.stringify(login ? { username: field === "password" ? undefined : login.username, password: field === "username" ? undefined : login.password } : null)}
    if (!fill) return { origin, username: username.value, password: password.value }
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value").set
    // Set both values before any page event handler can replace fields or change their types.
    if (username) setter.call(username, fill.username)
    if (password) setter.call(password, fill.password)
    for (const element of [username, password].filter(Boolean)) {
      element.dispatchEvent(new Event("input", { bubbles: true }))
      element.dispatchEvent(new Event("change", { bubbles: true }))
    }
    return true
  })()`
}
