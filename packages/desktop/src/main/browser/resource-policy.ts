import type { WebContents } from "electron"

export type BrowserResourceState = {
  active: boolean
  loading: boolean
  pinned: boolean
  granted: boolean
  busy: boolean
  transferring: boolean
  media: boolean
  unsaved: boolean
  unknown: boolean
}

// Unknown pages never qualify for automatic eviction. Manual unloading is an
// explicit URL/history-only recovery decision, not a claim that page state is saved.
export function browserResourceBlocker(state: BrowserResourceState) {
  if (state.active) return "active"
  if (state.loading) return "loading"
  if (state.pinned) return "pinned"
  if (state.granted) return "granted"
  if (state.busy) return "busy"
  if (state.transferring) return "transfer"
  if (state.media) return "media"
  if (state.unsaved) return "unsaved"
  if (state.unknown) return "unknown"
  return undefined
}

export const browserResourceProbe = `(() => {
  const roots = [document];
  const result = { unsaved: false, media: false, unknown: false };
  let visited = 0;
  for (let index = 0; index < roots.length; index++) {
    if (index > 256) { result.unknown = true; break; }
    const root = roots[index];
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_ELEMENT);
    let element;
    while (element = walker.nextNode()) {
      if (++visited > 10000) { result.unknown = true; return result; }
      if (element.shadowRoot) roots.push(element.shadowRoot);
      if (element.localName.includes('-') && !element.shadowRoot) result.unknown = true;
      if (element.localName === 'iframe' || element.localName === 'frame') result.unknown = true;
      if (element instanceof HTMLInputElement) {
        if (element.type === 'file' && element.files.length) result.unsaved = true;
        if (['checkbox', 'radio'].includes(element.type) && element.checked !== element.defaultChecked) result.unsaved = true;
        if (!['hidden', 'button', 'submit', 'reset', 'checkbox', 'radio', 'file'].includes(element.type) && !element.readOnly && !element.disabled && element.value) result.unsaved = true;
      }
      if (element instanceof HTMLTextAreaElement && !element.readOnly && !element.disabled && element.value) result.unsaved = true;
      if (element instanceof HTMLOptionElement && element.selected !== element.defaultSelected) result.unsaved = true;
      if (element instanceof HTMLElement && element.isContentEditable && element.childNodes.length) result.unsaved = true;
      if (element instanceof HTMLMediaElement && !element.paused && !element.ended) result.media = true;
    }
  }
  return result;
})()`

export async function inspectBrowserResources(contents: WebContents) {
  const unavailable = { unsaved: false, media: false, unknown: true }
  if (contents.isDestroyed()) return unavailable
  // This fixed, read-only probe runs outside page JavaScript. An incomplete or
  // unresponsive inspection protects the tab rather than granting disposal.
  const timeout = Promise.withResolvers<undefined>()
  const timer = setTimeout(timeout.resolve, 1_000)
  const result: unknown = await Promise.race([
    contents.executeJavaScriptInIsolatedWorld(999, [{ code: browserResourceProbe }]).catch(() => undefined),
    timeout.promise,
  ])
  clearTimeout(timer)
  if (
    !result ||
    typeof result !== "object" ||
    !("unsaved" in result) ||
    typeof result.unsaved !== "boolean" ||
    !("media" in result) ||
    typeof result.media !== "boolean" ||
    !("unknown" in result) ||
    typeof result.unknown !== "boolean"
  )
    return unavailable
  return { unsaved: result.unsaved, media: result.media, unknown: result.unknown }
}
