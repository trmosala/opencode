import { loginVisibility } from "./login-form"

// Installed in a dedicated isolated world; page scripts cannot access the binding or controller.
export function loginOfferScript(binding: string) {
  return `(() => {
    if (globalThis.__cmOffers) return
    const state = globalThis.__cmOffers = { until: 0, input: null }
    ${loginVisibility}
    let gesture = 0
    let gestureForm = null
    for (const name of ['click', 'keydown']) document.addEventListener(name, event => { if (event.isTrusted) { gesture = performance.now(); gestureForm = event.target.form || event.target.closest?.('form') } }, true)
    document.addEventListener('submit', event => {
      if (!event.isTrusted || performance.now() - gesture > 1500 || Date.now() >= state.until || !isSecureContext || top !== self) return
      const form = event.target
      if (!(form instanceof HTMLFormElement) || form !== gestureForm || form.method !== 'post' || new URL(form.action).origin !== location.origin) return
      if ([...form.elements].some(el => el.hasAttribute('formaction') && new URL(el.formAction).origin !== location.origin || el.hasAttribute('formmethod') && el.formMethod !== 'post')) return
      const passwords = [...form.querySelectorAll('input[type=password]')].filter(visible)
      if (passwords.length > 1 || passwords.some(el => el.autocomplete.split(/\\s+/).includes('new-password'))) return
      const inputs = [...form.querySelectorAll('input')].filter(el => ['text', 'email'].includes(el.type) && visible(el))
      const named = inputs.filter(el => el.autocomplete.split(/\\s+/).includes('username'))
      const users = named.length ? named : inputs.filter(el => el.type === 'email')
      const candidates = users.length ? users : inputs
      if (candidates.length > 1 || (!candidates.length && !passwords.length)) return
      const username = candidates[0]?.value || ''
      const password = passwords[0]?.value || ''
      if (username.length > 4096 || password.length > 16384 || (!username && !password)) return
      state.input = passwords[0] || null
      globalThis[${JSON.stringify(binding)}](JSON.stringify({ origin: location.origin, username, password }))
    }, true)
  })()`
}

export const loginOfferSucceeded = `(() => {
  const visible = el => el.getClientRects().length && getComputedStyle(el).visibility === 'visible' && getComputedStyle(el).display !== 'none'
  return document.readyState === 'complete' && !globalThis.__cmOffers?.input?.isConnected &&
    ![...document.querySelectorAll('input[type=password], [role=alert], [aria-invalid=true]')].some(visible)
})()`
