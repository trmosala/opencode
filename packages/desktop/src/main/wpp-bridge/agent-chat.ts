export function isAgentChatUrl(value: string) {
  const url = URL.parse(value)
  return (
    url?.origin === "https://open-web-agent-builder-cs.wpp.ai" && /^\/chat\/[^/]+\/foundational\/?$/.test(url.pathname)
  )
}

export function agentChatSelectedExpression(agent: string) {
  return `(${agentChatSelectedPage.toString()})(${JSON.stringify(agent)})`
}

function agentChatSelectedPage(agent: string) {
  const buttons = document.querySelectorAll("[data-testid='chat-model-button']")
  return buttons.length === 1 && buttons[0].textContent?.trim() === agent
}

export function agentChatLaunchExpression(agent: string) {
  return `(${agentChatLaunchPage.toString()})(${JSON.stringify(agent)})`
}

function agentChatLaunchPage(agent: string) {
  const visible = (element: Element) => {
    const style = getComputedStyle(element)
    const rect = element.getBoundingClientRect()
    return style.display !== "none" && style.visibility !== "hidden" && rect.width > 0 && rect.height > 0
  }
  const cards = Array.from(document.querySelectorAll(".agent-card")).filter(
    (card) => card.querySelector(".agent-card-title__name")?.textContent?.trim() === agent,
  )
  if (cards.length > 1) return "ambiguous"
  if (cards.length !== 1) return "waiting"
  const button = cards[0].querySelector<HTMLButtonElement>("button.agent-card-more-button")
  if (!button || button.disabled || !visible(button)) return "waiting"
  if (button.dataset.cmChatLaunch !== agent) {
    if (Array.from(document.querySelectorAll("[role='menuitem']")).some(visible)) return "blocked"
    button.dataset.cmChatLaunch = agent
    // WPP's card dropdown opens on mouse entry, so a programmatic click alone leaves it closed.
    button.dispatchEvent(new MouseEvent("mouseover", { bubbles: true }))
    button.click()
    return "waiting"
  }
  const items = Array.from(document.querySelectorAll<HTMLElement>("[role='menuitem']")).filter(
    (item) => visible(item) && item.textContent?.trim() === "Chat",
  )
  if (items.length > 1) return "ambiguous"
  if (items.length !== 1 || items[0].getAttribute("aria-disabled") === "true") return "waiting"
  delete button.dataset.cmChatLaunch
  items[0].click()
  return "opened"
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
    timeoutMs = 120000,
  } = {},
) {
  const deadline = now() + timeoutMs
  let opened = false
  while (now() < deadline) {
    const frames = contents.mainFrame.framesInSubtree
    const chats = frames.filter((frame) => isAgentChatUrl(frame.url))
    if (chats.length > 1) throw agentChatError("o1_code_wrong_agent")
    if (chats.length === 1) {
      if (await chats[0].executeJavaScript(agentChatSelectedExpression(agent), true)) return
    }
    if (!opened && chats.length === 0) {
      const rosters = frames.filter(
        (frame) => URL.parse(frame.url)?.origin === "https://open-web-agent-builder-cs.wpp.ai",
      )
      if (rosters.length > 1) throw agentChatError("o1_code_wrong_agent")
      if (rosters.length === 1) {
        const state = await rosters[0].executeJavaScript(agentChatLaunchExpression(agent), true)
        if (state === "ambiguous" || state === "blocked") throw agentChatError("o1_code_wrong_agent")
        opened = state === "opened"
      }
    }
    await sleep(250)
  }
  throw agentChatError("o1_code_agent_chat_timeout")
}

function agentChatError(type: string) {
  const error = new Error(type)
  Reflect.set(error, "type", type)
  Reflect.set(error, "statusCode", type === "o1_code_wrong_agent" ? 400 : 502)
  return error
}
