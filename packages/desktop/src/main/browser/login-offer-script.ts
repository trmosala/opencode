import { loginVisibility, loginFormElements } from "./login-form"

// Installed in a dedicated isolated world; page scripts cannot access the binding or controller.
export function loginOfferScript(binding: string) {
  return `(() => {
    if (globalThis.__cmOffers) return
    const state = globalThis.__cmOffers = { until: 0, input: null, attempt: 0 }
    ${loginVisibility}
    let gesture = 0
    let gestureForm = null
    for (const name of ['click', 'keydown']) document.addEventListener(name, event => {
      if (!event.isTrusted) return
      gesture = performance.now()
      gestureForm = event.target.form || event.target.closest?.('form')
      state.formless = null
      if (gestureForm || event.type !== 'keydown' || event.key !== 'Enter' || event.repeat ||
          event.isComposing || event.ctrlKey || event.altKey || event.metaKey || event.shiftKey ||
          Date.now() >= state.until || !isSecureContext || top !== self) return
      const fields = [...document.querySelectorAll('input')].filter(el =>
        ['text', 'email', 'password'].includes(el.type) || /(?:^|\\s)(?:current-password|new-password|username)(?:\\s|$)/.test(el.autocomplete))
      if (!fields.includes(event.target) || !fields.length || fields.length > 2 ||
          fields.some(el => el.form || !visible(el) ||
            !(el.type === 'password' ? el.autocomplete === 'current-password' :
              ['text', 'email'].includes(el.type) && el.autocomplete === 'username')) ||
          new Set(fields.map(el => el.autocomplete)).size !== fields.length) return
      const pending = fields.map(el => ({ el, type: el.type, role: el.autocomplete }))
      state.formless = pending
      // One event turn, references only. No capture until Chromium emits a trusted native submission.
      setTimeout(() => { if (state.formless === pending) state.formless = null }, 0)
    }, true)
    const capture = event => {
      if (performance.now() - gesture > 1500 || Date.now() >= state.until || !isSecureContext || top !== self) return
      const form = event.target
      if (!(form instanceof HTMLFormElement) || form.method !== 'post' || new URL(form.action).origin !== location.origin) return
      const elements = ${loginFormElements}
      if (elements.some(el => el.hasAttribute('formaction') && new URL(el.formAction).origin !== location.origin || el.hasAttribute('formmethod') && el.formMethod !== 'post')) return
      const fields = elements.filter(el => el instanceof HTMLInputElement)
      if (form !== gestureForm && (!state.formless || fields.length !== state.formless.length ||
          state.formless.some(({ el, type, role }) => !fields.includes(el) || el.form !== form ||
            el.type !== type || el.autocomplete !== role || !visible(el)))) return
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
      state.login = password && !next.length ? {
        form, action: form.action, user: candidates[0], username, role: passwords[0].autocomplete,
        elements, destinations: elements.map(el => [
          el.hasAttribute('formaction') ? el.formAction : form.action,
          el.hasAttribute('formmethod') ? el.formMethod : form.method
        ])
      } : null
      return { origin: location.origin, username, password, newPassword: next.length > 0, attempt: ++state.attempt }
    }
    document.addEventListener('input', event => {
      if (!event.isTrusted || !state.login ||
          (event.target !== state.login.user && !state.input?.includes(event.target))) return
      state.input = null
      state.login = null
      globalThis[${JSON.stringify(binding)}]('null')
    }, true)
    document.addEventListener('invalid', event => {
      if (!event.isTrusted || !event.target.form || performance.now() - gesture > 1500 ||
          (event.target.form !== gestureForm && !state.formless?.some(({ el }) => el.form === event.target.form))) return
      state.formless = null
      // Constraint validation can prevent submit entirely; revoke without reading field values.
      state.input = null
      state.login = null
      globalThis[${JSON.stringify(binding)}]('null')
    }, true)
    document.addEventListener('submit', event => {
      if (!event.isTrusted) return
      // Every trusted resubmission replaces the previous attempt, including invalid forms.
      state.input = null
      state.login = null
      let value
      try { value = capture(event) } catch {}
      state.formless = null
      globalThis[${JSON.stringify(binding)}](JSON.stringify(value || null))
    }, true)
  })()`
}

export const loginOfferSucceeded = `(() => {
  const shown = el => el.getClientRects().length && getComputedStyle(el).visibility === 'visible' && getComputedStyle(el).display !== 'none'
  if (document.readyState !== 'complete') return false
  if ([...document.querySelectorAll('[role=alert], [aria-invalid=true]')].some(shown)) return null
  const state = globalThis.__cmOffers
  const credentials = [...document.querySelectorAll('input[type=password], input[autocomplete~=current-password], input[autocomplete~=new-password]')]
  if (!state?.input?.some(el => el.isConnected) && !credentials.some(shown)) return true
  if (!state?.login) return false
  ${loginVisibility}
  const { form, action, user, username, role, elements, destinations } = state.login
  const password = state.input?.[0]
  const controls = ${loginFormElements}
  // ponytail: only the original, visible login field cleared after a scoped submission; not authentication proof.
  if (!form.isConnected || form.method !== 'post' || form.action !== action ||
      new URL(action).origin !== location.origin || credentials.length !== 1 ||
      credentials[0] !== password || password.form !== form || password.type !== 'password' ||
      password.autocomplete !== role || !visible(password) || password.validity.customError ||
      (user && (user.form !== form || !visible(user) || user.value !== username)) ||
      controls.length !== elements.length || controls.some((el, i) =>
        el !== elements[i] ||
        (el.hasAttribute('formaction') ? el.formAction : form.action) !== destinations[i][0] ||
        (el.hasAttribute('formmethod') ? el.formMethod : form.method) !== destinations[i][1])) return null
  return password.value === ''
})()`
