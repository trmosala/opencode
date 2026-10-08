import { loginVisibility } from "../browser/login-form"
import type { BrowserLogin } from "../browser/import-data"

export const WPP_OKTA_ORIGIN = "https://wpp.okta.com"

// The live WPP widget omits method/action and submits through its own JavaScript.
// This exception is deliberately separate from the browser's generic POST-only filler.
const fields = `
  if (location.origin !== ${JSON.stringify(WPP_OKTA_ORIGIN)} || !isSecureContext || top !== self) throw new Error("Unsafe Okta document")
  ${loginVisibility}
  const root = document.getElementById('okta-sign-in')
  if (!root) throw new Error("Missing Okta widget")
  const credentials = [...document.querySelectorAll('input')].filter(el =>
    el.type === 'password' || el.autocomplete.split(/\\s+/).some(role => ['username', 'current-password', 'new-password'].includes(role)))
  const shown = credentials.filter(visible)
  if (shown.length !== 1) throw new Error("Ambiguous Okta step")
  const input = shown[0]
  const field = input.id === 'identifier' && input.name === 'identifier' && input.type === 'text' && input.autocomplete === 'username'
    ? 'username'
    : input.id === 'credentials.passcode' && input.name === 'credentials.passcode' && input.type === 'password' && input.autocomplete === 'current-password'
      ? 'password' : undefined
  const form = input.form
  if (!field || !root.contains(input) || !form || !root.contains(form) ||
      form.hasAttribute('method') || form.hasAttribute('action') ||
      [...form.elements].some(el => el.hasAttribute('formaction') || el.hasAttribute('formmethod'))) throw new Error("Unsupported Okta form")
  const account = field === 'password' ? document.getElementById('username') : undefined
  if (field === 'password' && (!(account instanceof HTMLInputElement) || account.type !== 'text' ||
      account.name !== 'username' || account.form !== form || visible(account))) throw new Error("Missing Okta account")
`

export const inspectOktaPasswordScript = `(() => {
  try {
    ${fields}
    return field === 'password' && !input.value ? account.value.trim().toLowerCase() : undefined
  } catch { return undefined }
})()`

export function prepareOktaLoginScript(token: string, automatic = false) {
  return `(() => {
    ${fields}
    if (${JSON.stringify(automatic)} && (field !== 'password' || input.value)) return undefined
    document.__cmOktaTicket?.observer.disconnect()
    const ticket = { token: ${JSON.stringify(token)}, input, form, account, field, changed: false }
    ticket.observer = new MutationObserver(() => { ticket.changed = true })
    ticket.observer.observe(document, { childList: true })
    document.__cmOktaTicket = ticket
    return ${JSON.stringify(automatic)} ? account.value.trim().toLowerCase() : field
  })()`
}

export function completeOktaLoginScript(
  token: string,
  login: BrowserLogin,
  selected: "username" | "password",
  expires: number,
  automatic = false,
) {
  if (login.origin !== WPP_OKTA_ORIGIN) throw new Error("Okta credential origin mismatch")
  return `(() => {
    if (Date.now() >= ${JSON.stringify(expires)}) throw new Error("Okta delivery expired")
    const ticket = document.__cmOktaTicket
    delete document.__cmOktaTicket
    const changed = ticket?.changed || !!ticket?.observer.takeRecords().length
    ticket?.observer.disconnect()
    ${fields}
    if (!ticket || ticket.token !== ${JSON.stringify(token)} || changed || ticket.input !== input ||
        ticket.form !== form || ticket.account !== account || ticket.field !== field || field !== ${JSON.stringify(selected)}) throw new Error("Okta step changed")
    if (account && account.value.trim().toLowerCase() !== ${JSON.stringify(login.username.trim().toLowerCase())}) throw new Error("Okta account mismatch")
    if (${JSON.stringify(automatic)} && (field !== 'password' || input.value)) throw new Error("Okta password already entered")
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(input, ${JSON.stringify(selected === "username" ? login.username : login.password)})
    input.dispatchEvent(new Event('input', { bubbles: true }))
    input.dispatchEvent(new Event('change', { bubbles: true }))
    return true
  })()`
}

export function clearOktaLoginScript(token: string) {
  return `if (document.__cmOktaTicket?.token === ${JSON.stringify(token)}) { document.__cmOktaTicket.observer.disconnect(); delete document.__cmOktaTicket } true`
}
