import { Button } from "@opencode-ai/ui/button"
import { IconButton } from "@opencode-ai/ui/icon-button"
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
  browserTabKeyIndex,
  type BrowserCommand,
  type BrowserShortcut,
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
  BrowserTabMenu,
  BrowserTools,
  type BrowserToolPanel,
} from "./browser-tools"
import { browserSuggestions } from "./browser-suggestions"

export function BrowserPanel(props: { sessionKey: string; sessionID: string }) {
  const language = useLanguage()
  const prompt = usePrompt()
  const browser = usePlatform().browserPanel!
  const [state, setState] = createStore({
    tabs: { sessionID: props.sessionID, tabs: [] } as BrowserTabs,
    input: "",
    selecting: false,
    opening: false,
    addressFocused: false,
    suggestionIndex: -1,
    suggestionsClosed: false,
    tool: undefined as BrowserToolPanel | undefined,
  })
  const active = createMemo(() => state.tabs.tabs.find((tab) => tab.id === state.tabs.activeID))
  const landing = createMemo(() => !active() || active()?.url === "about:blank")
  const suggestions = createMemo(() => browserSuggestions(state.input, state.tabs))
  const suggestionsID = createUniqueId()
  const showSuggestions = () => state.addressFocused && !state.suggestionsClosed && !!suggestions().length
  let viewport!: HTMLDivElement
  let address: HTMLInputElement | undefined
  let disposed = false
  const fail = () => showToast({ variant: "error", title: language.t("browser.toast.failed") })
  const accept = (next: BrowserTabs) => {
    if (!disposed && next.sessionID === props.sessionID) setState("tabs", reconcile(next))
  }
  const command = (value: BrowserCommand) =>
    browser
      .command(props.sessionID, value)
      .then((next) => {
        accept(next)
        return true
      })
      .catch(() => {
        fail()
        return false
      })
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
    setState("tabs", { sessionID, tabs: [] })
    void browser.command(sessionID, { op: "state" }).then(accept).catch(fail)
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
    if (state.opening) return
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
    setState("suggestionsClosed", true)
    setState("opening", true)
    try {
      const tabs = active() ? state.tabs : await browser.command(sessionID, { op: "new" })
      if (disposed || sessionID !== props.sessionID) return
      accept(tabs)
      if (!tabs.activeID) throw new Error("Browser tab not found")
      accept(await browser.command(sessionID, { op: "navigate", tabID: tabs.activeID, url }))
    } catch {
      if (!disposed && sessionID === props.sessionID) fail()
    } finally {
      if (!disposed) setState("opening", false)
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
      class="size-full flex flex-col overflow-hidden bg-background-base"
      onKeyDown={(event) => {
        const action = browserShortcut(event)
        if (!action) return
        event.preventDefault()
        event.stopPropagation()
        shortcut(action)
      }}
    >
      <div class="shrink-0 flex items-center border-b border-border-weaker-base bg-background-stronger px-1">
        <div class="flex flex-1 min-w-0 overflow-x-auto" role="tablist" aria-label={language.t("browser.tabs.label")}>
          <For each={state.tabs.tabs}>
            {(tab) => (
              <div
                class="flex items-center min-w-0 shrink-0 max-w-48 border-r border-border-weaker-base"
                classList={{ "bg-background-base": tab.id === state.tabs.activeID }}
              >
                <button
                  type="button"
                  role="tab"
                  aria-selected={tab.id === state.tabs.activeID}
                  aria-label={`${tab.title || (tab.url === "about:blank" ? language.t("browser.tabs.new") : tab.url)}${tab.pinned ? `, ${language.t("browser.tabs.pinned")}` : ""}`}
                  tabIndex={tab.id === state.tabs.activeID ? 0 : -1}
                  class="truncate px-3 py-2 text-12-regular text-text-base"
                  title={tab.url}
                  onClick={() => void command({ op: "select", tabID: tab.id })}
                  onKeyDown={(event) => {
                    const index = state.tabs.tabs.findIndex((entry) => entry.id === tab.id)
                    const next = browserTabKeyIndex(event.key, index, state.tabs.tabs.length)
                    if (next === undefined) return
                    event.preventDefault()
                    const buttons = event.currentTarget
                      .closest('[role="tablist"]')
                      ?.querySelectorAll<HTMLButtonElement>('[role="tab"]')
                    buttons?.[next]?.focus()
                    void command({ op: "select", tabID: state.tabs.tabs[next].id })
                  }}
                >
                  <Show when={tab.pinned}>
                    <span aria-hidden="true">● </span>
                  </Show>
                  {tab.title || (tab.url === "about:blank" ? language.t("browser.tabs.new") : tab.url)}
                </button>
                <BrowserTabMenu tab={tab} tabs={state.tabs.tabs} command={command} />
                <IconButton
                  icon="close"
                  variant="ghost"
                  class="shrink-0 h-6 w-6"
                  aria-label={language.t("browser.tabs.close")}
                  title={language.t("browser.tabs.close")}
                  onClick={() => void command({ op: "close", tabID: tab.id })}
                />
              </div>
            )}
          </For>
        </div>
        <IconButton
          icon="plus"
          variant="ghost"
          class="shrink-0 h-7 w-7"
          aria-label={language.t("browser.tabs.new")}
          title={language.t("browser.tabs.new")}
          onClick={() => void command({ op: "new" })}
        />
        <BrowserMenu
          tab={active()}
          open={(tool) => setState("tool", tool)}
          command={command}
          screenshot={(closed) => void screenshot(closed)}
        />
      </div>
      <form
        class="shrink-0 flex flex-wrap items-center gap-1 border-b border-border-weaker-base px-2 py-2"
        onSubmit={(event) => {
          event.preventDefault()
          void go()
        }}
      >
        <IconButton
          type="button"
          icon="arrow-left"
          variant="ghost"
          disabled={!active()?.canGoBack}
          aria-label={language.t("browser.action.back")}
          title={language.t("browser.action.back")}
          onClick={() => {
            const tab = active()
            if (tab) void command({ op: "back", tabID: tab.id })
          }}
        />
        <IconButton
          type="button"
          icon="arrow-right"
          variant="ghost"
          disabled={!active()?.canGoForward}
          aria-label={language.t("browser.action.forward")}
          title={language.t("browser.action.forward")}
          onClick={() => {
            const tab = active()
            if (tab) void command({ op: "forward", tabID: tab.id })
          }}
        />
        <IconButton
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
        <input
          ref={address}
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
          class="min-w-20 flex-1 h-7 rounded-md border border-border-weak-base bg-background-base px-2 text-12-regular text-text-base"
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
        <Button
          type="button"
          size="small"
          variant="ghost"
          disabled={landing() || !active()?.connection}
          onClick={() => setState("tool", state.tool === "site" ? undefined : "site")}
        >
          {language.t("browser.menu.site")}
        </Button>
        <Button
          type="button"
          size="small"
          variant="ghost"
          disabled={landing() || !state.tabs.profile?.bookmarks}
          onClick={() => {
            const tab = active()
            if (!tab) return
            if (state.tabs.profile?.bookmarks?.some((row) => row.url === tab.url)) {
              setState("tool", "bookmarks")
              return
            }
            void command({ op: "bookmark-save", url: tab.url, title: tab.title, pinned: false })
          }}
        >
          {language.t(
            state.tabs.profile?.bookmarks?.some((row) => row.url === active()?.url)
              ? "browser.bookmarks.saved"
              : "browser.bookmarks.add",
          )}
        </Button>
        <Button type="submit" size="small" variant="secondary" disabled={state.opening || !state.input.trim()}>
          {language.t("common.open")}
        </Button>
      </form>
      <Show when={showSuggestions()}>
        <div
          id={suggestionsID}
          role="listbox"
          aria-label={language.t("browser.address.suggestions")}
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
                class="block w-full text-left rounded px-2 py-1 text-12-regular"
                classList={{ "bg-background-stronger": state.suggestionIndex === index() }}
                onMouseDown={(event) => event.preventDefault()}
                onClick={() => chooseSuggestion(index())}
              >
                <span class="block truncate">{row.title || row.url}</span>
                <span class="block truncate text-text-weak">
                  {language.t(`browser.address.${row.kind}`, { url: row.url })}
                </span>
              </button>
            )}
          </For>
        </div>
      </Show>
      <Show when={!landing() && active()}>
        {(tab) => (
          <div class="contents">
            <div class="shrink-0 flex flex-wrap items-center gap-1 border-b border-border-weaker-base px-2 py-1">
              <Button size="small" variant="ghost" onClick={() => appendText(prompt, formatBrowserUrlContext(tab()))}>
                {language.t("browser.action.addUrl")}
              </Button>
              <Button
                size="small"
                variant={state.selecting ? "secondary" : "ghost"}
                disabled={state.selecting}
                onClick={() => void selection()}
              >
                {language.t("browser.action.addSelection")}
              </Button>
              <Button size="small" variant="ghost" onClick={() => void screenshot()}>
                {language.t("browser.action.addScreenshot")}
              </Button>
              <label class="flex items-center gap-1 text-12-regular text-text-base">
                <input
                  type="checkbox"
                  checked={tab().agentAccess}
                  disabled={state.tabs.profile?.preferences?.agentEnabled === false}
                  onChange={(event) => {
                    const enabled = event.currentTarget.checked
                    event.currentTarget.checked = tab().agentAccess
                    void command({ op: "access", tabID: tab().id, enabled })
                  }}
                />
                {language.t("browser.tabs.access")}
              </label>
            </div>
          </div>
        )}
      </Show>
      <Show when={active()?.loadFailed}>
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
      <div
        ref={viewport}
        class="min-h-0 flex-1"
        classList={{ hidden: state.tool === "settings", "overflow-y-auto": landing() }}
      >
        <Show when={landing()}>
          <div class="min-h-full flex flex-col items-center justify-center gap-3 px-6 py-8 text-center">
            <svg
              width="28"
              height="28"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              stroke-width="1.5"
              aria-hidden="true"
              class="text-text-weak mb-1"
            >
              <circle cx="12" cy="12" r="9" />
              <ellipse cx="12" cy="12" rx="4" ry="9" />
              <path d="M3 12h18" />
            </svg>
            <h2 class="text-16-medium text-text-strong">{language.t("browser.landing.title")}</h2>
            <p class="text-12-regular text-text-weak">
              {language.t("browser.landing.description", {
                engine: language.t(`browser.search.${state.tabs.profile?.preferences?.searchEngine ?? "duckduckgo"}`),
              })}
            </p>
            <div class="flex flex-wrap justify-center gap-2 max-w-2xl">
              <For each={state.tabs.profile?.bookmarks?.filter((row) => row.pinned)}>
                {(row) => (
                  <Button
                    size="small"
                    variant="secondary"
                    title={row.url}
                    onClick={() => {
                      setState("input", row.url)
                      void go(row.url)
                    }}
                  >
                    {row.title}
                  </Button>
                )}
              </For>
            </div>
            <Button size="small" variant="ghost" onClick={() => setState("tool", "bookmarks")}>
              {language.t("browser.menu.bookmarks")}
            </Button>
          </div>
        </Show>
      </div>
      <div class="shrink-0 px-2 py-1 text-12-regular text-text-weak">{language.t("browser.tabs.profile")}</div>
      <Show when={state.tabs.downloads?.length}>
        <div
          role="status"
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
