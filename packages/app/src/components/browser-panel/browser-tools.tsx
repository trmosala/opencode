import { Button } from "@opencode-ai/ui/button"
import { IconButton } from "@opencode-ai/ui/icon-button"
import { DropdownMenu } from "@opencode-ai/ui/dropdown-menu"
import { createEffect, For, onCleanup, Show } from "solid-js"
import { createStore } from "solid-js/store"
import { useLanguage } from "@/context/language"
import type { BrowserCommand, BrowserTab, BrowserTabs, BrowserClearKind, BrowserClearRange } from "@/browser-panel"
import { BrowserSettings } from "./browser-settings"
import { BrowserLibrary } from "./browser-library"
import { BrowserSite } from "./browser-site"

export type BrowserToolPanel =
  | "find"
  | "zoom"
  | "import"
  | "passwords"
  | "downloads"
  | "history"
  | "clear"
  | "settings"
  | "bookmarks"
  | "site"

export function BrowserMenu(props: {
  tab?: BrowserTab
  open(panel: BrowserToolPanel): void
  command(command: BrowserCommand): Promise<unknown>
  screenshot(): void
}) {
  const language = useLanguage()
  return (
    <DropdownMenu>
      <DropdownMenu.Trigger
        as={IconButton}
        type="button"
        icon="dot-grid"
        variant="ghost"
        aria-label={language.t("browser.menu.label")}
      />
      <DropdownMenu.Portal>
        <DropdownMenu.Content>
          <DropdownMenu.Item disabled={!props.tab} onSelect={() => props.open("find")}>
            <DropdownMenu.ItemLabel>{language.t("browser.menu.find")}</DropdownMenu.ItemLabel>
          </DropdownMenu.Item>
          <DropdownMenu.Item
            disabled={!props.tab}
            onSelect={() => props.tab && void props.command({ op: "print", tabID: props.tab.id })}
          >
            <DropdownMenu.ItemLabel>{language.t("browser.menu.print")}</DropdownMenu.ItemLabel>
          </DropdownMenu.Item>
          <DropdownMenu.Item disabled={!props.tab} onSelect={() => props.open("zoom")}>
            <DropdownMenu.ItemLabel>{language.t("browser.menu.zoom")}</DropdownMenu.ItemLabel>
          </DropdownMenu.Item>
          <DropdownMenu.Separator />
          <DropdownMenu.Item
            disabled={!props.tab}
            onSelect={() =>
              props.tab && void props.command({ op: "device", tabID: props.tab.id, enabled: !props.tab.device })
            }
          >
            <DropdownMenu.ItemLabel>
              {language.t(props.tab?.device ? "browser.menu.deviceOff" : "browser.menu.device")}
            </DropdownMenu.ItemLabel>
          </DropdownMenu.Item>
          <DropdownMenu.Item disabled={!props.tab} onSelect={() => props.screenshot()}>
            <DropdownMenu.ItemLabel>{language.t("browser.menu.screenshot")}</DropdownMenu.ItemLabel>
          </DropdownMenu.Item>
          <DropdownMenu.Separator />
          <DropdownMenu.Item onSelect={() => void props.command({ op: "reopen" })}>
            <DropdownMenu.ItemLabel>{language.t("browser.tabs.reopen")}</DropdownMenu.ItemLabel>
          </DropdownMenu.Item>
          <For each={["import", "passwords", "downloads", "history", "bookmarks", "clear", "settings"] as const}>
            {(panel) => (
              <DropdownMenu.Item onSelect={() => props.open(panel)}>
                <DropdownMenu.ItemLabel>{language.t(`browser.menu.${panel}`)}</DropdownMenu.ItemLabel>
              </DropdownMenu.Item>
            )}
          </For>
        </DropdownMenu.Content>
      </DropdownMenu.Portal>
    </DropdownMenu>
  )
}

export function BrowserTools(props: {
  panel: BrowserToolPanel
  tab?: BrowserTab
  tabs: BrowserTabs
  command(command: BrowserCommand): Promise<unknown>
  close(): void
  open(panel: BrowserToolPanel): void
}) {
  const language = useLanguage()
  const [state, setState] = createStore({
    query: "",
    accountOrigin: "",
    busy: false,
    range: "all" as BrowserClearRange,
    kinds: ["history"] as BrowserClearKind[],
  })
  const matches = (value: string) => value.toLowerCase().includes(state.query.trim().toLowerCase())
  let search: HTMLInputElement | undefined
  const run = async (command: BrowserCommand) => {
    if (state.busy) return
    setState("busy", true)
    try {
      return await props.command(command)
    } finally {
      setState("busy", false)
    }
  }
  const find = (next = false, forward = true) =>
    props.tab && void props.command({ op: "find", tabID: props.tab.id, text: state.query, next, forward })
  createEffect(() => {
    props.tab?.id
    props.panel
    setState("query", "")
  })
  createEffect(() => {
    const id = props.tab?.id
    if (props.panel !== "find" || !id) return
    queueMicrotask(() => search?.focus())
    onCleanup(() => {
      if (props.tabs.tabs.some((tab) => tab.id === id)) void props.command({ op: "find", tabID: id, text: "" })
    })
  })
  const close = () => {
    props.close()
  }
  return (
    <section
      class={`${props.panel === "settings" ? "flex-1 min-h-0 p-6" : "shrink-0 max-h-64 p-2"} overflow-y-auto border-b border-border-weaker-base text-12-regular text-text-base`}
      aria-label={language.t(`browser.menu.${props.panel}`)}
      onKeyDown={(event) => {
        if (event.key !== "Escape") return
        event.stopPropagation()
        close()
      }}
    >
      <div class="flex items-center justify-between mb-2">
        <strong>{language.t(`browser.menu.${props.panel}`)}</strong>
        <IconButton icon="close" variant="ghost" aria-label={language.t("browser.tools.close")} onClick={close} />
      </div>
      <Show when={props.panel === "find"}>
        <form
          class="flex items-center gap-2"
          onSubmit={(event) => {
            event.preventDefault()
            find(true)
          }}
        >
          <input
            ref={search}
            class="min-w-20 flex-1 border border-border-weak-base rounded px-2 py-1"
            aria-label={language.t("browser.menu.find")}
            maxLength={512}
            value={state.query}
            onInput={(event) => {
              setState("query", event.currentTarget.value)
              find()
            }}
          />
          <span role="status">
            {language.t("browser.find.matches", {
              active: props.tab?.find?.active ?? 0,
              matches: props.tab?.find?.matches ?? 0,
            })}
          </span>
          <Button type="button" size="small" variant="ghost" onClick={() => find(true, false)}>
            {language.t("browser.find.previous")}
          </Button>
          <Button type="submit" size="small" variant="ghost">
            {language.t("browser.find.next")}
          </Button>
        </form>
      </Show>
      <Show when={props.panel === "zoom" && props.tab}>
        <div class="flex items-center gap-2">
          <Button
            size="small"
            disabled={(props.tab?.zoom ?? 1) <= 0.5}
            onClick={() =>
              props.tab &&
              void run({ op: "zoom", tabID: props.tab.id, factor: Math.max(0.5, (props.tab.zoom ?? 1) - 0.1) })
            }
          >
            {language.t("browser.zoom.out")}
          </Button>
          <span>{language.t("browser.zoom.percent", { percent: Math.round((props.tab?.zoom ?? 1) * 100) })}</span>
          <Button
            size="small"
            disabled={(props.tab?.zoom ?? 1) >= 3}
            onClick={() =>
              props.tab &&
              void run({ op: "zoom", tabID: props.tab.id, factor: Math.min(3, (props.tab.zoom ?? 1) + 0.1) })
            }
          >
            {language.t("browser.zoom.in")}
          </Button>
          <Button size="small" onClick={() => props.tab && void run({ op: "zoom", tabID: props.tab.id, factor: 1 })}>
            {language.t("browser.zoom.reset")}
          </Button>
        </div>
      </Show>
      <Show when={props.panel === "import"}>
        <p class="mb-2">{language.t("browser.import.help")}</p>
        <div class="flex gap-2">
          <Button
            size="small"
            disabled={
              state.busy || !props.tabs.profile?.vaultAvailable || props.tabs.profile.vaultStatus !== "unlocked"
            }
            onClick={() => void run({ op: "import", kind: "passwords" })}
          >
            {language.t("browser.import.passwords")}
          </Button>
          <Show when={props.tabs.profile?.vaultStatus !== "unlocked"}>
            <Button
              size="small"
              disabled={
                state.busy || !props.tabs.profile?.vaultAvailable || props.tabs.profile?.vaultStatus !== "locked"
              }
              onClick={() => void run({ op: "unlock-vault" })}
            >
              {language.t("browser.passwords.unlock")}
            </Button>
          </Show>
          <Button size="small" disabled={state.busy} onClick={() => void run({ op: "import", kind: "cookies" })}>
            {language.t("browser.import.cookies")}
          </Button>
        </div>
      </Show>
      <Show when={props.panel === "passwords"}>
        <p class="mb-2">{language.t("browser.passwords.help")}</p>
        <p class="mb-2">{language.t("browser.passwords.steps")}</p>
        <p class="mb-2" role="status">
          {language.t(
            props.tabs.profile?.vaultStatus === "unlocked"
              ? "browser.passwords.unlockedStatus"
              : props.tabs.profile?.vaultStatus === "unlocking"
                ? "browser.passwords.unlockingStatus"
                : props.tabs.profile?.vaultStatus === "locked"
                  ? "browser.passwords.lockedStatus"
                  : "browser.tools.nextLaunch",
          )}
        </p>
        <Show
          when={props.tabs.profile?.vaultStatus === "unlocked" || props.tabs.profile?.vaultStatus === "unlocking"}
          fallback={
            <Button
              size="small"
              disabled={
                state.busy || !props.tabs.profile?.vaultAvailable || props.tabs.profile?.vaultStatus !== "locked"
              }
              onClick={() => void run({ op: "unlock-vault" })}
            >
              {language.t("browser.passwords.unlock")}
            </Button>
          }
        >
          <Button size="small" onClick={() => void props.command({ op: "lock-vault" })}>
            {language.t("browser.passwords.lock")}
          </Button>
        </Show>
        <Show when={props.tabs.profile && !props.tabs.profile.vaultAvailable}>
          <p role="status">{language.t("browser.passwords.locked")}</p>
        </Show>
        <Button
          size="small"
          disabled={
            state.busy ||
            !props.tab ||
            props.tab.agentAccess ||
            !props.tabs.profile?.vaultAvailable ||
            props.tabs.profile.vaultStatus !== "unlocked"
          }
          onClick={() => props.tab && void run({ op: "save-login", tabID: props.tab.id })}
        >
          {language.t("browser.passwords.save")}
        </Button>
        <Show when={props.tabs.profile?.vaultStatus === "unlocked"}>
          <p class="my-2 text-text-weak">{language.t("browser.passwords.entryHelp")}</p>
          <Show when={props.tabs.profile?.loginEntryAvailable}>
            <form
              class="flex gap-2 my-2"
              onSubmit={(event) => {
                event.preventDefault()
                void run({ op: "edit-login", origin: state.accountOrigin })
              }}
            >
              <input
                type="url"
                required
                maxLength={2048}
                value={state.accountOrigin}
                aria-label={language.t("browser.settings.origin")}
                placeholder="https://example.com"
                class="min-w-0 flex-1 border border-border-weak-base rounded px-2 py-1"
                onInput={(event) => setState("accountOrigin", event.currentTarget.value)}
              />
              <Button type="submit" size="small" disabled={state.busy}>
                {language.t("browser.passwords.create")}
              </Button>
            </form>
          </Show>
          <input
            type="search"
            value={state.query}
            aria-label={language.t("browser.passwords.search")}
            placeholder={language.t("browser.passwords.search")}
            class="w-full border border-border-weak-base rounded px-2 py-1 my-2"
            onInput={(event) => setState("query", event.currentTarget.value)}
          />
        </Show>
        <For
          each={
            props.tabs.profile?.vaultStatus === "unlocked"
              ? props.tabs.profile.credentials.filter((login) => matches(`${login.origin} ${login.username}`))
              : []
          }
          fallback={
            <Show when={props.tabs.profile?.vaultStatus === "unlocked" && props.tabs.profile.vaultAvailable}>
              <p class="mt-2">{language.t(state.query ? "browser.records.noMatches" : "browser.passwords.empty")}</p>
            </Show>
          }
        >
          {(login) => (
            <div class="flex flex-wrap items-center gap-2 border-t border-border-weaker-base py-2 mt-1">
              <div class="min-w-0 flex-1">
                <div class="truncate" title={login.origin}>
                  {login.origin}
                </div>
                <div class="truncate">{login.username}</div>
              </div>
              <Button
                size="small"
                disabled={
                  state.busy ||
                  !props.tab ||
                  props.tab.agentAccess ||
                  !props.tabs.profile?.vaultAvailable ||
                  new URL(props.tab.url).origin !== login.origin
                }
                onClick={() => props.tab && void run({ op: "fill-login", tabID: props.tab.id, id: login.id })}
              >
                {language.t("browser.passwords.fill")}
              </Button>
              <For each={["username", "password"] as const}>
                {(field) => (
                  <Button
                    size="small"
                    variant="ghost"
                    disabled={
                      state.busy ||
                      !props.tab ||
                      props.tab.agentAccess ||
                      !props.tabs.profile?.vaultAvailable ||
                      new URL(props.tab.url).origin !== login.origin
                    }
                    onClick={() =>
                      props.tab && void run({ op: "fill-login", tabID: props.tab.id, id: login.id, field })
                    }
                  >
                    {language.t(
                      field === "username" ? "browser.passwords.fillUsername" : "browser.passwords.fillPassword",
                    )}
                  </Button>
                )}
              </For>
              <Show when={props.tabs.profile?.loginEntryAvailable}>
                <Button
                  size="small"
                  variant="ghost"
                  disabled={state.busy}
                  onClick={() => void run({ op: "edit-login", origin: login.origin, id: login.id })}
                >
                  {language.t("browser.passwords.edit")}
                </Button>
              </Show>
              <Button
                size="small"
                variant="ghost"
                disabled={state.busy}
                onClick={() => void run({ op: "forget-login", id: login.id })}
              >
                {language.t("browser.passwords.delete")}
              </Button>
            </div>
          )}
        </For>
      </Show>
      <Show when={!props.tabs.profile}>
        <p role="status">{language.t("browser.tools.nextLaunch")}</p>
      </Show>
      <Show when={props.panel === "history"}>
        <input
          type="search"
          class="w-full border border-border-weak-base rounded px-2 py-1 mb-2"
          aria-label={language.t("browser.history.search")}
          placeholder={language.t("browser.history.search")}
          value={state.query}
          onInput={(event) => setState("query", event.currentTarget.value)}
        />
        <p class="mb-2 text-text-weak">{language.t("browser.history.retention")}</p>
        <For
          each={props.tabs.profile?.history.filter((entry) => matches(`${entry.title} ${entry.url}`))}
          fallback={<p>{language.t(state.query ? "browser.records.noMatches" : "browser.history.empty")}</p>}
        >
          {(entry) => (
            <div class="flex items-center gap-2 border-t border-border-weaker-base">
              <button
                type="button"
                class="block text-left truncate min-w-0 flex-1 py-1"
                title={entry.url}
                disabled={state.busy || !entry.id}
                onClick={() => entry.id && void run({ op: "open-history", id: entry.id })}
              >
                {entry.title || entry.url}
                <span class="block truncate text-text-weak">{entry.url}</span>
                <time class="block text-text-weak" dateTime={new Date(entry.time).toISOString()}>
                  {language.formatDate(entry.time)}
                </time>
              </button>
              <Button
                size="small"
                variant="ghost"
                disabled={state.busy || !entry.id}
                onClick={() => entry.id && void run({ op: "forget-history", id: entry.id })}
              >
                {language.t("browser.records.remove")}
              </Button>
            </div>
          )}
        </For>
        <Show when={props.tabs.recentlyClosed?.length}>
          <h3 class="mt-3 mb-1">{language.t("browser.tabs.recentlyClosed")}</h3>
          <p class="text-text-weak">{language.t("browser.tabs.recoveryHelp")}</p>
          <For each={props.tabs.recentlyClosed?.filter((entry) => matches(`${entry.title} ${entry.url}`))}>
            {(entry) => (
              <button
                type="button"
                class="block text-left w-full truncate py-1"
                disabled={state.busy}
                title={entry.url}
                onClick={() => void run({ op: "reopen", id: entry.id })}
              >
                {entry.title || entry.url}
              </button>
            )}
          </For>
        </Show>
      </Show>
      <Show when={props.panel === "downloads"}>
        <input
          type="search"
          class="w-full border border-border-weak-base rounded px-2 py-1 mb-2"
          aria-label={language.t("browser.download.search")}
          placeholder={language.t("browser.download.search")}
          value={state.query}
          onInput={(event) => setState("query", event.currentTarget.value)}
        />
        <p class="mb-2 text-text-weak">{language.t("browser.download.retention")}</p>
        <For
          each={props.tabs.downloads?.filter((entry) => matches(entry.filename))}
          fallback={<p>{language.t(state.query ? "browser.records.noMatches" : "browser.download.historyEmpty")}</p>}
        >
          {(entry) => (
            <div class="flex flex-wrap items-center justify-between gap-2 py-1">
              <div class="min-w-0 flex-1" role="status">
                {language.t(entry.paused ? "browser.download.paused" : `browser.download.${entry.state}`, {
                  filename: entry.filename,
                })}
                <Show when={entry.time}>
                  {(time) => (
                    <time class="block text-text-weak" dateTime={new Date(time()).toISOString()}>
                      {language.formatDate(time())}
                    </time>
                  )}
                </Show>
                <Show when={entry.received !== undefined}>
                  <p>
                    {language.t(entry.total ? "browser.download.progress" : "browser.download.received", {
                      received: ((entry.received ?? 0) / 1_000_000).toFixed(2),
                      total: ((entry.total ?? 0) / 1_000_000).toFixed(2),
                    })}
                  </p>
                </Show>
                <Show when={entry.canControl && entry.total}>
                  <progress
                    class="w-full"
                    aria-label={language.t("browser.menu.downloads")}
                    value={entry.received ?? 0}
                    max={entry.total}
                  />
                </Show>
              </div>
              <Show when={entry.canControl}>
                <Button
                  size="small"
                  disabled={state.busy}
                  onClick={() =>
                    void run({ op: "download-control", id: entry.id, action: entry.paused ? "resume" : "pause" })
                  }
                >
                  {language.t(entry.paused ? "browser.download.resume" : "browser.download.pause")}
                </Button>
                <Button
                  size="small"
                  disabled={state.busy}
                  onClick={() => void run({ op: "download-control", id: entry.id, action: "cancel" })}
                >
                  {language.t("browser.download.cancel")}
                </Button>
              </Show>
              <Show when={entry.canReveal}>
                <Button size="small" variant="ghost" onClick={() => void run({ op: "reveal-download", id: entry.id })}>
                  {language.t("browser.download.reveal")}
                </Button>
              </Show>
              <Show when={entry.state !== "saving"}>
                <Button
                  size="small"
                  variant="ghost"
                  disabled={state.busy}
                  onClick={() => void run({ op: "forget-download", id: entry.id })}
                >
                  {language.t("browser.records.remove")}
                </Button>
              </Show>
            </div>
          )}
        </For>
      </Show>
      <Show when={props.panel === "clear"}>
        <p class="mb-2">{language.t("browser.clear.scope")}</p>
        <fieldset disabled={state.busy} class="space-y-2">
          <label class="flex items-center gap-2">
            {language.t("browser.clear.range")}
            <select
              value={state.range}
              onChange={(event) => {
                const range = event.currentTarget.value as BrowserClearRange
                setState("range", range)
                if (range !== "all")
                  setState(
                    "kinds",
                    state.kinds.filter((kind) => kind === "history" || kind === "downloads"),
                  )
              }}
            >
              <For each={["hour", "day", "week", "month", "all"] as const}>
                {(range) => <option value={range}>{language.t(`browser.clear.${range}`)}</option>}
              </For>
            </select>
          </label>
          <For each={["history", "cache", "cookies", "passwords", "downloads"] as const}>
            {(kind) => (
              <label class="flex items-center gap-2">
                <input
                  type="checkbox"
                  checked={state.kinds.includes(kind)}
                  disabled={state.range !== "all" && kind !== "history" && kind !== "downloads"}
                  onChange={(event) =>
                    setState(
                      "kinds",
                      event.currentTarget.checked
                        ? [...state.kinds, kind]
                        : state.kinds.filter((value) => value !== kind),
                    )
                  }
                />
                {language.t(`browser.clear.${kind}`)}
              </label>
            )}
          </For>
          <Button
            size="small"
            disabled={!state.kinds.length}
            onClick={() => void run({ op: "clear-selected", kinds: [...state.kinds], range: state.range })}
          >
            {language.t("browser.clear.submit")}
          </Button>
        </fieldset>
      </Show>
      <Show when={props.panel === "settings" && props.tabs.profile}>
        {(profile) => <BrowserSettings profile={profile()} busy={state.busy} command={run} open={props.open} />}
      </Show>
      <Show when={props.panel === "bookmarks" && props.tabs.profile?.bookmarks}>
        {(bookmarks) => <BrowserLibrary bookmarks={bookmarks()} busy={state.busy} command={run} />}
      </Show>
      <Show when={props.panel === "bookmarks" && !props.tabs.profile?.bookmarks}>
        <p>{language.t("browser.tools.nextLaunch")}</p>
      </Show>
      <Show when={props.panel === "site" && props.tab && props.tabs.profile && /^https?:/.test(props.tab.url)}>
        <BrowserSite tab={props.tab!} profile={props.tabs.profile!} busy={state.busy} command={run} />
      </Show>
      <Show when={state.busy}>
        <p role="status" class="mt-2">
          {language.t("browser.tools.busy")}
        </p>
      </Show>
    </section>
  )
}
