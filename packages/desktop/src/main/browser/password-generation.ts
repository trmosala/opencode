import { randomInt } from "node:crypto"
import { loginVisibility, loginFormElements } from "./login-form"

export function passwordOptions(value: { length?: unknown; symbols?: unknown }, min = 16, max = 64) {
  const length = value.length === undefined ? 20 : value.length
  const symbols = value.symbols === undefined ? true : value.symbols
  if (
    !Number.isInteger(length) ||
    typeof length !== "number" ||
    length < 16 ||
    length > 64 ||
    typeof symbols !== "boolean" ||
    !Number.isInteger(min) ||
    !Number.isInteger(max) ||
    min < 16 ||
    max > 64 ||
    length < min ||
    length > max
  )
    throw new Error("Unsupported password settings or constraints")
  return { length, symbols }
}

export function generatePassword(settings: { length?: unknown; symbols?: unknown }) {
  const options = passwordOptions(settings)
  const groups = ["abcdefghijklmnopqrstuvwxyz", "ABCDEFGHIJKLMNOPQRSTUVWXYZ", "0123456789"]
  if (options.symbols) groups.push("!@#$%^&*()-_=+[]{}:,.?")
  const alphabet = groups.join("")
  // Whole-string rejection preserves uniform sampling among strings containing every selected class.
  for (let attempt = 0; attempt < 128; attempt++) {
    const password = Array.from({ length: options.length }, () => alphabet[randomInt(alphabet.length)]).join("")
    if (groups.every((group) => [...password].some((character) => group.includes(character)))) return password
  }
  throw new Error("Password generation failed")
}

const generationFields = `
  if (location.origin !== origin || !isSecureContext || top !== self) throw new Error("Unsafe document")
  ${loginVisibility}
  const marked = (el, role) => el.autocomplete.split(/\\s+/).includes(role)
  const credentials = [...document.querySelectorAll('input')].filter(el =>
    el.type === 'password' || marked(el, 'new-password') || marked(el, 'current-password'))
  const next = credentials.filter(el => marked(el, 'new-password'))
  const current = credentials.filter(el => marked(el, 'current-password'))
  if (!next.length || next.length > 2 || current.length > 1 ||
      credentials.some(el => el.type !== 'password' || !visible(el) ||
        marked(el, 'new-password') === marked(el, 'current-password'))) throw new Error("Ambiguous credentials")
  const form = next[0].form
  if (!form || credentials.some(el => el.form !== form) || form.method !== 'post' ||
      new URL(form.action).origin !== origin) throw new Error("Unsafe form")
  const elements = ${loginFormElements}
  if (elements.some(el => el.hasAttribute('formaction') && new URL(el.formAction).origin !== origin ||
      el.hasAttribute('formmethod') && el.formMethod !== 'post')) throw new Error("Unsafe destination")
  const inputs = elements.filter(el => el instanceof HTMLInputElement && !credentials.includes(el) &&
    ['text', 'email'].includes(el.type) && visible(el))
  const named = inputs.filter(el => marked(el, 'username'))
  const emails = inputs.filter(el => el.type === 'email')
  const users = named.length ? named : emails.length ? emails : inputs
  if (users.length > 1 || (users[0]?.value.length || 0) > 4096 ||
      next.some(el => el.value !== next[0].value)) throw new Error("Ambiguous form")
  let min = 16
  let max = 64
  for (const el of next) {
    // ponytail: no site regex evaluation; pattern/custom validation needs a future explicit policy.
    if (el.hasAttribute('pattern') || el.validity.customError) throw new Error("Unsupported constraints")
    for (const name of ['minlength', 'maxlength']) {
      const value = el.getAttribute(name)
      if (value !== null && !/^\\d{1,7}$/.test(value)) throw new Error("Invalid length constraint")
    }
    min = Math.max(min, el.minLength)
    if (el.maxLength >= 0) max = Math.min(max, el.maxLength)
  }
  if (min > max) throw new Error("Incompatible constraints")
  const snapshot = JSON.stringify([
    form.action, form.method, form.getAttribute('action'), form.getAttribute('method'),
    elements.map(el => [
      el.type, el.getAttribute('autocomplete'), el.getAttribute('minlength'), el.getAttribute('maxlength'),
      el.getAttribute('pattern'), el.getAttribute('formaction'), el.getAttribute('formmethod'),
      el.hasAttribute('formaction') ? el.formAction : form.action,
      el.hasAttribute('formmethod') ? el.formMethod : form.method,
      el.getAttribute('form'), el.matches(':disabled'), el.readOnly, el.required, el.validity?.customError,
      el instanceof HTMLInputElement ? el.value : null
    ])
  ])
`

export function prepareGenerationScript(origin: string, token: string, expires: number) {
  return `(() => {
    const origin = ${JSON.stringify(origin)}
    const expires = ${JSON.stringify(expires)}
    if (Date.now() >= expires) throw new Error("Generation expired")
    ${generationFields}
    const ticket = { token: ${JSON.stringify(token)}, expires, form, elements, users, snapshot }
    document.__cmLoginTicket = ticket
    ticket.timer = setTimeout(() => { if (document.__cmLoginTicket === ticket) delete document.__cmLoginTicket }, Math.max(0, expires - Date.now()))
    return { min, max, hasUsername: !!users[0]?.value }
  })()`
}

export function completeGenerationScript(origin: string, token: string, password: string, expires: number) {
  return `(() => {
    const ticket = document.__cmLoginTicket
    clearTimeout(ticket?.timer)
    delete document.__cmLoginTicket
    if (!ticket || ticket.token !== ${JSON.stringify(token)} ||
        Date.now() >= Math.min(ticket.expires, ${JSON.stringify(expires)})) throw new Error("Generation expired")
    const origin = ${JSON.stringify(origin)}
    ${generationFields}
    if (ticket.form !== form || ticket.snapshot !== snapshot || ticket.elements.length !== elements.length ||
        ticket.users.length !== users.length || ticket.users.some((el, i) => el !== users[i]) ||
        ticket.elements.some((el, i) => el !== elements[i])) throw new Error("Form changed")
    const password = ${JSON.stringify(password)}
    if (password.length < min || password.length > max) throw new Error("Constraints changed")
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set
    // All checks and both writes precede page handlers. Never touch current-password or submit.
    for (const el of next) setter.call(el, password)
    for (const el of next) {
      el.dispatchEvent(new Event('input', { bubbles: true }))
      el.dispatchEvent(new Event('change', { bubbles: true }))
    }
    return true
  })()`
}

export function clearGenerationScript(token: string) {
  return `if (document.__cmLoginTicket?.token === ${JSON.stringify(token)}) { clearTimeout(document.__cmLoginTicket.timer); delete document.__cmLoginTicket }; true`
}
