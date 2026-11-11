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
  const controls =
    typeof document.querySelectorAll === "function"
      ? Array.from(
          document.querySelectorAll(
            "[data-testid='assistant-popover-button-new'], [data-testid*='assistant-popover-button'], [aria-label='AI Assistant'], [aria-label='Open AI Assistant']",
          ),
        )
      : []
  const primary = document.querySelector("[data-testid='assistant-popover-button-new']")
  if (primary && !controls.includes(primary)) controls.unshift(primary)
  if (controls.length === 0 && typeof document.querySelectorAll === "function") {
    for (const host of Array.from(document.querySelectorAll("*"))) {
      if (host.shadowRoot) {
        for (const el of Array.from(
          host.shadowRoot.querySelectorAll(
            "[data-testid='assistant-popover-button-new'], [data-testid*='assistant-popover-button'], [aria-label='AI Assistant'], [aria-label='Open AI Assistant']",
          ),
        )) {
          if (!controls.includes(el)) controls.push(el)
        }
      }
    }
  }
  const controlReady = controls.some((control) => {
    const inner = control.shadowRoot?.querySelector?.("button, [role='button']") ?? null
    return (
      visible(control) &&
      !control.matches?.(":disabled") &&
      !control.closest?.("[disabled], [aria-disabled='true']") &&
      !inner?.matches?.(":disabled") &&
      inner?.getAttribute?.("aria-disabled") !== "true"
    )
  })
  const busy = Array.from(
    document.querySelectorAll("[aria-busy='true'], [role='progressbar'], .ant-spin-spinning"),
  ).some(visible)
  return {
    ready:
      document.readyState === "complete" &&
      (!requireAssistantControl || controlReady) &&
      Array.from(document.images).every((image) => image.complete) &&
      !busy,
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
  if (document.readyState !== "complete") {
    return {
      open: false,
      click: false,
      domClick: false,
      buttonFound: false,
      expanded: false,
      disabled: false,
      unobscured: false,
      iframePresent: false,
    }
  }
  const iframeSelector =
    "iframe#assistant-iframe, iframe[name='assistant-iframe'], iframe[src*='open-web-assistant-cs.wpp.ai']"
  const iframes =
    typeof document.querySelectorAll === "function"
      ? Array.from(document.querySelectorAll<HTMLIFrameElement>(iframeSelector))
      : []
  const primaryIframe = document.querySelector<HTMLIFrameElement>("#assistant-iframe")
  if (primaryIframe && !iframes.includes(primaryIframe)) iframes.unshift(primaryIframe)
  if (typeof document.querySelectorAll === "function") {
    for (const host of Array.from(document.querySelectorAll("*"))) {
      if (host.shadowRoot) {
        for (const frame of Array.from(host.shadowRoot.querySelectorAll<HTMLIFrameElement>(iframeSelector))) {
          if (!iframes.includes(frame)) iframes.push(frame)
        }
      }
    }
  }
  if (
    iframes.some((iframe) => {
      const src = iframe.src || iframe.getAttribute?.("src") || ""
      return URL.parse(src)?.origin === "https://open-web-assistant-cs.wpp.ai"
    })
  ) {
    return { open: true, iframePresent: true }
  }

  const buttonSelector =
    "[data-testid='assistant-popover-button-new'], [data-testid*='assistant-popover-button'], [aria-label='AI Assistant'], [aria-label='Open AI Assistant']"
  const controls =
    typeof document.querySelectorAll === "function" ? Array.from(document.querySelectorAll(buttonSelector)) : []
  const primaryControl = document.querySelector("[data-testid='assistant-popover-button-new']")
  if (primaryControl && !controls.includes(primaryControl)) controls.unshift(primaryControl)
  if (controls.length === 0 && typeof document.querySelectorAll === "function") {
    for (const host of Array.from(document.querySelectorAll("*"))) {
      if (host.shadowRoot) {
        for (const el of Array.from(host.shadowRoot.querySelectorAll(buttonSelector))) {
          if (!controls.includes(el)) controls.push(el)
        }
      }
    }
  }
  if (controls.length === 0) {
    return {
      open: false,
      click: false,
      domClick: false,
      buttonFound: false,
      expanded: false,
      disabled: false,
      unobscured: false,
      iframePresent: iframes.length > 0,
    }
  }

  const candidates = controls.map((control) => {
    const rect = control.getBoundingClientRect()
    const style =
      typeof getComputedStyle === "function"
        ? getComputedStyle(control)
        : { display: "block", visibility: "visible" }
    const visible =
      rect.width > 0 && rect.height > 0 && style.display !== "none" && style.visibility !== "hidden"
    const inner = control.shadowRoot?.querySelector?.("button, [role='button']") ?? null
    const disabled = Boolean(
      control.matches?.(":disabled") ||
        control.closest?.("[disabled], [aria-disabled='true']") ||
        inner?.matches?.(":disabled") ||
        inner?.getAttribute?.("aria-disabled") === "true",
    )
    const expanded =
      control.getAttribute?.("aria-expanded") === "true" ||
      inner?.getAttribute?.("aria-expanded") === "true" ||
      control.getAttribute?.("data-state") === "open" ||
      inner?.getAttribute?.("data-state") === "open"
    const x = Math.round(rect.left + rect.width / 2)
    const y = Math.round(rect.top + rect.height / 2)
    const hit = typeof document.elementFromPoint === "function" ? document.elementFromPoint(x, y) : null
    const unobscured = Boolean(
      hit &&
        (hit === control ||
          control.contains?.(hit) ||
          hit.contains?.(control) ||
          (control.shadowRoot && control.shadowRoot.contains?.(hit))),
    )
    return { control, rect, visible, disabled, expanded, unobscured, x, y }
  })

  const best =
    candidates.find((c) => c.visible && !c.disabled && c.unobscured) ??
    candidates.find((c) => c.visible && !c.disabled) ??
    candidates.find((c) => c.visible) ??
    candidates[0]

  const actionable = best.visible && !best.disabled && !best.expanded && iframes.length === 0
  return {
    open: false,
    click: actionable && best.unobscured,
    domClick: actionable && !best.unobscured,
    buttonFound: true,
    expanded: best.expanded,
    disabled: best.disabled,
    unobscured: best.unobscured,
    iframePresent: iframes.length > 0,
    x: best.x,
    y: best.y,
  }
}

export function clickAssistantControlExpression() {
  return `(${clickAssistantControl.toString()})()`
}

function clickAssistantControl() {
  const buttonSelector =
    "[data-testid='assistant-popover-button-new'], [data-testid*='assistant-popover-button'], [aria-label='AI Assistant'], [aria-label='Open AI Assistant']"
  const controls =
    typeof document.querySelectorAll === "function" ? Array.from(document.querySelectorAll(buttonSelector)) : []
  const primary = document.querySelector("[data-testid='assistant-popover-button-new']")
  if (primary && !controls.includes(primary)) controls.unshift(primary)
  if (controls.length === 0 && typeof document.querySelectorAll === "function") {
    for (const host of Array.from(document.querySelectorAll("*"))) {
      if (host.shadowRoot) {
        for (const el of Array.from(host.shadowRoot.querySelectorAll(buttonSelector))) {
          if (!controls.includes(el)) controls.push(el)
        }
      }
    }
  }
  const visibleControls = controls.filter((control) => {
    const rect = control.getBoundingClientRect()
    const style =
      typeof getComputedStyle === "function"
        ? getComputedStyle(control)
        : { display: "block", visibility: "visible" }
    const inner = control.shadowRoot?.querySelector?.("button, [role='button']") ?? null
    const disabled = Boolean(
      control.matches?.(":disabled") ||
        control.closest?.("[disabled], [aria-disabled='true']") ||
        inner?.matches?.(":disabled") ||
        inner?.getAttribute?.("aria-disabled") === "true",
    )
    return rect.width > 0 && rect.height > 0 && style.display !== "none" && style.visibility !== "hidden" && !disabled
  })
  const target = visibleControls[0] ?? controls[0]
  if (!target) return false
  const inner = target.shadowRoot?.querySelector<HTMLElement>("button, [role='button']") ?? null
  const clickable = inner ?? (target as HTMLElement)
  if (typeof clickable.click === "function") {
    clickable.click()
    return true
  }
  return false
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
  let pendingSince: number | null = null
  let lastState: Record<string, unknown> = {}
  const expire = () =>
    assistantError("o1_code_assistant_popover_timeout", {
      phase: "assistant-popover",
      clickCount,
      buttonFound: typeof lastState.buttonFound === "boolean" ? lastState.buttonFound : undefined,
      expanded: typeof lastState.expanded === "boolean" ? lastState.expanded : undefined,
      disabled: typeof lastState.disabled === "boolean" ? lastState.disabled : undefined,
      unobscured: typeof lastState.unobscured === "boolean" ? lastState.unobscured : undefined,
      iframePresent: typeof lastState.iframePresent === "boolean" ? lastState.iframePresent : undefined,
    })
  while (now() < deadline) {
    if (contents.mainFrame?.framesInSubtree?.filter((frame) => isAssistantChatUrl(frame.url)).length === 1) {
      return
    }
    const state = await navigationWait(
      () => contents.executeJavaScript(assistantPanelStateExpression(), true),
      deadline - now(),
      signal,
      expire,
    )
    if (state && typeof state === "object") {
      lastState = state as Record<string, unknown>
      if (Reflect.get(state, "open") === true) return
      const expanded = Reflect.get(state, "expanded") === true
      const iframePresent = Reflect.get(state, "iframePresent") === true
      const disabled = Reflect.get(state, "disabled") === true
      const buttonFound = Reflect.get(state, "buttonFound") === true
      if (expanded || iframePresent) {
        if (pendingSince === null) pendingSince = now()
      } else {
        pendingSince = null
      }
      const stuckPending =
        pendingSince !== null && now() - pendingSince >= 15000 && buttonFound && !disabled
      const x = Reflect.get(state, "x")
      const y = Reflect.get(state, "y")
      const canNativeClick = Reflect.get(state, "click") === true && typeof x === "number" && typeof y === "number"
      const canDomClick = Reflect.get(state, "domClick") === true || stuckPending
      if ((canNativeClick || canDomClick) && now() >= nextClickAt) {
        if (signal?.aborted) throw assistantError("o1_code_client_aborted")
        if (canNativeClick && clickCount % 2 === 0 && !stuckPending) {
          contents.sendInputEvent({ type: "mouseMove", x, y })
          contents.sendInputEvent({ type: "mouseDown", button: "left", x, y, clickCount: 1 })
          contents.sendInputEvent({ type: "mouseUp", button: "left", x, y, clickCount: 1 })
        } else {
          await navigationWait(
            () => contents.executeJavaScript(clickAssistantControlExpression(), true),
            deadline - now(),
            signal,
            expire,
          )
        }
        clickCount += 1
        if (stuckPending) pendingSince = now()
        nextClickAt = now() + 12000
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
