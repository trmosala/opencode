import { loginVisibility, loginFormElements } from "./login-form"

// Installed in a dedicated isolated world; page scripts cannot access the binding or controller.
export function loginOfferScript(binding: string) {
  return `(() => {
    if (globalThis.__cmOffers) return
    const state = globalThis.__cmOffers = { until: 0, input: null }
    ${loginVisibility}
    let gesture = 0
    let gestureForm = null
    for (const name of ['click', 'keydown']) document.addEventListener(name, event => { if (event.isTrusted) { gesture = performance.now(); gestureForm = event.target.form || event.target.closest?.('form') } }, true)
    const capture = event => {
      if (performance.now() - gesture > 1500 || Date.now() >= state.until || !isSecureContext || top !== self) return
      const form = event.target
      if (!(form instanceof HTMLFormElement) || form !== gestureForm || form.method !== 'post' || new URL(form.action).origin !== location.origin) return
      const elements = ${loginFormElements}
      if (elements.some(el => el.hasAttribute('formaction') && new URL(el.formAction).origin !== location.origin || el.hasAttribute('formmethod') && el.formMethod !== 'post')) return
      const fields = elements.filter(el => el instanceof HTMLInputElement)
      const marked = (el, token) => el.autocomplete.split(/\\s+/).includes(token)
      const passwords = fields.filter(el => el.type === 'password' || marked(el, 'new-password') || marked(el, 'current-password'))
      // Revealed credential fields remain credentials, never username candidates.
      if (passwords.some(el => el.type !== 'password' || !visible(el))) return
      const next = passwords.filter(el => marked(el, 'new-password'))
      const current = passwords.filter(el => marked(el, 'current-password'))
      if (next.length) {
        if (next.length > 2 || current.length > 1 || passwords.some(el => marked(el, 'new-password') === marked(el, 'current-password'))) return
        if (!next[0].value || next.some(el => el.value !== next[0].value)) return
      } else if (passwords.length > 1) return
      const inputs = fields.filter(el => !passwords.includes(el) && ['text', 'email'].includes(el.type) && visible(el))
      const named = inputs.filter(el => marked(el, 'username'))
      const users = named.length ? named : inputs.filter(el => el.type === 'email')
      const candidates = users.length ? users : inputs
      if (candidates.length > 1 || (!candidates.length && !passwords.length)) return
      const username = candidates[0]?.value || ''
      const password = (next[0] || passwords[0])?.value || ''
      if (username.length > 4096 || password.length > 16384 || (!username && !password)) return
      state.input = passwords.length ? passwords : null
      return { origin: location.origin, username, password, newPassword: next.length > 0 }
    }
    document.addEventListener('invalid', event => {
      if (!event.isTrusted || !event.target.form || event.target.form !== gestureForm || performance.now() - gesture > 1500) return
      // Constraint validation can prevent submit entirely; revoke without reading field values.
      state.input = null
      globalThis[${JSON.stringify(binding)}]('null')
    }, true)
    document.addEventListener('submit', event => {
      if (!event.isTrusted) return
      // Every trusted resubmission replaces the previous attempt, including invalid forms.
      state.input = null
      let value
      try { value = capture(event) } catch {}
      globalThis[${JSON.stringify(binding)}](JSON.stringify(value || null))
    }, true)
  })()`
}

export const loginOfferSucceeded = `(() => {
  const visible = el => el.getClientRects().length && getComputedStyle(el).visibility === 'visible' && getComputedStyle(el).display !== 'none'
  return document.readyState === 'complete' && !globalThis.__cmOffers?.input?.some(el => el.isConnected) &&
    ![...document.querySelectorAll('input[type=password], [role=alert], [aria-invalid=true]')].some(visible)
})()`
