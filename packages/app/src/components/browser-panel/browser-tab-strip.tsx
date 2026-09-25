import { DropdownMenu } from "@opencode-ai/ui/dropdown-menu"
import { Icon } from "@opencode-ai/ui/icon"
import { IconButton } from "@opencode-ai/ui/icon-button"
import { createEffect, For, onCleanup, onMount, Show, type JSX } from "solid-js"
import { browserTabKeyIndex, type BrowserCommand, type BrowserTab, type BrowserTabs } from "@/browser-panel"
import { useLanguage } from "@/context/language"
import { BrowserTabMenu } from "./browser-tools"
import "./browser-tab-strip.css"

export function BrowserTabStrip(props: {
  tabs: BrowserTabs
  command: (command: BrowserCommand) => Promise<unknown>
  children?: JSX.Element
}) {
  const language = useLanguage()
  let strip!: HTMLDivElement
  let add!: HTMLButtonElement
  const title = (tab: BrowserTab) => tab.title || (tab.url === "about:blank" ? language.t("browser.tabs.new") : tab.url)
  const reveal = () =>
    strip
      .querySelector('[data-slot="browser-tab"][data-active="true"]')
      ?.scrollIntoView({ block: "nearest", inline: "nearest" })

  createEffect(() => {
    props.tabs.activeID
    props.tabs.tabs.map((tab) => `${tab.id}:${tab.pinned}`).join(",")
    queueMicrotask(() => {
      if (strip.isConnected) reveal()
    })
  })
  onMount(() => {
    const observer = new ResizeObserver(reveal)
    observer.observe(strip)
    onCleanup(() => observer.disconnect())
  })

  const close = async (tabID: string) => {
    const focused = document.activeElement
    const restore = focused instanceof HTMLElement && strip.contains(focused)
    await props.command({ op: "close", tabID })
    // Main may refuse a close via beforeunload. Never move focus in that case,
    // or steal it if the user moved elsewhere while the native dialog was open.
    if (!restore || focused.isConnected || !strip.isConnected) return
    if (document.activeElement && document.activeElement !== document.body) return
    const selected = strip.querySelector<HTMLButtonElement>('[role="tab"][aria-selected="true"]')
    ;(selected ?? add).focus()
  }

  return (
    <div data-component="browser-tab-strip">
      <div ref={strip} data-slot="browser-tab-list" role="tablist" aria-label={language.t("browser.tabs.label")}>
        <For each={props.tabs.tabs}>
          {(tab) => (
            <div
              data-slot="browser-tab"
              data-active={tab.id === props.tabs.activeID}
              data-pinned={tab.pinned}
              role="presentation"
            >
              <button
                type="button"
                role="tab"
                aria-selected={tab.id === props.tabs.activeID}
                aria-busy={tab.loading}
                aria-label={title(tab)}
                aria-description={tab.pinned ? language.t("browser.tabs.pinned") : undefined}
                tabIndex={tab.id === props.tabs.activeID ? 0 : -1}
                data-slot="browser-tab-select"
                title={`${title(tab)}\n${tab.url}`}
                onClick={() => void props.command({ op: "select", tabID: tab.id })}
                onMouseDown={(event) => {
                  if (event.button === 1) event.preventDefault()
                }}
                onAuxClick={(event) => {
                  if (event.button !== 1) return
                  event.preventDefault()
                  void close(tab.id)
                }}
                onKeyDown={(event) => {
                  if (event.isComposing || event.altKey || event.ctrlKey || event.metaKey || event.shiftKey) return
                  if (event.key === "Delete") {
                    event.preventDefault()
                    event.stopPropagation()
                    void close(tab.id)
                    return
                  }
                  const next = browserTabKeyIndex(
                    event.key,
                    props.tabs.tabs.findIndex((entry) => entry.id === tab.id),
                    props.tabs.tabs.length,
                    getComputedStyle(strip).direction === "rtl" ? "rtl" : "ltr",
                  )
                  if (next === undefined) return
                  event.preventDefault()
                  event.stopPropagation()
                  strip.querySelectorAll<HTMLButtonElement>('[role="tab"]')[next]?.focus()
                  void props.command({ op: "select", tabID: props.tabs.tabs[next].id })
                }}
              >
                <span data-slot="browser-tab-icon" aria-hidden="true">
                  <Show when={!tab.loading} fallback={<span data-slot="browser-tab-spinner" />}>
                    <Show when={!tab.loadFailed} fallback={<Icon name="warning" size="small" />}>
                      <Show when={tab.url !== "about:blank"} fallback={<Icon name="plus-small" size="small" />}>
                        <span data-slot="browser-tab-initial" dir="auto">
                          {Array.from(title(tab).trim())[0]}
                        </span>
                      </Show>
                    </Show>
                  </Show>
                </span>
                <span data-slot="browser-tab-title" dir="auto">
                  {title(tab)}
                </span>
                <Show when={tab.loadFailed}>
                  <span class="sr-only">{language.t("browser.toast.loadFailed")}</span>
                </Show>
              </button>
              <div data-slot="browser-tab-actions">
                <BrowserTabMenu tab={tab} tabs={props.tabs.tabs} command={props.command} />
              </div>
              <Show when={!tab.pinned}>
                <IconButton
                  icon="close-small"
                  variant="ghost"
                  data-slot="browser-tab-close"
                  aria-label={language.t("browser.tabs.close")}
                  title={language.t("browser.tabs.close")}
                  onClick={() => void close(tab.id)}
                />
              </Show>
            </div>
          )}
        </For>
      </div>
      <div data-slot="browser-tab-controls">
        <IconButton
          ref={add}
          icon="plus-small"
          variant="ghost"
          aria-label={language.t("browser.tabs.new")}
          title={language.t("browser.tabs.new")}
          onClick={() => void props.command({ op: "new" })}
        />
        <DropdownMenu>
          <DropdownMenu.Trigger
            as={IconButton}
            type="button"
            icon="chevron-down"
            variant="ghost"
            disabled={!props.tabs.tabs.length}
            aria-label={language.t("browser.tabs.label")}
            title={language.t("browser.tabs.label")}
          />
          <DropdownMenu.Portal>
            <DropdownMenu.Content class="max-h-80 w-72 max-w-[calc(100vw-16px)] overflow-y-auto">
              <DropdownMenu.RadioGroup
                value={props.tabs.activeID ?? ""}
                onChange={(tabID) => {
                  if (typeof tabID === "string") void props.command({ op: "select", tabID })
                }}
              >
                <For each={props.tabs.tabs}>
                  {(tab) => (
                    <DropdownMenu.RadioItem value={tab.id} textValue={title(tab)}>
                      <DropdownMenu.ItemLabel class="min-w-0">
                        <span class="block truncate" dir="auto">
                          {title(tab)}
                        </span>
                        <span class="block truncate text-text-weak text-12-regular" dir="ltr">
                          {tab.url}
                        </span>
                      </DropdownMenu.ItemLabel>
                      <DropdownMenu.ItemIndicator>
                        <Icon name="check" size="small" />
                      </DropdownMenu.ItemIndicator>
                    </DropdownMenu.RadioItem>
                  )}
                </For>
              </DropdownMenu.RadioGroup>
            </DropdownMenu.Content>
          </DropdownMenu.Portal>
        </DropdownMenu>
        {props.children}
      </div>
    </div>
  )
}
