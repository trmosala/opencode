import { BrowserButton, BrowserIconButton, BrowserDropdownMenu } from "./browser-native-controls"
import { DropdownMenu } from "@opencode-ai/ui/dropdown-menu"
import { IconButton } from "@opencode-ai/ui/icon-button"

import { Icon } from "@opencode-ai/ui/icon"
import { Progress } from "@opencode-ai/ui/progress"
import { Tooltip } from "@opencode-ai/ui/tooltip"
import { usePlatform } from "@/context/platform"

import { Select } from "@opencode-ai/ui/select"
import { createEffect, createUniqueId, For, onCleanup, Show } from "solid-js"
import { createStore } from "solid-js/store"
import { useLanguage } from "@/context/language"
import type {
  BrowserCommand,
  BrowserDevicePreset,
  BrowserTab,
  BrowserTabs,
  BrowserClearKind,
  BrowserClearRange,
} from "@/browser-panel"
import {
  browserShortcutHint,
  browserDeviceSize,
  BROWSER_DEVICE_MIN,
  BROWSER_DEVICE_MAX,
  BROWSER_DEVICE_DEFAULT,
} from "@/browser-panel"
import { BrowserSettings } from "./browser-settings"
import { BrowserLibrary } from "./browser-library"
import { BrowserSite } from "./browser-site"
import { BrowserContacts } from "./browser-contacts"

export type BrowserToolPanel =
  | "find"
  | "zoom"
  | "import"
  | "passwords"
  | "contacts"
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
  screenshot(closed: Promise<void>): void
}) {
  const language = useLanguage()
  const platform = usePlatform()
  const icons = {
    import: "cloud-upload",
    passwords: "key",
    contacts: "bubble-5",
    downloads: "download",
    history: "archive",
    bookmarks: "star",
    clear: "trash",
    settings: "settings-gear",
  } as const
  let finishScreenshot: (() => void) | undefined
  onCleanup(() => finishScreenshot?.())
  return (
    <BrowserDropdownMenu>
      <Tooltip placement="top" flip={false} value={language.t("browser.menu.label")}>
        <BrowserDropdownMenu.Trigger
          data-browser-menu-trigger
          as={BrowserIconButton}
          type="button"
          icon="dot-grid"
          variant="ghost"
          aria-label={language.t("browser.menu.label")}
        />
      </Tooltip>
      <BrowserDropdownMenu.Portal>
        <BrowserDropdownMenu.Content
          data-browser-menu="browser"
          onCloseAutoFocus={() => {
            finishScreenshot?.()
            finishScreenshot = undefined
          }}
        >
          <BrowserDropdownMenu.Item
            disabled={!props.tab}
            onSelect={() => props.open("find")}
            shortcut={browserShortcutHint("find", platform.os === "macos", language.t)}
          >
            <Icon name="magnifying-glass" size="small" data-slot="dropdown-menu-item-icon" />
            <BrowserDropdownMenu.ItemLabel>{language.t("browser.menu.find")}</BrowserDropdownMenu.ItemLabel>
          </BrowserDropdownMenu.Item>
          <BrowserDropdownMenu.Item
            disabled={!props.tab}
            onSelect={() => props.tab && void props.command({ op: "print", tabID: props.tab.id })}
            shortcut={browserShortcutHint("print", platform.os === "macos", language.t)}
          >
            <Icon name="open-file" size="small" data-slot="dropdown-menu-item-icon" />
            <BrowserDropdownMenu.ItemLabel>{language.t("browser.menu.print")}</BrowserDropdownMenu.ItemLabel>
          </BrowserDropdownMenu.Item>
          <BrowserDropdownMenu.Item disabled={!props.tab} onSelect={() => props.open("zoom")}>
            <Icon name="expand" size="small" data-slot="dropdown-menu-item-icon" />
            <BrowserDropdownMenu.ItemLabel>{language.t("browser.menu.zoom")}</BrowserDropdownMenu.ItemLabel>
          </BrowserDropdownMenu.Item>
          <BrowserDropdownMenu.Separator />
          <BrowserDropdownMenu.Item
            disabled={!props.tab}
            onSelect={() =>
              props.tab && void props.command({ op: "device", tabID: props.tab.id, enabled: !props.tab.device })
            }
          >
            <Icon name="window-cursor" size="small" data-slot="dropdown-menu-item-icon" />
            <BrowserDropdownMenu.ItemLabel>
              {language.t(props.tab?.device ? "browser.menu.deviceOff" : "browser.menu.device")}
            </BrowserDropdownMenu.ItemLabel>
          </BrowserDropdownMenu.Item>
          <BrowserDropdownMenu.Item
            disabled={!props.tab}
            onSelect={() =>
              props.screenshot(
                new Promise<void>((resolve) => {
                  finishScreenshot = resolve
                }),
              )
            }
          >
            <Icon name="photo" size="small" data-slot="dropdown-menu-item-icon" />
            <BrowserDropdownMenu.ItemLabel>{language.t("browser.menu.screenshot")}</BrowserDropdownMenu.ItemLabel>
          </BrowserDropdownMenu.Item>
          <BrowserDropdownMenu.Separator />
          <BrowserDropdownMenu.Item
            onSelect={() => void props.command({ op: "reopen" })}
            shortcut={browserShortcutHint("reopen", platform.os === "macos", language.t)}
          >
            <Icon name="arrow-undo-down" size="small" data-slot="dropdown-menu-item-icon" />
            <BrowserDropdownMenu.ItemLabel>{language.t("browser.tabs.reopen")}</BrowserDropdownMenu.ItemLabel>
          </BrowserDropdownMenu.Item>
          <For
            each={
              ["import", "passwords", "contacts", "downloads", "history", "bookmarks", "clear", "settings"] as const
            }
          >
            {(panel) => (
              <BrowserDropdownMenu.Item onSelect={() => props.open(panel)}>
                <Icon name={icons[panel]} size="small" data-slot="dropdown-menu-item-icon" />
                <BrowserDropdownMenu.ItemLabel>{language.t(`browser.menu.${panel}`)}</BrowserDropdownMenu.ItemLabel>
              </BrowserDropdownMenu.Item>
            )}
          </For>
        </BrowserDropdownMenu.Content>
      </BrowserDropdownMenu.Portal>
    </BrowserDropdownMenu>
  )
}

export function BrowserTabMenu(props: {
  tab: BrowserTab
  tabs: BrowserTab[]
  activeID?: string
  command(command: BrowserCommand): Promise<unknown>
}) {
  const language = useLanguage()
  const siblings = () => props.tabs.filter((tab) => tab.pinned === props.tab.pinned)
  const position = () => siblings().findIndex((tab) => tab.id === props.tab.id)
  const index = () => props.tabs.findIndex((tab) => tab.id === props.tab.id)
  return (
    <DropdownMenu>
      <DropdownMenu.Trigger
        as={IconButton}
        type="button"
        icon="dot-grid"
        variant="ghost"
        class="shrink-0 h-6 w-6"
        aria-label={language.t("browser.tabs.actions")}
      />
      <DropdownMenu.Portal>
        <DropdownMenu.Content>
          <DropdownMenu.Item
            onSelect={() => void props.command({ op: "tab-pin", tabID: props.tab.id, pinned: !props.tab.pinned })}
          >
            <DropdownMenu.ItemLabel>
              {language.t(props.tab.pinned ? "browser.tabs.unpin" : "browser.tabs.pin")}
            </DropdownMenu.ItemLabel>
          </DropdownMenu.Item>
          <DropdownMenu.Item onSelect={() => void props.command({ op: "duplicate", tabID: props.tab.id })}>
            <DropdownMenu.ItemLabel>{language.t("browser.tabs.duplicate")}</DropdownMenu.ItemLabel>
          </DropdownMenu.Item>
          <DropdownMenu.Item
            disabled={position() <= 0}
            onSelect={() => void props.command({ op: "tab-move", tabID: props.tab.id, direction: "left" })}
          >
            <DropdownMenu.ItemLabel>{language.t("browser.tabs.moveLeft")}</DropdownMenu.ItemLabel>
          </DropdownMenu.Item>
          <DropdownMenu.Item
            disabled={position() < 0 || position() >= siblings().length - 1}
            onSelect={() => void props.command({ op: "tab-move", tabID: props.tab.id, direction: "right" })}
          >
            <DropdownMenu.ItemLabel>{language.t("browser.tabs.moveRight")}</DropdownMenu.ItemLabel>
          </DropdownMenu.Item>
          <DropdownMenu.Separator />
          <DropdownMenu.Item
            disabled={
              props.tab.id === props.activeID ||
              props.tab.pinned ||
              props.tab.loading ||
              props.tab.agentAccess ||
              props.tab.unloaded ||
              !!props.tab.operation
            }
            onSelect={() => void props.command({ op: "tab-unload", tabID: props.tab.id })}
          >
            <DropdownMenu.ItemLabel>{language.t("browser.tabs.unload")}</DropdownMenu.ItemLabel>
          </DropdownMenu.Item>
          <DropdownMenu.Item onSelect={() => void props.command({ op: "close", tabID: props.tab.id })}>
            <DropdownMenu.ItemLabel>{language.t("browser.tabs.close")}</DropdownMenu.ItemLabel>
          </DropdownMenu.Item>
          <DropdownMenu.Item
            disabled={!props.tabs.some((tab) => tab.id !== props.tab.id && !tab.pinned)}
            onSelect={() => void props.command({ op: "close-tabs", tabID: props.tab.id, scope: "others" })}
          >
            <DropdownMenu.ItemLabel>{language.t("browser.tabs.closeOthers")}</DropdownMenu.ItemLabel>
          </DropdownMenu.Item>
          <DropdownMenu.Item
            disabled={!props.tabs.slice(index() + 1).some((tab) => !tab.pinned)}
            onSelect={() => void props.command({ op: "close-tabs", tabID: props.tab.id, scope: "right" })}
          >
            <DropdownMenu.ItemLabel>{language.t("browser.tabs.closeRight")}</DropdownMenu.ItemLabel>
          </DropdownMenu.Item>
        </DropdownMenu.Content>
      </DropdownMenu.Portal>
    </DropdownMenu>
  )
}

export function BrowserDeviceToolbar(props: {
  tab: BrowserTab
  presets?: BrowserDevicePreset[]
  command(command: BrowserCommand): Promise<unknown>
}) {
  const language = useLanguage()
  const help = createUniqueId()
  const [state, setState] = createStore({ width: "", height: "", name: "", preset: "", busy: false })
  const customPreset = "__custom__"
  const current = () => props.tab.deviceSize ?? BROWSER_DEVICE_DEFAULT
  const size = () => browserDeviceSize({ width: Number(state.width), height: Number(state.height) })
  createEffect(() => {
    props.tab.id
    setState({ width: String(current().width), height: String(current().height) })
  })
  const apply = async (rotate = false) => {
    const value = size()
    if (state.busy || props.tab.loading || !props.tab.device || !props.tab.deviceSize || !value) return
    const command: BrowserCommand = {
      op: "device",
      tabID: props.tab.id,
      enabled: true,
      size: rotate ? { width: value.height, height: value.width } : value,
    }
    setState("busy", true)
    try {
      await props.command(command)
    } finally {
      setState("busy", false)
    }
  }
  return (
    <Show
      when={props.tab.deviceSize}
      fallback={
        <div class="shrink-0 px-2 py-1 text-12-regular text-text-weak">{language.t("browser.device.size")}</div>
      }
    >
      <form
        data-slot="browser-device-toolbar"
        class="shrink-0 max-h-48 overflow-y-auto border-b border-border-weaker-base px-2 py-1 text-12-regular text-text-base"
        aria-label={language.t("browser.menu.device")}
        onSubmit={(event) => {
          event.preventDefault()
          void apply()
        }}
      >
        <p role="status" class="mb-1">
          {language.t("browser.device.current", current())}
        </p>
        <fieldset class="flex flex-wrap items-center gap-2" disabled={state.busy || props.tab.loading}>
          <label class="flex items-center gap-1">
            {language.t("browser.device.preset")}
            <Select
              aria-label={language.t("browser.device.preset")}
              triggerProps={{ "aria-label": language.t("browser.device.preset") }}
              options={[customPreset, ...(props.presets ?? []).map((preset) => preset.id)]}
              current={state.preset || customPreset}
              disabled={state.busy || props.tab.loading}
              value={(id) => id}
              label={(id) =>
                id === customPreset
                  ? language.t("browser.device.custom")
                  : (props.presets?.find((preset) => preset.id === id)?.name ?? id)
              }
              onSelect={(id) => {
                if (id === undefined) return
                const preset = id === customPreset ? undefined : props.presets?.find((row) => row.id === id)
                setState("preset", preset?.id ?? "")
                if (!preset) return
                setState({ name: preset.name, width: String(preset.size.width), height: String(preset.size.height) })
                void props.command({ op: "device", tabID: props.tab.id, enabled: true, size: preset.size })
              }}
              variant="secondary"
              size="small"
            />
          </label>
          <For each={["width", "height"] as const}>
            {(axis) => (
              <label class="flex items-center gap-1">
                {language.t(`browser.device.${axis}`)}
                <input
                  type="number"
                  min={BROWSER_DEVICE_MIN}
                  max={BROWSER_DEVICE_MAX}
                  step={1}
                  required
                  aria-describedby={help}
                  class="w-20 border border-border-weak-base rounded px-2 py-1"
                  value={state[axis]}
                  onInput={(event) => {
                    setState(axis, event.currentTarget.value)
                    setState("preset", "")
                  }}
                />
              </label>
            )}
          </For>
          <BrowserButton type="submit" size="small" disabled={!size()}>
            {language.t("browser.device.apply")}
          </BrowserButton>
          <BrowserButton type="button" size="small" variant="ghost" disabled={!size()} onClick={() => void apply(true)}>
            {language.t("browser.device.rotate")}
          </BrowserButton>
          <label class="flex items-center gap-1">
            {language.t("browser.device.presetName")}
            <input
              class="w-36 border border-border-weak-base rounded px-2 py-1"
              value={state.name}
              maxLength={80}
              onInput={(event) => setState("name", event.currentTarget.value)}
            />
          </label>
          <BrowserButton
            type="button"
            size="small"
            disabled={!size() || !state.name.trim()}
            onClick={() => {
              const value = size()
              if (!value) return
              void props.command({
                op: "device-preset-save",
                id: state.preset || undefined,
                name: state.name,
                size: value,
              })
            }}
          >
            {language.t(state.preset ? "browser.device.updatePreset" : "browser.device.savePreset")}
          </BrowserButton>
          <BrowserButton
            type="button"
            size="small"
            variant="ghost"
            disabled={!state.preset}
            onClick={() => {
              if (!state.preset) return
              void props.command({ op: "device-preset-delete", id: state.preset })
              setState({ preset: "", name: "" })
            }}
          >
            {language.t("browser.device.deletePreset")}
          </BrowserButton>
          <BrowserButton
            type="button"
            size="small"
            variant="ghost"
            onClick={() => void props.command({ op: "device", tabID: props.tab.id, enabled: false })}
          >
            {language.t("browser.menu.deviceOff")}
          </BrowserButton>
        </fieldset>
        <p id={help} class="mt-1 text-text-weak">
          {language.t("browser.device.limits")}
        </p>
      </form>
    </Show>
  )
}

export function BrowserAccounts(props: {
  tab?: BrowserTab
  tabs: BrowserTabs
  command(command: BrowserCommand): Promise<unknown>
}) {
  const language = useLanguage()
  const [state, setState] = createStore({ open: false, busy: false })
  const accounts = () => {
    const tab = props.tab
    const profile = props.tabs.profile
    if (!tab || tab.loading || tab.agentAccess || !profile?.vaultAvailable || profile.vaultStatus !== "unlocked")
      return []
    const url = URL.parse(tab.url)
    if (!url || !["https:", "http:"].includes(url.protocol)) return []
    return profile.credentials.filter((login) => login.origin === url.origin)
  }
  createEffect(() => {
    props.tab?.id
    props.tab?.url
    props.tab?.revision
    props.tab?.loading
    props.tab?.agentAccess
    props.tabs.profile?.vaultStatus
    props.tabs.profile?.vaultAvailable
    setState("open", false)
  })
  const fill = async (id: string, field?: "username" | "password") => {
    const tab = props.tab
    if (state.busy || !state.open || !tab || !accounts().some((login) => login.id === id)) return
    const command: BrowserCommand = { op: "fill-login", tabID: tab.id, id, field, revision: tab.revision }
    setState({ open: false, busy: true })
    try {
      await props.command(command)
    } finally {
      setState("busy", false)
    }
  }
  return (
    <BrowserDropdownMenu open={state.open} onOpenChange={(open) => setState("open", open)}>
      {/* Stays mounted while hidden: smoke tests read its disabled state. */}
      <Tooltip
        inactive={!accounts().length}
        placement="top"
        flip={false}
        class="shrink-0"
        value={language.t("browser.menu.passwords")}
      >
        <BrowserDropdownMenu.Trigger
          as={BrowserIconButton}
          type="button"
          icon="key"
          variant="ghost"
          class="shrink-0 h-6 w-6"
          classList={{ hidden: !accounts().length }}
          data-account-selector
          disabled={state.busy || !accounts().length}
          aria-label={language.t("browser.menu.passwords")}
        />
      </Tooltip>
      <Show when={state.open}>
        <BrowserDropdownMenu.Portal>
          <BrowserDropdownMenu.Content
            data-browser-menu="accounts"
            class="max-h-80 max-w-[calc(100vw-16px)] overflow-y-auto"
          >
            <For each={accounts()}>
              {(login) => (
                <BrowserDropdownMenu.Group data-account-id={login.id}>
                  <BrowserDropdownMenu.GroupLabel class="break-all">{login.username}</BrowserDropdownMenu.GroupLabel>
                  <For each={["both", "username", "password"] as const}>
                    {(field) => (
                      <BrowserDropdownMenu.Item
                        data-field={field}
                        onSelect={() => void fill(login.id, field === "both" ? undefined : field)}
                      >
                        <Icon
                          name={field === "password" ? "lock" : "key"}
                          size="small"
                          data-slot="dropdown-menu-item-icon"
                        />
                        <BrowserDropdownMenu.ItemLabel>
                          {language.t(
                            field === "both"
                              ? "browser.passwords.fill"
                              : field === "username"
                                ? "browser.passwords.fillUsername"
                                : "browser.passwords.fillPassword",
                          )}
                        </BrowserDropdownMenu.ItemLabel>
                      </BrowserDropdownMenu.Item>
                    )}
                  </For>
                </BrowserDropdownMenu.Group>
              )}
            </For>
          </BrowserDropdownMenu.Content>
        </BrowserDropdownMenu.Portal>
      </Show>
    </BrowserDropdownMenu>
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
    generationLength: 20,
    generationSymbols: true,
    busy: false,
    range: "all" as BrowserClearRange,
    kinds: ["history"] as BrowserClearKind[],
  })
  const matches = (value: string) => value.toLowerCase().includes(state.query.trim().toLowerCase())
  let search: HTMLInputElement | undefined
  const run = async (command: BrowserCommand) => {
    // Revocation must not wait behind the consent it is cancelling.
    if (
      (command.op === "access" && !command.enabled) ||
      (command.op === "preferences" && command.values.agentEnabled === false)
    )
      return props.command(command)
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
      data-slot="browser-tools"
      data-browser-records={["passwords", "history", "downloads"].includes(props.panel) ? "" : undefined}
      class={`${props.panel === "settings" ? "flex-1 min-h-0 p-6" : "shrink-0 max-h-64 p-2"} overflow-y-auto border-b border-border-weaker-base text-12-regular text-text-base`}
      aria-label={language.t(`browser.menu.${props.panel}`)}
      onKeyDown={(event) => {
        if (event.key !== "Escape") return
        event.stopPropagation()
        close()
      }}
    >
      <div class="flex items-center justify-between mb-2">
        <h2 class="text-14-medium text-text-strong">{language.t(`browser.menu.${props.panel}`)}</h2>
        <BrowserIconButton
          icon="close"
          size="small"
          variant="ghost"
          aria-label={language.t("browser.tools.close")}
          onClick={close}
        />
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
          <BrowserButton type="button" size="small" variant="ghost" onClick={() => find(true, false)}>
            {language.t("browser.find.previous")}
          </BrowserButton>
          <BrowserButton type="submit" size="small" variant="ghost">
            {language.t("browser.find.next")}
          </BrowserButton>
        </form>
      </Show>
      <Show when={props.panel === "zoom" && props.tab}>
        <div class="flex items-center gap-2">
          <BrowserButton
            size="small"
            disabled={(props.tab?.zoom ?? 1) <= 0.5}
            onClick={() =>
              props.tab &&
              void run({ op: "zoom", tabID: props.tab.id, factor: Math.max(0.5, (props.tab.zoom ?? 1) - 0.1) })
            }
          >
            {language.t("browser.zoom.out")}
          </BrowserButton>
          <span>{language.t("browser.zoom.percent", { percent: Math.round((props.tab?.zoom ?? 1) * 100) })}</span>
          <BrowserButton
            size="small"
            disabled={(props.tab?.zoom ?? 1) >= 3}
            onClick={() =>
              props.tab &&
              void run({ op: "zoom", tabID: props.tab.id, factor: Math.min(3, (props.tab.zoom ?? 1) + 0.1) })
            }
          >
            {language.t("browser.zoom.in")}
          </BrowserButton>
          <BrowserButton
            size="small"
            onClick={() => props.tab && void run({ op: "zoom", tabID: props.tab.id, factor: 1 })}
          >
            {language.t("browser.zoom.reset")}
          </BrowserButton>
        </div>
      </Show>
      <Show when={props.panel === "import"}>
        <p class="mb-2">{language.t("browser.import.help")}</p>
        <div class="flex flex-wrap gap-2">
          <BrowserButton
            size="small"
            disabled={
              state.busy || !props.tabs.profile?.vaultAvailable || props.tabs.profile.vaultStatus !== "unlocked"
            }
            onClick={() => void run({ op: "import", kind: "passwords" })}
          >
            {language.t("browser.import.passwords")}
          </BrowserButton>
          <Show when={props.tabs.profile?.vaultStatus !== "unlocked"}>
            <BrowserButton
              size="small"
              disabled={
                state.busy || !props.tabs.profile?.vaultAvailable || props.tabs.profile?.vaultStatus !== "locked"
              }
              onClick={() => void run({ op: "unlock-vault" })}
            >
              {language.t("browser.passwords.unlock")}
            </BrowserButton>
          </Show>
          <BrowserButton size="small" disabled={state.busy} onClick={() => void run({ op: "import", kind: "cookies" })}>
            {language.t("browser.import.cookies")}
          </BrowserButton>
          <BrowserButton size="small" disabled={state.busy} onClick={() => void run({ op: "bookmark-import" })}>
            {language.t("browser.bookmarks.import")}
          </BrowserButton>
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
            <BrowserButton
              size="small"
              disabled={
                state.busy || !props.tabs.profile?.vaultAvailable || props.tabs.profile?.vaultStatus !== "locked"
              }
              onClick={() => void run({ op: "unlock-vault" })}
            >
              {language.t("browser.passwords.unlock")}
            </BrowserButton>
          }
        >
          <BrowserButton size="small" onClick={() => void props.command({ op: "lock-vault" })}>
            {language.t("browser.passwords.lock")}
          </BrowserButton>
        </Show>
        <Show when={props.tabs.profile && !props.tabs.profile.vaultAvailable}>
          <p role="status">{language.t("browser.passwords.locked")}</p>
        </Show>
        <BrowserButton
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
        </BrowserButton>
        <div class="flex flex-wrap gap-2 my-2">
          <BrowserButton
            size="small"
            disabled={
              state.busy ||
              !props.tabs.profile?.vaultAvailable ||
              !props.tabs.profile?.vaultBackupAvailable ||
              props.tabs.profile.vaultStatus !== "unlocked"
            }
            onClick={() => void run({ op: "vault-backup", direction: "export" })}
          >
            {language.t("browser.passwords.backupExport")}
          </BrowserButton>
          <BrowserButton
            size="small"
            disabled={
              state.busy ||
              !props.tabs.profile?.vaultAvailable ||
              !props.tabs.profile?.vaultBackupAvailable ||
              props.tabs.profile.vaultStatus !== "unlocked"
            }
            onClick={() => void run({ op: "vault-backup", direction: "import" })}
          >
            {language.t("browser.passwords.backupImport")}
          </BrowserButton>
          <p class="w-full text-text-weak">{language.t("browser.passwords.backupHelp")}</p>
        </div>
        <form
          class="flex flex-wrap items-center gap-2 my-2"
          onSubmit={(event) => {
            event.preventDefault()
            if (props.tab)
              void run({
                op: "generate-password",
                tabID: props.tab.id,
                length: state.generationLength,
                symbols: state.generationSymbols,
              })
          }}
        >
          <label class="flex items-center gap-2">
            {language.t("browser.passwords.generateLength")}
            <input
              type="number"
              min={16}
              max={64}
              step={1}
              required
              class="w-16 border border-border-weak-base rounded px-2 py-1"
              value={state.generationLength}
              onInput={(event) => setState("generationLength", event.currentTarget.valueAsNumber)}
            />
          </label>
          <label class="flex items-center gap-2">
            <input
              type="checkbox"
              checked={state.generationSymbols}
              onChange={(event) => setState("generationSymbols", event.currentTarget.checked)}
            />
            {language.t("browser.passwords.generateSymbols")}
          </label>
          <BrowserButton
            type="submit"
            size="small"
            disabled={
              state.busy || !props.tab || props.tab.agentAccess || props.tabs.profile?.vaultStatus !== "unlocked"
            }
          >
            {language.t("browser.passwords.generate")}
          </BrowserButton>
          <p class="w-full text-text-weak">{language.t("browser.passwords.generateHelp")}</p>
        </form>
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
                dir="ltr"
                required
                maxLength={2048}
                value={state.accountOrigin}
                aria-label={language.t("browser.settings.origin")}
                placeholder="https://example.com"
                class="min-w-0 flex-1 border border-border-weak-base rounded px-2 py-1"
                onInput={(event) => setState("accountOrigin", event.currentTarget.value)}
              />
              <BrowserButton type="submit" size="small" disabled={state.busy}>
                {language.t("browser.passwords.create")}
              </BrowserButton>
            </form>
          </Show>
          <div class="browser-record-search my-2">
            <Icon name="magnifying-glass" />
            <input
              type="search"
              value={state.query}
              aria-label={language.t("browser.passwords.search")}
              placeholder={language.t("browser.passwords.search")}
              class="browser-record-search-input"
              onInput={(event) => setState("query", event.currentTarget.value)}
            />
          </div>
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
            <div
              data-slot="browser-record-row"
              class="flex flex-wrap items-center gap-2 border-t border-border-weaker-base py-2 mt-1"
            >
              <div class="min-w-0 flex-1">
                <div class="truncate text-start" dir="ltr" title={login.origin}>
                  {login.origin}
                </div>
                <div class="truncate">{login.username}</div>
              </div>
              <BrowserButton
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
              </BrowserButton>
              <For each={["username", "password"] as const}>
                {(field) => (
                  <BrowserButton
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
                  </BrowserButton>
                )}
              </For>
              <Show when={props.tabs.profile?.loginEntryAvailable}>
                <BrowserButton
                  size="small"
                  variant="ghost"
                  disabled={state.busy}
                  onClick={() => void run({ op: "edit-login", origin: login.origin, id: login.id })}
                >
                  {language.t("browser.passwords.edit")}
                </BrowserButton>
              </Show>
              <BrowserButton
                size="small"
                variant="ghost"
                disabled={state.busy}
                onClick={() => void run({ op: "forget-login", id: login.id })}
              >
                {language.t("browser.passwords.delete")}
              </BrowserButton>
            </div>
          )}
        </For>
      </Show>
      <Show when={!props.tabs.profile}>
        <p role="status">{language.t("browser.tools.nextLaunch")}</p>
      </Show>
      <Show when={props.panel === "history"}>
        <div class="browser-record-search my-2">
          <Icon name="magnifying-glass" />
          <input
            type="search"
            class="browser-record-search-input"
            aria-label={language.t("browser.history.search")}
            placeholder={language.t("browser.history.search")}
            value={state.query}
            onInput={(event) => setState("query", event.currentTarget.value)}
          />
        </div>
        <p class="mb-2 text-text-weak">{language.t("browser.history.retention")}</p>
        <For
          each={props.tabs.profile?.history.filter((entry) => matches(`${entry.title} ${entry.url}`))}
          fallback={<p>{language.t(state.query ? "browser.records.noMatches" : "browser.history.empty")}</p>}
        >
          {(entry) => (
            <div data-slot="browser-record-row" class="flex items-center gap-2 border-t border-border-weaker-base">
              <button
                type="button"
                class="block text-start truncate min-w-0 flex-1 py-1"
                title={entry.url}
                disabled={state.busy || !entry.id}
                onClick={() => entry.id && void run({ op: "open-history", id: entry.id })}
              >
                <span dir={entry.title ? "auto" : "ltr"} class="block text-start">
                  {entry.title || entry.url}
                </span>
                <span class="block truncate text-text-weak text-start" dir="ltr">
                  {entry.url}
                </span>
                <time class="block text-text-weak" dateTime={new Date(entry.time).toISOString()}>
                  {language.formatDate(entry.time)}
                </time>
              </button>
              <BrowserButton
                size="small"
                variant="ghost"
                disabled={state.busy || !entry.id}
                onClick={() => entry.id && void run({ op: "forget-history", id: entry.id })}
              >
                {language.t("browser.records.remove")}
              </BrowserButton>
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
                class="block text-start w-full truncate py-1"
                dir={entry.title ? "auto" : "ltr"}
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
        <div class="browser-record-search my-2">
          <Icon name="magnifying-glass" />
          <input
            type="search"
            class="browser-record-search-input"
            aria-label={language.t("browser.download.search")}
            placeholder={language.t("browser.download.search")}
            value={state.query}
            onInput={(event) => setState("query", event.currentTarget.value)}
          />
        </div>
        <p class="mb-2 text-text-weak">{language.t("browser.download.retention")}</p>
        <For
          each={props.tabs.downloads?.filter((entry) => matches(entry.filename))}
          fallback={<p>{language.t(state.query ? "browser.records.noMatches" : "browser.download.historyEmpty")}</p>}
        >
          {(entry) => (
            <div
              data-slot="browser-record-row"
              class="flex flex-wrap items-center justify-between gap-2 border-t border-border-weaker-base py-1"
            >
              <div class="min-w-0 flex-1" role="status">
                {language.t(
                  entry.canResume
                    ? "browser.download.recoverable"
                    : entry.paused
                      ? "browser.download.paused"
                      : `browser.download.${entry.state}`,
                  {
                    filename: entry.filename,
                  },
                )}
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
                  <Progress
                    class="w-full"
                    aria-label={language.t("browser.menu.downloads")}
                    value={entry.received ?? 0}
                    max={entry.total}
                  />
                </Show>
              </div>
              <Show when={entry.canControl}>
                <Show when={entry.canPause !== false}>
                  <BrowserButton
                    size="small"
                    disabled={state.busy}
                    onClick={() =>
                      void run({ op: "download-control", id: entry.id, action: entry.paused ? "resume" : "pause" })
                    }
                  >
                    {language.t(entry.paused ? "browser.download.resume" : "browser.download.pause")}
                  </BrowserButton>
                </Show>
                <BrowserButton
                  size="small"
                  disabled={state.busy}
                  onClick={() => void run({ op: "download-control", id: entry.id, action: "cancel" })}
                >
                  {language.t("browser.download.cancel")}
                </BrowserButton>
              </Show>
              <Show when={entry.canResume}>
                <BrowserButton
                  size="small"
                  disabled={state.busy}
                  onClick={() => void run({ op: "recover-download", id: entry.id })}
                >
                  {language.t("browser.download.recover")}
                </BrowserButton>
              </Show>
              <Show when={entry.canReveal}>
                <BrowserButton
                  size="small"
                  variant="ghost"
                  onClick={() => void run({ op: "reveal-download", id: entry.id })}
                >
                  {language.t("browser.download.reveal")}
                </BrowserButton>
              </Show>
              <Show when={entry.state !== "saving"}>
                <BrowserButton
                  size="small"
                  variant="ghost"
                  disabled={state.busy}
                  onClick={() => void run({ op: "forget-download", id: entry.id })}
                >
                  {language.t("browser.records.remove")}
                </BrowserButton>
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
            <Select
              aria-label={language.t("browser.clear.range")}
              triggerProps={{ "aria-label": language.t("browser.clear.range") }}
              disabled={state.busy}
              options={["hour", "day", "week", "month", "all"] as const}
              current={state.range}
              label={(range) => language.t(`browser.clear.${range}`)}
              onSelect={(range) => {
                if (!range) return
                setState("range", range)
                if (range !== "all")
                  setState(
                    "kinds",
                    state.kinds.filter((kind) => kind === "history" || kind === "downloads"),
                  )
              }}
              variant="secondary"
              size="small"
            />
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
          <BrowserButton
            size="small"
            disabled={!state.kinds.length}
            onClick={() => void run({ op: "clear-selected", kinds: [...state.kinds], range: state.range })}
          >
            {language.t("browser.clear.submit")}
          </BrowserButton>
        </fieldset>
      </Show>
      <Show when={props.panel === "contacts" && props.tabs.profile}>
        {(profile) => <BrowserContacts profile={profile()} tab={props.tab} busy={state.busy} command={run} />}
      </Show>
      <Show when={props.panel === "settings" && props.tabs.profile}>
        {(profile) => (
          <BrowserSettings
            profile={profile()}
            tabs={props.tabs.tabs}
            busy={state.busy}
            command={run}
            open={props.open}
          />
        )}
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
