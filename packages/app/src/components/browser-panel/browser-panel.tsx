import { BrowserButton, BrowserIconButton } from "./browser-native-controls"

import { Icon } from "@opencode-ai/ui/icon"
import { Tooltip, TooltipKeybind } from "@opencode-ai/ui/tooltip"
import {
  createComputed,
  createEffect,
  createMemo,
  createRoot,
  createUniqueId,
  For,
  onCleanup,
  onMount,
  Show,
} from "solid-js"
import { createStore, reconcile } from "solid-js/store"
import { useLanguage } from "@/context/language"
import { usePrompt } from "@/context/prompt"
import { usePlatform } from "@/context/platform"
import {
  browserShortcut,
  browserShortcutHint,
  type BrowserCommand,
  type BrowserShortcut,
  type BrowserTab,
  type BrowserTabs,
} from "@/browser-panel"
import { showToast } from "@/utils/toast"
import {
  formatBrowserElementContext,
  formatBrowserSelectionContext,
  formatBrowserUrlContext,
  resolveBrowserAddress,
} from "./browser-context"
import { addImage, appendText, imagePart } from "./browser-actions"
import { browserViewportBounds } from "./browser-viewport"
import {
  BrowserAccounts,
  BrowserDeviceToolbar,
  BrowserMenu,
  BrowserTools,
  type BrowserToolPanel,
} from "./browser-tools"
import { browserSuggestions } from "./browser-suggestions"
import { BrowserOperationStatus } from "./browser-operation-status"
import "./browser-panel.css"
import "./browser-toolbar.css"
import "./browser-controls.css"
import "./browser-records.css"

export function BrowserPanel(props: {
  sessionKey: string
  sessionID: string
  onTabShortcut?: (value: BrowserShortcut) => void
}) {
  const language = useLanguage()
  const prompt = usePrompt()
  const platform = usePlatform()
  const browser = platform.browserPanel!
  const [state, setState] = createStore({
    tabs: { sessionID: props.sessionID, tabs: [] } as BrowserTabs,
    input: "",
    selecting: false,
    addressFocused: false,
    suggestionIndex: -1,
    suggestionsClosed: false,
    tool: undefined as BrowserToolPanel | undefined,
  })
  const active = createMemo(() => state.tabs.tabs.find((tab) => tab.id === state.tabs.activeID))
  const landing = createMemo(() => !active() || active()?.url === "about:blank")
  const bookmarked = () => !!active() && !!state.tabs.profile?.bookmarks?.some((row) => row.url === active()?.url)
  // First blocking reason wins; mirrors the pill's disabled condition.
  const agentHint = (tab: BrowserTab) =>
    language.t(
      state.tabs.profile?.preferences?.agentEnabled === false
        ? "browser.access.off"
        : tab.agentAccess
          ? "browser.site.agentOn"
          : !tab.access
            ? "browser.access.unknown"
            : tab.access.blank
              ? "browser.access.blank"
              : tab.loading
                ? "browser.access.tabGrantLoading"
                : "browser.access.tabGrantEligible",
    )
  const suggestions = createMemo(() => browserSuggestions(state.input, state.tabs))
  const suggestionsID = createUniqueId()
  const showSuggestions = () => state.addressFocused && !state.suggestionsClosed && !!suggestions().length
  let viewport!: HTMLDivElement
  let address: HTMLInputElement | undefined
  let disposed = false
  let navigationSequence = 0
  let navigationEpoch = 0
  const navigationRevision = new Map<string, number>()
  const pendingNavigation = new Set<string>()
  let opening: { sessionID: string; promise: Promise<BrowserTabs> } | undefined
  const fail = () => showToast({ variant: "error", title: language.t("browser.toast.failed") })
  const accept = (next: BrowserTabs) => {
    if (disposed || next.sessionID !== props.sessionID) return
    if (next.revision !== undefined && state.tabs.revision !== undefined && next.revision < state.tabs.revision) return
    for (const tabID of pendingNavigation) {
      if (!next.tabs.some((tab) => tab.id === tabID)) invalidateNavigation(tabID)
    }
    setState("tabs", reconcile(next))
  }
  const acceptCommand = (next: BrowserTabs) => {
    if (disposed || next.sessionID !== props.sessionID) return
    if (next.revision !== undefined && state.tabs.revision !== undefined && next.revision < state.tabs.revision) return
    const protectedTabs = state.tabs.tabs.filter((tab) => pendingNavigation.has(tab.id))
    setState(
      "tabs",
      reconcile({
        ...next,
        tabs: [
          ...next.tabs.map((tab) =>
            pendingNavigation.has(tab.id) ? (protectedTabs.find((item) => item.id === tab.id) ?? tab) : tab,
          ),
          ...protectedTabs.filter((tab) => !next.tabs.some((item) => item.id === tab.id)),
        ],
      }),
    )
  }
  const invalidateNavigation = (tabID: string) => {
    navigationRevision.set(tabID, ++navigationSequence)
    pendingNavigation.delete(tabID)
  }
  const command = (value: BrowserCommand) => {
    const sessionID = props.sessionID
    if (
      value.op === "stop" ||
      value.op === "reload" ||
      value.op === "back" ||
      value.op === "forward" ||
      value.op === "close"
    )
      invalidateNavigation(value.tabID)
    if (value.op === "close-tabs") {
      const index = state.tabs.tabs.findIndex((tab) => tab.id === value.tabID)
      const closing =
        value.scope === "others"
          ? state.tabs.tabs.filter((tab) => tab.id !== value.tabID)
          : state.tabs.tabs.slice(index + 1)
      closing.forEach((tab) => invalidateNavigation(tab.id))
    }
    return browser
      .command(sessionID, value)
      .then((next) => {
        acceptCommand(next)
        return true
      })
      .catch((error: unknown) => {
        if (!disposed && sessionID === props.sessionID)
          showToast({
            variant: "error",
            title: language.t("browser.toast.failed"),
            description: error instanceof Error ? error.message.slice(0, 512) : undefined,
          })
        return false
      })
  }
  const openTab = (sessionID: string) => {
    if (opening?.sessionID === sessionID) return opening.promise
    const promise = browser.command(sessionID, { op: "new" })
    opening = { sessionID, promise }
    return promise.finally(() => {
      if (opening?.promise === promise) opening = undefined
    })
  }
  let accountRevision = 0
  createEffect(() => {
    props.sessionID
    active()?.id
    active()?.url
    active()?.revision
    active()?.loading
    active()?.agentAccess
    state.tabs.profile?.vaultStatus
    state.tabs.profile?.vaultAvailable
    accountRevision++
  })
  let attachPage: () => Promise<void> = async () => {
    throw new Error("Browser viewport unavailable")
  }
  const fillAccount = async (value: BrowserCommand) => {
    if (value.op !== "fill-login") return
    const sessionID = props.sessionID
    const revision = accountRevision
    try {
      // Finish menu disposal, then require an acknowledged visible viewport, not a frame delay.
      await Promise.resolve()
      await attachPage()
      if (
        disposed ||
        revision !== accountRevision ||
        sessionID !== props.sessionID ||
        active()?.id !== value.tabID ||
        active()?.revision !== value.revision ||
        active()?.loading ||
        active()?.agentAccess ||
        state.tabs.profile?.vaultStatus !== "unlocked" ||
        !state.tabs.profile.vaultAvailable
      )
        return
      accept(await browser.command(sessionID, value))
    } catch {
      if (!disposed) fail()
    }
  }
  const shortcut = (value: BrowserShortcut) => {
    if (value === "address") {
      address?.focus()
      address?.select()
      return
    }
    if (props.onTabShortcut && (value === "new" || value === "close" || value === "next" || value === "previous"))
      return props.onTabShortcut(value)
    if (value === "new" || value === "reopen") {
      void command({ op: value })
      return
    }
    if (value === "find") {
      setState("tool", "find")
      return
    }
    const tab = active()
    if (!tab) return
    if (value === "close" || value === "reload" || value === "print") {
      void command({ op: value, tabID: tab.id })
      return
    }
    const index = state.tabs.tabs.findIndex((entry) => entry.id === tab.id)
    const next = (index + (value === "next" ? 1 : -1) + state.tabs.tabs.length) % state.tabs.tabs.length
    void command({ op: "select", tabID: state.tabs.tabs[next].id })
  }

  createEffect(() => {
    const id = active()?.id
    if (!landing()) return
    queueMicrotask(() => {
      if (!disposed && active()?.id === id && viewport?.checkVisibility()) address?.focus()
    })
  })

  createEffect(() => {
    const tab = active()
    setState("input", tab?.url === "about:blank" ? "" : tab?.url || "")
  })
  createEffect(() => {
    const sessionID = props.sessionID
    navigationEpoch++
    navigationRevision.clear()
    pendingNavigation.clear()
    opening = undefined
    setState("tabs", reconcile({ sessionID, tabs: [] }))
    void browser
      .command(sessionID, { op: "state" })
      .then(accept)
      .catch(() => {
        if (!disposed && sessionID === props.sessionID) fail()
      })
  })

  onMount(() => {
    const unsubscribe = browser.subscribe(accept)
    // Optional during renderer hot reload when the running preload predates shortcuts.
    const unsubscribeShortcuts = browser.onShortcut?.((input) => {
      if (input.sessionID === props.sessionID) shortcut(input.shortcut)
    })
    let last = ""
    let sentAt = 0
    let pending = 0
    let frame = 0
    let previousSession = props.sessionID
    const lease = crypto.randomUUID()
    attachPage = async () => {
      const sessionID = props.sessionID
      const bounds = landing() || state.tool === "settings" ? null : browserViewportBounds(viewport)
      if (disposed || !bounds) throw new Error("Browser viewport unavailable")
      await browser.viewport({ sessionID, lease, bounds })
    }
    const update = () => {
      const sessionID = props.sessionID
      if (previousSession !== sessionID) {
        void browser.viewport({ sessionID: previousSession, lease, bounds: null }).catch(() => undefined)
        previousSession = sessionID
      }
      const bounds = landing() || state.tool === "settings" ? null : browserViewportBounds(viewport)
      const key = JSON.stringify({ sessionID, bounds })
      // Main clears its viewport on native resize, which can arrive after our last
      // measurement. Renew visible bounds so unchanged geometry cannot strand a tab.
      // Recompute visibility first: never renew a page behind a dialog or hidden panel.
      if (key !== last || (bounds && !pending && performance.now() - sentAt >= 1000)) {
        last = key
        sentAt = performance.now()
        pending++
        void browser
          .viewport({ sessionID, lease, bounds })
          .catch(() => {
            last = ""
          })
          .finally(() => {
            pending--
          })
      }
      frame = requestAnimationFrame(update)
    }
    frame = requestAnimationFrame(update)
    const resize = () => {
      last = ""
    }
    window.addEventListener("resize", resize)
    onCleanup(() => {
      disposed = true
      cancelAnimationFrame(frame)
      window.removeEventListener("resize", resize)
      unsubscribe()
      unsubscribeShortcuts?.()
      void browser.viewport({ sessionID: previousSession, lease, bounds: null }).catch(() => undefined)
    })
  })

  const go = async (input = state.input) => {
    const url = resolveBrowserAddress(input, state.tabs.profile?.preferences?.searchEngine)
    if (!url) {
      showToast({
        variant: "error",
        title: language.t("browser.toast.invalidUrl.title"),
        description: language.t("browser.toast.invalidUrl.description"),
      })
      return
    }
    const sessionID = props.sessionID
    const epoch = navigationEpoch
    const request = ++navigationSequence
    const requestedTabID = active()?.id
    setState("suggestionsClosed", true)
    let tabID = requestedTabID
    try {
      const tabs = requestedTabID ? state.tabs : await openTab(sessionID)
      if (disposed || sessionID !== props.sessionID || epoch !== navigationEpoch) return
      tabID ??= tabs.activeID
      if (!tabID) throw new Error("Browser tab not found")
      if ((navigationRevision.get(tabID) ?? 0) > request) return
      if (!requestedTabID) acceptCommand(tabs)
      navigationRevision.set(tabID, request)
      pendingNavigation.add(tabID)
      const next = await browser.command(sessionID, { op: "navigate", tabID, url })
      if (navigationRevision.get(tabID) !== request) return
      pendingNavigation.delete(tabID)
      const updated = next.tabs.find((tab) => tab.id === tabID)
      const current = state.tabs
      if (!updated || current.sessionID !== sessionID) return
      setState("tabs", reconcile({ ...current, tabs: current.tabs.map((tab) => (tab.id === tabID ? updated : tab)) }))
    } catch {
      if (
        !disposed &&
        sessionID === props.sessionID &&
        epoch === navigationEpoch &&
        (!tabID || navigationRevision.get(tabID) === request)
      ) {
        if (tabID) pendingNavigation.delete(tabID)
        fail()
      }
    }
  }

  const chooseSuggestion = (index: number) => {
    const row = suggestions()[index]
    if (!row) return
    setState("suggestionsClosed", true)
    if (row.tabID) {
      void command({ op: "select", tabID: row.tabID })
      return
    }
    setState("input", row.url)
    void go(row.url)
  }

  const trackCapture = (current: () => boolean) =>
    createRoot((dispose) => {
      let obsolete = false
      // ponytail: latch each capture synchronously; returning to its tab must not revive it.
      createComputed(() => {
        obsolete ||= !current()
      })
      return { current: () => !obsolete && current(), dispose }
    })

  const selection = async () => {
    const tab = active()
    if (!tab || state.selecting) return
    const page = { url: tab.url, title: tab.title }
    const sessionID = props.sessionID
    const revision = tab.revision
    const tabID = tab.id
    const { current, dispose } = trackCapture(
      () =>
        !disposed &&
        props.sessionID === sessionID &&
        active()?.id === tabID &&
        active()?.revision === revision &&
        active()?.url === page.url,
    )
    const target = prompt.capture()
    const captured = { capture: () => target }
    const attachScreenshot = async () => {
      if (!current() || !state.tabs.profile?.preferences?.selectionScreenshots) return
      const part = imagePart(await browser.screenshot(sessionID, tabID))
      if (current() && part) addImage(captured, part)
    }
    setState("selecting", true)
    try {
      const text = formatBrowserSelectionContext(page, await browser.selection(sessionID, tabID))
      if (!current()) return
      if (text) {
        appendText(captured, text)
        await attachScreenshot()
        return
      }
      showToast({
        title: language.t("browser.toast.selectionMode.title"),
        description: language.t("browser.toast.selectionMode.description"),
      })
      const picked = await browser.pick(sessionID, tabID)
      if (!current()) return
      const context = formatBrowserElementContext(page, picked)
      if (context) {
        appendText(captured, context)
        await attachScreenshot()
      }
    } catch {
      if (current()) fail()
    } finally {
      dispose()
      if (!disposed) setState("selecting", false)
    }
  }

  const screenshot = async (closed?: Promise<void>) => {
    const tab = active()
    if (!tab) return
    const sessionID = props.sessionID
    const tabID = tab.id
    const revision = tab.revision
    const url = tab.url
    const { current, dispose } = trackCapture(
      () =>
        !disposed &&
        props.sessionID === sessionID &&
        active()?.id === tabID &&
        active()?.revision === revision &&
        active()?.url === url &&
        !active()?.loading,
    )
    const target = prompt.capture()
    try {
      // Menu cleanup, then acknowledged native attachment, must precede the capture epoch.
      await closed
      if (!current()) return
      await attachPage()
      if (!current()) return
      const part = imagePart(await browser.screenshot(sessionID, tabID))
      if (!current()) return
      if (!part) throw new Error("Invalid screenshot")
      addImage({ capture: () => target }, part)
    } catch {
      if (current()) showToast({ variant: "error", title: language.t("browser.toast.screenshotFailed.title") })
    } finally {
      dispose()
    }
  }

  return (
    <div
      data-component="browser-panel"
      class="size-full flex flex-col overflow-hidden bg-background-base"
      onKeyDown={(event) => {
        const action = browserShortcut(event)
        if (!action) return
        event.preventDefault()
        event.stopPropagation()
        shortcut(action)
      }}
    >
      <form
        data-slot="browser-toolbar"
        class="shrink-0 flex items-center border-b border-border-weaker-base py-2"
        onSubmit={(event) => {
          event.preventDefault()
          void go()
        }}
      >
        <Tooltip placement="top" flip={false} class="shrink-0" value={language.t("browser.action.back")}>
          <BrowserIconButton
            type="button"
            icon="arrow-left"
            variant="ghost"
            disabled={!active()?.canGoBack}
            aria-label={language.t("browser.action.back")}
            onClick={() => {
              const tab = active()
              if (tab) void command({ op: "back", tabID: tab.id })
            }}
          />
        </Tooltip>
        <Tooltip placement="top" flip={false} class="shrink-0" value={language.t("browser.action.forward")}>
          <BrowserIconButton
            type="button"
            icon="arrow-right"
            variant="ghost"
            disabled={!active()?.canGoForward}
            aria-label={language.t("browser.action.forward")}
            onClick={() => {
              const tab = active()
              if (tab) void command({ op: "forward", tabID: tab.id })
            }}
          />
        </Tooltip>
        <TooltipKeybind
          placement="top"
          flip={false}
          class="shrink-0"
          contentClass="browser-tooltip"
          title={language.t(active()?.loading ? "browser.action.stop" : "browser.action.reload")}
          keybind={active()?.loading ? "" : browserShortcutHint("reload", platform.os === "macos", language.t)}
        >
          <BrowserIconButton
            type="button"
            icon={active()?.loading ? "stop" : "reset"}
            disabled={!active()}
            variant="ghost"
            aria-label={language.t(active()?.loading ? "browser.action.stop" : "browser.action.reload")}
            onClick={() => {
              const tab = active()
              if (tab) void command({ op: tab.loading ? "stop" : "reload", tabID: tab.id })
            }}
          />
        </TooltipKeybind>
        <div
          data-slot="browser-address"
          class="min-w-0 flex-1 h-7 flex items-center gap-0.5 rounded-md border border-border-weak-base bg-background-base px-0.5 focus-within:border-text-interactive-base"
        >
          <Tooltip placement="top" flip={false} class="shrink-0" value={language.t("browser.menu.site")}>
            <BrowserIconButton
              type="button"
              icon={
                active()?.connection === "https"
                  ? "lock"
                  : active()?.connection === "http" || active()?.connection === "error"
                    ? "warning"
                    : "globe"
              }
              variant="ghost"
              class="shrink-0 h-6 w-6"
              data-browser-site
              disabled={landing() || !active()?.connection}
              aria-label={language.t("browser.menu.site")}
              aria-expanded={state.tool === "site"}
              onClick={() => setState("tool", state.tool === "site" ? undefined : "site")}
            />
          </Tooltip>
          <input
            ref={address}
            dir="ltr"
            role="combobox"
            autocomplete="off"
            aria-autocomplete="list"
            aria-expanded={showSuggestions()}
            aria-controls={suggestionsID}
            aria-activedescendant={
              showSuggestions() && state.suggestionIndex >= 0 ? `${suggestionsID}-${state.suggestionIndex}` : undefined
            }
            onKeyDown={(event) => {
              if (event.isComposing) return
              if (event.key === "Escape") {
                event.preventDefault()
                event.stopPropagation()
                setState("suggestionsClosed", true)
                return
              }
              if (!showSuggestions()) return
              if (event.key === "ArrowDown" || event.key === "ArrowUp") {
                event.preventDefault()
                setState("suggestionIndex", (index) =>
                  index < 0
                    ? event.key === "ArrowDown"
                      ? 0
                      : suggestions().length - 1
                    : (index + (event.key === "ArrowDown" ? 1 : -1) + suggestions().length) % suggestions().length,
                )
              }
              if (event.key === "Enter" && state.suggestionIndex >= 0) {
                event.preventDefault()
                chooseSuggestion(state.suggestionIndex)
              }
            }}
            class="min-w-0 flex-1 h-full bg-transparent px-1 text-12-regular text-text-base outline-none"
            value={
              !state.addressFocused &&
              state.tabs.profile?.preferences?.showFullURL === false &&
              state.input === active()?.url &&
              /^https?:/.test(state.input)
                ? new URL(state.input).origin
                : state.input
            }
            onFocus={() => setState({ addressFocused: true, suggestionsClosed: false, suggestionIndex: -1 })}
            onBlur={() => setState("addressFocused", false)}
            onInput={(event) =>
              setState({ input: event.currentTarget.value, suggestionsClosed: false, suggestionIndex: -1 })
            }
            placeholder={language.t("browser.address.searchPlaceholder", {
              engine: language.t(`browser.search.${state.tabs.profile?.preferences?.searchEngine ?? "duckduckgo"}`),
            })}
            aria-label={language.t("browser.address.label")}
          />
          <BrowserAccounts tab={active()} tabs={state.tabs} command={fillAccount} />
          <Show when={state.addressFocused && !!state.input.trim()}>
            <Tooltip placement="top" flip={false} class="shrink-0" value={language.t("common.open")}>
              <BrowserIconButton
                type="submit"
                icon="enter"
                variant="ghost"
                class="shrink-0 h-6 w-6"
                aria-label={language.t("common.open")}
                // Keep focus in the field so blur does not unmount the hint before the click lands.
                onMouseDown={(event) => event.preventDefault()}
              />
            </Tooltip>
          </Show>
          <Tooltip
            placement="top"
            flip={false}
            class="shrink-0"
            value={language.t(bookmarked() ? "browser.bookmarks.saved" : "browser.bookmarks.add")}
          >
            <BrowserIconButton
              type="button"
              icon={bookmarked() ? "star-filled" : "star"}
              variant="ghost"
              class="shrink-0 h-6 w-6"
              data-browser-bookmark
              disabled={landing() || !state.tabs.profile?.bookmarks}
              aria-pressed={bookmarked()}
              aria-label={language.t(bookmarked() ? "browser.bookmarks.saved" : "browser.bookmarks.add")}
              onClick={() => {
                const tab = active()
                if (!tab) return
                if (bookmarked()) {
                  setState("tool", "bookmarks")
                  return
                }
                void command({ op: "bookmark-save", url: tab.url, title: tab.title, pinned: false })
              }}
            />
          </Tooltip>
        </div>
        <Show when={!landing() && active()}>
          {(tab) => (
            <>
              <Tooltip placement="top" flip={false} class="shrink-0" value={language.t("browser.action.addUrl")}>
                <BrowserIconButton
                  type="button"
                  icon="link"
                  variant="ghost"
                  class="shrink-0"
                  aria-label={language.t("browser.action.addUrl")}
                  onClick={() => appendText(prompt, formatBrowserUrlContext(tab()))}
                />
              </Tooltip>
              <Tooltip placement="top" flip={false} class="shrink-0" value={language.t("browser.action.addSelection")}>
                <BrowserIconButton
                  type="button"
                  icon="window-cursor"
                  variant="ghost"
                  class="shrink-0"
                  disabled={state.selecting}
                  aria-pressed={state.selecting}
                  aria-label={language.t("browser.action.addSelection")}
                  onClick={() => void selection()}
                />
              </Tooltip>
              <Tooltip placement="top" flip={false} class="shrink-0" value={language.t("browser.action.addScreenshot")}>
                <BrowserIconButton
                  type="button"
                  icon="photo"
                  variant="ghost"
                  class="shrink-0"
                  aria-label={language.t("browser.action.addScreenshot")}
                  onClick={() => void screenshot()}
                />
              </Tooltip>
              <Tooltip placement="top" flip={false} class="shrink-0" value={agentHint(tab())}>
                <BrowserButton
                  type="button"
                  size="small"
                  variant={tab().agentAccess ? "primary" : "ghost"}
                  class="shrink-0"
                  data-browser-agent
                  aria-pressed={tab().agentAccess}
                  disabled={
                    state.tabs.profile?.preferences?.agentEnabled === false ||
                    (!tab().agentAccess && (tab().loading || tab().access?.blank !== false))
                  }
                  aria-description={agentHint(tab())}
                  onClick={() => void command({ op: "access", tabID: tab().id, enabled: !tab().agentAccess })}
                >
                  {language.t("browser.access.title")}
                </BrowserButton>
              </Tooltip>
            </>
          )}
        </Show>
        <div class="flex justify-end shrink-0">
          <BrowserMenu
            tab={active()}
            open={(tool) => setState("tool", tool)}
            command={command}
            screenshot={(closed) => void screenshot(closed)}
          />
        </div>
      </form>
      <Show when={showSuggestions()}>
        <div
          id={suggestionsID}
          role="listbox"
          aria-label={language.t("browser.address.suggestions")}
          data-slot="browser-suggestions"
          class="shrink-0 max-h-56 overflow-y-auto border-b border-border-weaker-base p-2"
        >
          <For each={suggestions()}>
            {(row, index) => (
              <button
                type="button"
                role="option"
                id={`${suggestionsID}-${index()}`}
                aria-selected={state.suggestionIndex === index()}
                tabIndex={-1}
                data-slot="browser-suggestion"
                class="block w-full text-start rounded px-2 py-1 text-12-regular"
                classList={{ "bg-background-stronger": state.suggestionIndex === index() }}
                onMouseDown={(event) => event.preventDefault()}
                onClick={() => chooseSuggestion(index())}
              >
                <span class="block truncate" dir={row.title ? "auto" : "ltr"}>
                  {row.title || row.url}
                </span>
                <span class="block truncate text-text-weak" dir="ltr">
                  {language.t(`browser.address.${row.kind}`, { url: row.url })}
                </span>
              </button>
            )}
          </For>
        </div>
      </Show>
      <Show when={!landing() && active()?.agentAccess && active()}>
        {(tab) => (
          <div
            role="status"
            data-browser-agent-strip
            class="shrink-0 flex items-center gap-2 border-b border-border-weaker-base bg-surface-interactive-weak px-2 py-1 text-12-regular text-text-base"
          >
            <span class="size-1.5 shrink-0 rounded-full bg-icon-interactive-base" aria-hidden="true" />
            <span class="min-w-0 truncate">{language.t("browser.site.agentOn")}</span>
            <span class="min-w-0 flex-1 truncate text-text-weak" dir="ltr">
              {URL.parse(tab().url)?.host}
            </span>
            <BrowserButton
              type="button"
              size="small"
              variant="ghost"
              class="shrink-0"
              onClick={() => void command({ op: "access", tabID: tab().id, enabled: false })}
            >
              {language.t("browser.site.revoke")}
            </BrowserButton>
          </div>
        )}
      </Show>
      <Show when={active()}>{(tab) => <BrowserOperationStatus tab={tab()} command={command} />}</Show>
      <Show when={active()?.loadFailed && !active()?.failure}>
        <div role="alert" class="shrink-0 p-2 text-12-regular text-text-base">
          {active()?.loadError ?? language.t("browser.toast.loadFailed")}
        </div>
      </Show>
      <Show when={state.tool}>
        {(tool) => (
          <BrowserTools
            panel={tool()}
            tab={active()}
            tabs={state.tabs}
            command={command}
            close={() => setState("tool", undefined)}
            open={(tool) => setState("tool", tool)}
          />
        )}
      </Show>
      <Show when={active()?.device && active()}>
        {(tab) => <BrowserDeviceToolbar tab={tab()} presets={state.tabs.profile?.devicePresets} command={command} />}
      </Show>
      {/* The native page covers the viewport's own box, so the accent sits just outside it. */}
      <Show when={!landing() && active()?.agentAccess && state.tool !== "settings"}>
        <div aria-hidden="true" class="shrink-0 h-0.5 bg-icon-interactive-base" />
      </Show>
      {/* Keep the rectangular native view above the panel's 10px rounded bottom corners. */}
      <div
        ref={viewport}
        class="min-h-0 flex-1 mb-2.5"
        classList={{ hidden: state.tool === "settings", "overflow-y-auto": landing() }}
      >
        <Show when={landing()}>
          <div
            data-slot="browser-landing"
            class="min-h-full flex flex-col items-center justify-center gap-3 px-6 py-8 text-center"
          >
            <Icon name="globe" size="large" class="text-text-weak mb-1" />
            <h2 class="text-16-medium text-text-strong">{language.t("browser.landing.title")}</h2>
            <p class="text-12-regular text-text-weak">
              {language.t("browser.landing.description", {
                engine: language.t(`browser.search.${state.tabs.profile?.preferences?.searchEngine ?? "duckduckgo"}`),
              })}
            </p>
            <div class="flex flex-wrap justify-center gap-2 max-w-2xl">
              <For each={state.tabs.profile?.bookmarks?.filter((row) => row.pinned)}>
                {(row) => (
                  <BrowserButton
                    size="small"
                    variant="secondary"
                    title={row.url}
                    onClick={() => {
                      setState("input", row.url)
                      void go(row.url)
                    }}
                  >
                    {row.title}
                  </BrowserButton>
                )}
              </For>
            </div>
            <BrowserButton size="small" variant="ghost" onClick={() => setState("tool", "bookmarks")}>
              {language.t("browser.menu.bookmarks")}
            </BrowserButton>
          </div>
        </Show>
      </div>
      <Show when={state.tabs.downloads?.length}>
        <div
          role="status"
          data-slot="browser-downloads"
          class="shrink-0 max-h-24 overflow-y-auto border-t border-border-weaker-base px-2 py-1 text-12-regular text-text-base"
        >
          <For each={state.tabs.downloads}>
            {(download) => (
              <div class="truncate" title={download.filename}>
                {language.t(`browser.download.${download.state}`, { filename: download.filename })}
              </div>
            )}
          </For>
        </div>
      </Show>
    </div>
  )
}
