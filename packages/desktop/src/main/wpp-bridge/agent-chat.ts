import { navigationWait } from "./assistant-panel"

export function isAgentChatUrl(value: string) {
  const url = URL.parse(value)
  return (
    url?.origin === "https://open-web-agent-builder-cs.wpp.ai" && /^\/chat\/[^/]+\/foundational\/?$/.test(url.pathname)
  )
}

export function agentChatProjectId(value: string) {
  const url = URL.parse(value)
  if (url?.origin !== "https://open-web-agent-builder-cs.wpp.ai") return undefined
  return url.pathname.match(/^\/(?:agent|chat)\/([^/]+)(?:\/|$)/)?.[1]
}

export function agentChatSelectedExpression(agent: string, verifyComposer = false) {
  return `(${agentChatSelectedPage.toString()})(${JSON.stringify(agent)},${JSON.stringify(verifyComposer)})`
}

function agentChatSelectedPage(agent: string, verifyComposer: boolean) {
  const buttons = document.querySelectorAll("[data-testid='chat-model-button']")
  const modelMatches = buttons.length === 1 && buttons[0].textContent?.trim() === agent
  if (!verifyComposer) return modelMatches
  const visible = (element: Element) => {
    const style = getComputedStyle(element)
    const rect = element.getBoundingClientRect()
    return style.display !== "none" && style.visibility !== "hidden" && rect.width > 0 && rect.height > 0
  }
  const inputs = Array.from(
    document.querySelectorAll<HTMLTextAreaElement>("textarea[data-testid='chat-input']"),
  ).filter(visible)
  const loaded = document.readyState === "complete"
  const modelReady = modelMatches && visible(buttons[0])
  const composerReady = inputs.length === 1 && inputs[0].isConnected && !inputs[0].disabled && !inputs[0].readOnly
  return { loaded, modelReady, composerReady, ready: loaded && modelReady && composerReady }
}

export function agentChatLaunchExpression(agent: string, action: "inspect" | "hover" | "open" | "chat" = "inspect") {
  return `(${agentChatLaunchPage.toString()})(${JSON.stringify(agent)},${JSON.stringify(action)})`
}

function agentChatLaunchPage(agent: string, action: "inspect" | "hover" | "open" | "chat") {
  if (document.readyState !== "complete") return { state: "loading", acted: false }
  const visible = (element: Element) => {
    const style = getComputedStyle(element)
    const rect = element.getBoundingClientRect()
    return style.display !== "none" && style.visibility !== "hidden" && rect.width > 0 && rect.height > 0
  }
  const cards = Array.from(document.querySelectorAll(".agent-card")).filter(
    (card) => card.querySelector(".agent-card-title__name")?.textContent?.trim() === agent,
  )
  if (cards.length > 1) return { state: "ambiguous", acted: false }
  if (cards.length !== 1) return { state: "waiting", acted: false }
  const button = cards[0].querySelector<HTMLButtonElement>("button.agent-card-more-button")
  if (!button || button.disabled || !visible(cards[0]) || !visible(button)) return { state: "waiting", acted: false }
  const items = Array.from(document.querySelectorAll<HTMLElement>("[role='menuitem']")).filter(
    (item) => visible(item) && item.textContent?.trim() === "Chat",
  )
  if (items.length > 1) return { state: "ambiguous", acted: false }
  if (items.length === 1) {
    const menu = items[0].closest?.("[role='menu']")
    const controls = button.getAttribute("aria-controls")
    const labelledBy = menu?.getAttribute("aria-labelledby")?.split(/\s+/) ?? []
    // WPP's Ant dropdown is an unlabelled portal. Its sole open trigger and
    // sole visible menu provide the association missing from the ARIA markup.
    const triggers = Array.from(document.querySelectorAll("button.ant-dropdown-trigger.ant-dropdown-open")).filter(
      visible,
    )
    const menus = Array.from(document.querySelectorAll("[role='menu']")).filter(visible)
    const portalOwned =
      !controls &&
      !button.id &&
      !menu?.id &&
      labelledBy.length === 0 &&
      menu?.getAttribute("data-menu-list") === "true" &&
      triggers.length === 1 &&
      triggers[0] === button &&
      menus.length === 1 &&
      menus[0] === menu
    const owned =
      cards[0].contains(items[0]) ||
      Boolean(controls && menu?.id === controls) ||
      Boolean(button.id && labelledBy.includes(button.id)) ||
      portalOwned
    if (!owned) return { state: "blocked", acted: false }
    if (items[0].getAttribute("aria-disabled") === "true" || Reflect.get(items[0], "disabled")) {
      return { state: "waiting", acted: false }
    }
    if (action === "chat") {
      items[0].click()
      return { state: "clicked", acted: true }
    }
    return { state: "menu-ready", acted: false }
  }
  if (Array.from(document.querySelectorAll("[role='menuitem']")).some(visible))
    return { state: "blocked", acted: false }
  if (action === "hover") {
    button.dispatchEvent(new MouseEvent("mouseover", { bubbles: true }))
    return { state: "waiting", acted: true }
  }
  if (action === "open" && button.getAttribute("aria-expanded") !== "true") {
    button.click()
    return { state: "waiting", acted: true }
  }
  return { state: "waiting", acted: false }
}

export function agentRosterStateExpression() {
  return `(${agentRosterStatePage.toString()})()`
}

function agentRosterStatePage() {
  const cards = Array.from(document.querySelectorAll(".agent-card"))
  const names = cards.map((card) => card.querySelector(".agent-card-title__name")?.textContent?.trim() ?? "")
  const busy = Array.from(
    document.querySelectorAll("[aria-busy='true'], [role='progressbar'], .ant-spin-spinning"),
  ).some((element) => {
    const rect = element.getBoundingClientRect()
    const style = getComputedStyle(element)
    return rect.width > 0 && rect.height > 0 && style.display !== "none" && style.visibility !== "hidden"
  })
  return {
    ready:
      document.readyState === "complete" &&
      cards.length > 0 &&
      names.every(Boolean) &&
      cards.every((card) => {
        const button = card.querySelector<HTMLButtonElement>("button.agent-card-more-button")
        return button && !button.disabled
      }) &&
      Array.from(document.images).every((image) => image.complete) &&
      !busy,
    signature: JSON.stringify(names),
  }
}

type ChatFrame = { url: string; executeJavaScript(code: string, userGesture?: boolean): Promise<unknown> }
type ChatContents = { mainFrame: { framesInSubtree: ChatFrame[] } }

export function agentChatFrame<Frame extends ChatFrame>(contents: { mainFrame: { framesInSubtree: Frame[] } }) {
  const frames = contents.mainFrame.framesInSubtree.filter((frame) => isAgentChatUrl(frame.url))
  if (frames.length !== 1) throw agentChatError("o1_code_thread_desync")
  return frames[0]
}

export async function openAgentChat(
  contents: ChatContents,
  agent: string,
  {
    now = Date.now,
    sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)),
    timeoutMs = 240000,
    signal,
    projectId,
  }: {
    now?: () => number
    sleep?: (ms: number) => Promise<void>
    timeoutMs?: number
    signal?: AbortSignal
    projectId?: string
  } = {},
) {
  const deadline = now() + timeoutMs
  let chatClicks = 0
  let hovered = false
  let menuAttempts = 0
  let lastActionAt = 0
  let phase = "waiting-roster"
  let expectedProjectId = projectId
  const expire = () => {
    const error = agentChatError("o1_code_agent_chat_timeout")
    Reflect.set(error, "diagnostics", { phase, chatClicks, menuAttempts })
    return error
  }
  const observe = <T>(operation: () => Promise<T>) => navigationWait(operation, deadline - now(), signal, expire)
  while (now() < deadline) {
    const frames = contents.mainFrame.framesInSubtree
    const chats = frames.filter((frame) => isAgentChatUrl(frame.url))
    if (chats.length > 1) throw agentChatError("o1_code_wrong_agent")
    if (chats.length === 1) {
      if (expectedProjectId && agentChatProjectId(chats[0].url) !== expectedProjectId)
        throw agentChatError("o1_code_wrong_project")
      phase = "verifying-agent"
      const readiness = await observe(() => chats[0].executeJavaScript(agentChatSelectedExpression(agent, true), true))
      if (readiness && typeof readiness === "object" && Reflect.get(readiness, "ready") === true) return
    }
    if (chats.length === 0) phase = chatClicks ? "chat-navigation" : "waiting-roster"
    if (!chatClicks && chats.length === 0) {
      const rosters = frames.filter(
        (frame) => URL.parse(frame.url)?.origin === "https://open-web-agent-builder-cs.wpp.ai",
      )
      if (rosters.length > 1) throw agentChatError("o1_code_wrong_agent")
      if (rosters.length === 1) {
        const rosterProjectId = agentChatProjectId(rosters[0].url)
        if (expectedProjectId && rosterProjectId && expectedProjectId !== rosterProjectId)
          throw agentChatError("o1_code_wrong_project")
        expectedProjectId ??= rosterProjectId
        const inspect = pageLaunchResult(
          await observe(() => rosters[0].executeJavaScript(agentChatLaunchExpression(agent), true)),
        )
        if (inspect.state === "ambiguous" || inspect.state === "blocked") throw agentChatError("o1_code_wrong_agent")
        phase = inspect.state === "loading" ? "roster-loading" : "roster-ui"
        const action =
          inspect.state === "menu-ready"
            ? "chat"
            : !hovered
              ? "hover"
              : now() - lastActionAt >= 1000 && menuAttempts < 2
                ? "open"
                : undefined
        if (inspect.state !== "loading" && action) {
          const result = pageLaunchResult(
            await observe(() => rosters[0].executeJavaScript(agentChatLaunchExpression(agent, action), true)),
          )
          if (result.state === "ambiguous" || result.state === "blocked") throw agentChatError("o1_code_wrong_agent")
          if (result.acted) {
            lastActionAt = now()
            if (action === "hover") hovered = true
            if (action === "open") menuAttempts += 1
            if (result.state === "clicked") {
              chatClicks = 1
              phase = "chat-navigation"
            }
          }
        }
      }
    }
    await observe(() => sleep(250))
  }
  throw expire()
}

function pageLaunchResult(value: unknown) {
  if (!value || typeof value !== "object") throw agentChatError("o1_code_thread_desync")
  const state: unknown = Reflect.get(value, "state")
  const acted: unknown = Reflect.get(value, "acted")
  if (
    typeof state !== "string" ||
    typeof acted !== "boolean" ||
    !["loading", "waiting", "ambiguous", "blocked", "menu-ready", "clicked"].includes(state)
  ) {
    throw agentChatError("o1_code_thread_desync")
  }
  return { state, acted }
}

function agentChatError(type: string) {
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
