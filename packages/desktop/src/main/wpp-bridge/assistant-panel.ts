// Exact chat leaves only. A wildcard leaf also matches other same-origin chat frames, so assistantFrame
// would report a thread desync or route to the wrong frame.
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

export function projectPageStateExpression(requireAssistantControl = false) {
  return `(${projectPageState.toString()})(${JSON.stringify(requireAssistantControl)})`
}

function projectPageState(requireAssistantControl: boolean) {
  const visible = (element: Element) => {
    const rect = element.getBoundingClientRect()
    const style = getComputedStyle(element)
    return rect.width > 0 && rect.height > 0 && style.display !== "none" && style.visibility !== "hidden"
  }
  const control = document.querySelector("[data-testid='assistant-popover-button-new']")
  const controlReady = Boolean(
    control &&
      visible(control) &&
      !control.matches(":disabled") &&
      !control.closest("[disabled], [aria-disabled='true']"),
  )
  const busy = Array.from(
    document.querySelectorAll("[aria-busy='true'], [role='progressbar'], .ant-spin-spinning"),
  ).some(visible)
  // Control-ready is enough for assistant mode: incomplete lazy images and leftover spinners used to
  // hold ready=false for minutes even though the popover button was already clickable.
  const ready = document.readyState === "complete" && (requireAssistantControl ? controlReady : !busy)
  return {
    ready,
    // Viewers may have no agent-card controls. Observe lazy roster changes without requiring edit access.
    signature: JSON.stringify(
      Array.from(document.querySelectorAll(".agent-card-title__name")).map((name) => name.textContent?.trim() ?? ""),
    ),
  }
}

export function assistantPanelStateExpression() {
  return `(${assistantPanelState.toString()})()`
}

function assistantPanelState() {
  if (document.readyState !== "complete") return { open: false, click: false }
  const assistantOrigin = "https://open-web-assistant-cs.wpp.ai"
  const iframe = Array.from(document.querySelectorAll("iframe")).find((frame) => {
    const src = URL.parse(frame.src)
    return src?.origin === assistantOrigin
  })
  if (iframe) {
    const rect = iframe.getBoundingClientRect()
    if (rect.width > 0 && rect.height > 0) return { open: true }
  }
  const control = document.querySelector("[data-testid='assistant-popover-button-new']")
  if (!control) return { open: false, click: false }
  const rect = control.getBoundingClientRect()
  const x = Math.round(rect.left + rect.width / 2)
  const y = Math.round(rect.top + rect.height / 2)
  const enabled =
    control.getAttribute("aria-expanded") !== "true" &&
    !control.matches(":disabled") &&
    !control.closest("[disabled], [aria-disabled='true']") &&
    rect.width > 0 &&
    rect.height > 0
  if (!enabled) return { open: false, click: false }
  const hit = document.elementFromPoint(x, y)
  if (hit && (hit === control || control.contains(hit))) return { open: false, click: true, x, y }
  // Overlay / hit-test miss: still ask the host to JS-click the control.
  return { open: false, click: false, jsClick: true }
}

export async function openAssistantPanel(
  contents: {
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
    timeoutMs = 60000,
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
  const expire = () => assistantError("o1_code_assistant_popover_timeout")
  while (now() < deadline) {
    const state = await navigationWait(
      () => contents.executeJavaScript(assistantPanelStateExpression(), true),
      deadline - now(),
      signal,
      expire,
    )
    if (state && typeof state === "object") {
      if (Reflect.get(state, "open") === true) return
      const x = Reflect.get(state, "x")
      const y = Reflect.get(state, "y")
      if (
        Reflect.get(state, "click") === true &&
        typeof x === "number" &&
        typeof y === "number" &&
        now() >= nextClickAt
      ) {
        if (signal?.aborted) throw assistantError("o1_code_client_aborted")
        contents.sendInputEvent({ type: "mouseMove", x, y })
        contents.sendInputEvent({ type: "mouseDown", button: "left", x, y, clickCount: 1 })
        contents.sendInputEvent({ type: "mouseUp", button: "left", x, y, clickCount: 1 })
        nextClickAt = now() + 3000
      } else if (Reflect.get(state, "jsClick") === true && now() >= nextClickAt) {
        if (signal?.aborted) throw assistantError("o1_code_client_aborted")
        await navigationWait(
          () =>
            contents.executeJavaScript(
              `(() => { const c = document.querySelector("[data-testid='assistant-popover-button-new']"); if (c && "click" in c) c.click(); return Boolean(c) })()`,
              true,
            ),
          deadline - now(),
          signal,
          expire,
        )
        nextClickAt = now() + 3000
      }
    }
    await navigationWait(() => sleep(250), deadline - now(), signal, expire)
  }
  throw expire()
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
  const actionHost = (node: Element) => {
    let current: Element | null = node
    while (current) {
      if (current.tagName.toLowerCase().startsWith("wpp-action-button")) return current
      current = current.parentElement
    }
    return node.parentElement
  }
  const candidates = Array.from(document.querySelectorAll("[data-testid='wpp-icon-more']"))
    .map((icon) => {
      const host = actionHost(icon)
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

function assistantError(type: string) {
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
  return error
}
