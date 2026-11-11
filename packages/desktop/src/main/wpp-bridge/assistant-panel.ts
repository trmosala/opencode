export function isAssistantChatUrl(value: string) {
  const url = URL.parse(value)
  return (
    url?.origin === "https://open-web-assistant-cs.wpp.ai" &&
    /^\/chat\/[^/]+\/(?:ai-assistant|foundational)\/?$/.test(url.pathname)
  )
}

type AssistantFrame = { url: string; executeJavaScript(code: string, userGesture?: boolean): Promise<unknown> }

export function assistantFrame<Frame extends AssistantFrame>(contents: { mainFrame: { framesInSubtree: Frame[] } }) {
  const frames = contents.mainFrame.framesInSubtree.filter((frame) => isAssistantChatUrl(frame.url))
  if (frames.length !== 1) throw assistantError("o1_code_thread_desync")
  return frames[0]
}

// Ordered by preference: earlier selectors win, so the real WPP control beats a looser label match.
// Label matches are limited to button-like elements so a heading or link named "AI Assistant" is never chosen.
const ASSISTANT_CONTROL_SELECTORS = [
  "[data-testid='assistant-popover-button-new']",
  "[data-testid*='assistant-popover-button']",
  "button[aria-label='AI Assistant'], [role='button'][aria-label='AI Assistant']",
  "button[aria-label='Open AI Assistant'], [role='button'][aria-label='Open AI Assistant']",
]

const ASSISTANT_IFRAME_SELECTOR =
  "iframe#assistant-iframe, iframe[name='assistant-iframe'], iframe[src*='open-web-assistant-cs.wpp.ai']"

export function projectPageStateExpression(requireAssistantControl = false) {
  return `(${projectPageState.toString()})(${JSON.stringify(requireAssistantControl)}, ${findAssistantControls.toString()}, ${JSON.stringify(ASSISTANT_CONTROL_SELECTORS)})`
}

function projectPageState(
  requireAssistantControl: boolean,
  findControls: (selectors: string[]) => Element[],
  controlSelectors: string[],
) {
  const visible = (element: Element) => {
    const rect = element.getBoundingClientRect()
    const style = getComputedStyle(element)
    return rect.width > 0 && rect.height > 0 && style.display !== "none" && style.visibility !== "hidden"
  }
  const controlReady =
    !requireAssistantControl ||
    findControls(controlSelectors).some((control) => {
      const inner = control.shadowRoot?.querySelector("button, [role='button']")
      return (
        visible(control) &&
        !control.matches(":disabled") &&
        !control.closest("[disabled], [aria-disabled='true']") &&
        !inner?.matches(":disabled") &&
        inner?.getAttribute("aria-disabled") !== "true"
      )
    })
  const busy = Array.from(
    document.querySelectorAll("[aria-busy='true'], [role='progressbar'], .ant-spin-spinning"),
  ).some(visible)
  return {
    ready:
      document.readyState === "complete" &&
      controlReady &&
      Array.from(document.images).every((image) => image.complete) &&
      !busy,
    // Viewers may have no agent-card controls. Observe lazy roster changes without requiring edit access.
    signature: JSON.stringify(
      Array.from(document.querySelectorAll(".agent-card-title__name")).map((name) => name.textContent?.trim() ?? ""),
    ),
  }
}

// Runs in the page. Shadow roots are walked only when the light DOM has no match, so a normal page is
// not fully traversed on every poll. Results keep selector order, so the preferred control comes first.
function findAssistantControls(selectors: string[]) {
  const unique = (elements: Element[]) => elements.filter((element, index) => elements.indexOf(element) === index)
  const light = unique(selectors.flatMap((selector) => Array.from(document.querySelectorAll(selector))))
  if (light.length > 0) return light
  const roots = Array.from(document.querySelectorAll("*")).flatMap((host) => (host.shadowRoot ? [host.shadowRoot] : []))
  return unique(selectors.flatMap((selector) => roots.flatMap((root) => Array.from(root.querySelectorAll(selector)))))
}

export function assistantPanelStateExpression() {
  return assistantPanelExpression(false)
}

export function clickAssistantControlExpression() {
  return assistantPanelExpression(true)
}

function assistantPanelExpression(click: boolean) {
  return `(${assistantPanelState.toString()})(${JSON.stringify(click)}, ${findAssistantControls.toString()}, ${JSON.stringify(ASSISTANT_CONTROL_SELECTORS)}, ${JSON.stringify(ASSISTANT_IFRAME_SELECTOR)})`
}

// Runs in the page. Observes the popover and, when `click` is set, clicks the same control the
// observation chose, so the DOM fallback can never target a different element.
function assistantPanelState(
  click: boolean,
  findControls: (selectors: string[]) => Element[],
  controlSelectors: string[],
  iframeSelector: string,
) {
  const closed = {
    open: false,
    click: false,
    domClick: false,
    clicked: false,
    buttonFound: false,
    expanded: false,
    disabled: false,
    unobscured: false,
    iframePresent: false,
  }
  if (document.readyState !== "complete") return closed
  const visible = (element: Element) => {
    const rect = element.getBoundingClientRect()
    const style = getComputedStyle(element)
    return rect.width > 0 && rect.height > 0 && style.display !== "none" && style.visibility !== "hidden"
  }
  const isClickable = (element: Element): element is Element & { click: () => void } =>
    "click" in element && typeof element.click === "function"
  const iframes = Array.from(document.querySelectorAll<HTMLIFrameElement>(iframeSelector)).filter(
    (iframe) => URL.parse(iframe.src)?.origin === "https://open-web-assistant-cs.wpp.ai",
  )
  if (iframes.some(visible)) return { ...closed, open: true, iframePresent: true }
  // A mounted but not yet visible assistant frame means the popover is still opening.
  const iframePresent = iframes.length > 0
  const candidates = findControls(controlSelectors).map((control) => {
    const rect = control.getBoundingClientRect()
    const inner = control.shadowRoot?.querySelector("button, [role='button']") ?? null
    const disabled = Boolean(
      control.matches(":disabled") ||
        control.closest("[disabled], [aria-disabled='true']") ||
        inner?.matches(":disabled") ||
        inner?.getAttribute("aria-disabled") === "true",
    )
    const expanded = [control, inner].some(
      (element) => element?.getAttribute("aria-expanded") === "true" || element?.getAttribute("data-state") === "open",
    )
    const x = Math.round(rect.left + rect.width / 2)
    const y = Math.round(rect.top + rect.height / 2)
    const hit = document.elementFromPoint(x, y)
    const unobscured = Boolean(
      hit && (hit === control || control.contains(hit) || hit.contains?.(control) || control.shadowRoot?.contains(hit)),
    )
    return { control, inner, visible: visible(control), disabled, expanded, unobscured, x, y }
  })
  if (candidates.length === 0) return { ...closed, iframePresent }

  const best =
    candidates.find((c) => c.visible && !c.disabled && c.unobscured) ??
    candidates.find((c) => c.visible && !c.disabled) ??
    candidates.find((c) => c.visible) ??
    candidates[0]
  // Never click while the popover reports itself open or its frame is mounted: a second click closes it.
  const actionable = best.visible && !best.disabled && !best.expanded && !iframePresent
  const target = best.inner ?? best.control
  const clicked = click && actionable && isClickable(target)
  if (clicked && isClickable(target)) target.click()
  return {
    ...closed,
    click: actionable && best.unobscured,
    domClick: actionable && !best.unobscured,
    clicked,
    buttonFound: true,
    expanded: best.expanded,
    disabled: best.disabled,
    unobscured: best.unobscured,
    iframePresent,
    x: best.x,
    y: best.y,
  }
}

export async function openAssistantPanel(
  contents: {
    mainFrame?: { framesInSubtree?: { url: string }[] }
    executeJavaScript(code: string, userGesture?: boolean): Promise<unknown>
    sendInputEvent(event: {
      type: "mouseMove" | "mouseDown" | "mouseUp"
      x: number
      y: number
      button?: "left"
      clickCount?: number
    }): void
  },
  {
    now = Date.now,
    sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)),
    timeoutMs = 240000,
    signal,
  }: {
    now?: () => number
    sleep?: (ms: number) => Promise<void>
    timeoutMs?: number
    signal?: AbortSignal
  } = {},
) {
  const deadline = now() + timeoutMs
  let nextClickAt = 0
  let clickCount = 0
  let lastState: unknown
  const flag = (key: string) => {
    const value = lastState && typeof lastState === "object" ? Reflect.get(lastState, key) : undefined
    return typeof value === "boolean" ? value : undefined
  }
  const expire = () =>
    assistantError("o1_code_assistant_popover_timeout", {
      phase: "assistant-popover",
      clickCount,
      buttonFound: flag("buttonFound"),
      expanded: flag("expanded"),
      disabled: flag("disabled"),
      unobscured: flag("unobscured"),
      iframePresent: flag("iframePresent"),
    })
  while (now() < deadline) {
    const state = await navigationWait(
      () => contents.executeJavaScript(assistantPanelStateExpression(), true),
      deadline - now(),
      signal,
      expire,
    )
    lastState = state
    if (state && typeof state === "object") {
      if (Reflect.get(state, "open") === true) return
      // The assistant frame can live in a shadow root the page probe does not search. Trust the frame
      // tree only when the page has not reported a mounted but hidden assistant iframe.
      if (Reflect.get(state, "iframePresent") !== true && assistantChatFrameCount(contents) === 1) return
      const x = Reflect.get(state, "x")
      const y = Reflect.get(state, "y")
      const nativeClick = Reflect.get(state, "click") === true && typeof x === "number" && typeof y === "number"
      if ((nativeClick || Reflect.get(state, "domClick") === true) && now() >= nextClickAt) {
        if (signal?.aborted) throw assistantError("o1_code_client_aborted")
        // Alternate input paths: a click that changed nothing may have missed the native hit target.
        const useNative = nativeClick && clickCount % 2 === 0
        if (useNative) {
          contents.sendInputEvent({ type: "mouseMove", x, y })
          contents.sendInputEvent({ type: "mouseDown", button: "left", x, y, clickCount: 1 })
          contents.sendInputEvent({ type: "mouseUp", button: "left", x, y, clickCount: 1 })
        }
        if (!useNative)
          await navigationWait(
            () => contents.executeJavaScript(clickAssistantControlExpression(), true),
            deadline - now(),
            signal,
            expire,
          )
        clickCount += 1
        // Leave a slow popover time to mount its frame before another click could toggle it closed.
        nextClickAt = now() + 12000
      }
    }
    await navigationWait(() => sleep(250), deadline - now(), signal, expire)
  }
  throw expire()
}

// Frames can be detached mid-navigation and throw on access; treat that as not open yet.
function assistantChatFrameCount(contents: { mainFrame?: { framesInSubtree?: { url: string }[] } }) {
  try {
    return contents.mainFrame?.framesInSubtree?.filter((frame) => isAssistantChatUrl(frame.url)).length ?? 0
  } catch {
    return 0
  }
}

export async function prepareAssistantChat(
  contents: Parameters<typeof assistantFrame>[0] & {
    executeJavaScript(code: string, userGesture?: boolean): Promise<unknown>
    isDestroyed?(): boolean
  },
  inspect: () => Promise<unknown>,
  {
    now = Date.now,
    sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)),
    timeoutMs = 60000,
  }: {
    now?: () => number
    sleep?: (ms: number) => Promise<void>
    timeoutMs?: number
  } = {},
) {
  const deadline = now() + timeoutMs
  const expire = () => assistantError("o1_code_fresh_chat_failed")
  const reset = await navigationWait(
    () => contents.executeJavaScript(freshChatInShellExpression(), true),
    deadline - now(),
    undefined,
    expire,
  )
  if (
    !reset ||
    typeof reset !== "object" ||
    Reflect.get(reset, "ok") !== true ||
    Reflect.get(reset, "clicked") !== true
  )
    throw expire()
  let previous: AssistantFrame | undefined
  let stable = 0
  while (now() < deadline) {
    if (contents.isDestroyed?.()) throw assistantError("o1_code_thread_desync")
    const frame = (() => {
      try {
        return assistantFrame(contents)
      } catch {
        return undefined
      }
    })()
    const state = frame ? await navigationWait(inspect, deadline - now(), undefined, expire).catch(() => null) : null
    if (frame && state && typeof state === "object" && Reflect.get(state, "ready") === true)
      stable = frame === previous ? stable + 1 : 1
    else stable = 0
    previous = frame
    if (stable >= 2) return
    await navigationWait(() => sleep(250), deadline - now(), undefined, expire)
  }
  throw expire()
}

export function freshChatInShellExpression() {
  return `(${freshChatInShellPage.toString()})()`
}

async function freshChatInShellPage() {
  const wait = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms))
  const isVisible = (element: Element) => {
    const style = getComputedStyle(element)
    const rect = element.getBoundingClientRect()
    return style.visibility !== "hidden" && style.display !== "none" && rect.width > 0 && rect.height > 0
  }
  const isClickable = (element: Element): element is Element & { click: () => void } =>
    "click" in element && typeof element.click === "function"
  const findNewChat = () =>
    Array.from(document.querySelectorAll("[role='menuitem']")).find(
      (element): element is Element & { click: () => void } =>
        isClickable(element) &&
        isVisible(element) &&
        (/-NEW_CHAT$/i.test(element.getAttribute("data-menu-id") || "") ||
          /^\s*new\s+(chat|conversation)\s*$/i.test(element.textContent || "")),
    )
  const activateNewChat = async (item: Element & { click: () => void }) => {
    item.click()
    await wait(250)
    return { ok: true, clicked: true }
  }

  const existingItem = findNewChat()
  if (existingItem) return activateNewChat(existingItem)

  const frame = document.querySelector(
    "iframe#assistant-iframe, iframe[name='assistant-iframe'], iframe[src*='open-web-assistant-cs.wpp.ai']",
  )
  if (!frame || !isVisible(frame)) return { ok: false, clicked: false, reason: "assistant-frame-not-found" }

  const frameRect = frame.getBoundingClientRect()
  const candidates = Array.from(document.querySelectorAll("[data-testid='wpp-icon-more']"))
    .map((icon) => {
      const host = icon.closest("wpp-action-button-v4-3-0") || icon.parentElement
      const control = host?.shadowRoot?.querySelector("button") || host || icon
      if (!isClickable(control)) return null
      const rect = control.getBoundingClientRect()
      return { control, rect, gap: frameRect.top - rect.bottom }
    })
    .flatMap((candidate) =>
      candidate &&
      isVisible(candidate.control) &&
      candidate.rect.left >= frameRect.left &&
      candidate.rect.right <= frameRect.right &&
      candidate.gap >= -4 &&
      candidate.gap <= 120
        ? [candidate]
        : [],
    )
    .sort((left, right) => left.gap - right.gap || right.rect.right - left.rect.right)

  if (!candidates[0]) return { ok: false, clicked: false, reason: "assistant-menu-trigger-not-found" }
  candidates[0].control.click()

  const deadline = Date.now() + 2500
  while (Date.now() < deadline) {
    const item = findNewChat()
    if (item) return activateNewChat(item)
    await wait(50)
  }

  return { ok: false, clicked: false, reason: "new-chat-menu-item-not-found" }
}

export function navigationWait<T>(
  operation: () => Promise<T>,
  remaining: number,
  signal: AbortSignal | undefined,
  expire: () => Error,
): Promise<T> {
  if (signal?.aborted) return Promise.reject(assistantError("o1_code_client_aborted"))
  if (remaining <= 0) return Promise.reject(expire())
  let rejectWait: (error: Error) => void = () => {}
  const abort = () => rejectWait(assistantError("o1_code_client_aborted"))
  const timer = setTimeout(() => rejectWait(expire()), remaining)
  return new Promise<T>((resolve, reject) => {
    rejectWait = reject
    signal?.addEventListener("abort", abort, { once: true })
    Promise.resolve()
      .then(() => {
        if (signal?.aborted) throw assistantError("o1_code_client_aborted")
        return operation()
      })
      .then(resolve, reject)
  }).finally(() => {
    clearTimeout(timer)
    signal?.removeEventListener("abort", abort)
  })
}

function assistantError(type: string, diagnostics?: Record<string, unknown>) {
  const error = new Error(type)
  Reflect.set(error, "type", type)
  Reflect.set(
    error,
    "statusCode",
    type === "o1_code_client_aborted"
      ? 499
      : type === "o1_code_wrong_agent" || type === "o1_code_wrong_project"
        ? 400
        : 502,
  )
  if (diagnostics) Reflect.set(error, "diagnostics", diagnostics)
  return error
}
