import type { BrowserContact } from "@opencode-ai/app/browser-panel"
import { loginVisibility } from "./login-form"

// ponytail: explicit autocomplete only; add heuristics only for evidenced site failures.
const fields = `
  if (location.origin !== origin || !isSecureContext || top !== self) throw new Error("Unsafe contact document")
  ${loginVisibility}
  const matches = [...document.querySelectorAll('input[autocomplete], textarea[autocomplete], select[autocomplete]')]
    .filter(el => !el.matches(":disabled") && visible(el) && (el instanceof HTMLTextAreaElement || el instanceof HTMLSelectElement && !el.multiple ||
      el instanceof HTMLInputElement && ["text", "email", "tel"].includes(el.type)))
    .map(el => {
      const parts = el.autocomplete.trim().toLowerCase().split(/\\s+/)
      return { el, key: parts[parts.length - 1], section: parts.slice(0, -1).join(" "), form: el.form }
    }).filter(row => keys.includes(row.key))
  if (!matches.length || matches.length > 17 || new Set(matches.map(row => row.key)).size !== matches.length ||
      matches.some(row => row.form !== matches[0].form || row.section !== matches[0].section))
    throw new Error("Ambiguous contact fields")
  for (const { form } of matches) {
    if (!form) continue
    const actions = [form.action, ...[...form.elements].filter(el => el.hasAttribute("formaction")).map(el => el.formAction)]
    if (actions.some(action => { const url = new URL(action, location.href); return url.origin !== origin || url.username || url.password }) ||
        form.method !== "post" || [...form.elements].some(el => el.hasAttribute("formmethod") && el.formMethod !== "post"))
      throw new Error("Unsafe contact destination")
  }
`

export function prepareContactScript(origin: string, token: string, keys: string[]) {
  return `(() => {
    const origin = ${JSON.stringify(origin)}, keys = ${JSON.stringify(keys)}
    ${fields}
    document.__cmContactTicket = { token: ${JSON.stringify(token)}, matches: matches.map(row => ({
      ...row, type: row.el.type, autocomplete: row.el.autocomplete, value: row.el.value,
      action: row.form?.action, options: row.el instanceof HTMLSelectElement ? row.el.innerHTML : null
    })) }
    return matches.map(row => row.key)
  })()`
}

export function completeContactScript(
  origin: string,
  token: string,
  values: BrowserContact["values"],
  expires: number,
) {
  return `(() => {
    const ticket = document.__cmContactTicket
    delete document.__cmContactTicket
    if (Date.now() >= ${JSON.stringify(expires)} || !ticket || ticket.token !== ${JSON.stringify(token)})
      throw new Error("Contact delivery expired or document changed")
    const origin = ${JSON.stringify(origin)}, values = ${JSON.stringify(values)}, keys = Object.keys(values)
    ${fields}
    if (matches.length !== ticket.matches.length || matches.some((row, index) => {
      const old = ticket.matches[index]
      return row.el !== old.el || row.key !== old.key || row.form !== old.form || row.el.type !== old.type ||
        row.el.autocomplete !== old.autocomplete || row.el.value !== old.value || row.form?.action !== old.action ||
        (row.el instanceof HTMLSelectElement && row.el.innerHTML !== old.options)
    })) throw new Error("Contact form changed")
    const entries = matches.map(({ el, key }) => {
      const value = values[key]
      if (typeof value !== "string" || !value || el.maxLength >= 0 && value.length > el.maxLength ||
          el instanceof HTMLInputElement && /[\\r\\n]/.test(value))
        throw new Error("Contact value cannot fit")
      if (el instanceof HTMLSelectElement) {
        const options = [...el.options].filter(option => option.value === value && !option.disabled && !option.parentElement.disabled)
        if (options.length !== 1) throw new Error("No exact contact option")
      }
      return { el, value }
    })
    for (const { el, value } of entries) {
      const prototype = el instanceof HTMLSelectElement ? HTMLSelectElement.prototype :
        el instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype
      Object.getOwnPropertyDescriptor(prototype, "value").set.call(el, value)
    }
    for (const { el } of entries) {
      el.dispatchEvent(new Event("input", { bubbles: true }))
      el.dispatchEvent(new Event("change", { bubbles: true }))
    }
    return true
  })()`
}
