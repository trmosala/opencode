import { Button } from "@opencode-ai/ui/button"
import { Select } from "@opencode-ai/ui/select"
import { Switch } from "@opencode-ai/ui/switch"
import { SettingsList } from "@/components/settings-list"
import { SettingsRow } from "@/components/settings-row"
import { SettingsListV2 } from "@/components/settings-v2/parts/list"
import { SettingsRowV2 } from "@/components/settings-v2/parts/row"
import { useSettings } from "@/context/settings"
import { For, Show, type JSX } from "solid-js"
import { createStore } from "solid-js/store"
import { useLanguage } from "@/context/language"
import type { BrowserCommand, BrowserPermission, BrowserPreferences, BrowserProfile, BrowserTab } from "@/browser-panel"
import { BROWSER_SEARCH_ENGINES } from "@/browser-panel"
import type { BrowserToolPanel } from "./browser-tools"
import { BrowserTransfers } from "./browser-transfers"

export function BrowserSettings(props: {
  profile: BrowserProfile
  tabs: BrowserTab[]
  busy: boolean
  command(value: BrowserCommand): Promise<unknown>
  open(panel: BrowserToolPanel): void
}) {
  const language = useLanguage()
  const settings = useSettings()
  const [state, setState] = createStore({
    origin: "",
    camera: "block" as BrowserPermission,
    microphone: "block" as BrowserPermission,
    notifications: "block" as BrowserPermission,
    displayCapture: "block" as BrowserPermission,
    clipboard: "block" as BrowserPermission,
  })
  const siteControls = () => [
    "camera" as const,
    "microphone" as const,
    ...(props.profile.notificationsSupported === true ? (["notifications"] as const) : []),
    ...(props.profile.displayCaptureSupported === true ? (["displayCapture"] as const) : []),
    ...(props.profile.clipboardSupported === true ? (["clipboard"] as const) : []),
  ]
  const toggle = (key: keyof BrowserPreferences, value: boolean) =>
    void props.command({ op: "preferences", values: { [key]: value } })
  const permissions = ["block", "ask", "allow"] as const
  const SettingRow = (row: { title: string; description: string; children: JSX.Element }) => (
    <Show
      when={settings.general.newLayoutDesigns()}
      fallback={
        <SettingsRow title={row.title} description={row.description}>
          {row.children}
        </SettingsRow>
      }
    >
      <SettingsRowV2 title={row.title} description={row.description}>
        {row.children}
      </SettingsRowV2>
    </Show>
  )
  const SettingsRows = (rows: { children: JSX.Element }) => (
    <Show when={settings.general.newLayoutDesigns()} fallback={<SettingsList>{rows.children}</SettingsList>}>
      <SettingsListV2>{rows.children}</SettingsListV2>
    </Show>
  )
  return (
    <div class="max-w-3xl mx-auto space-y-6 pb-4">
      <p class="text-text-weak">{language.t("browser.settings.description")}</p>
      <Show when={!props.profile.preferences}>
        <p role="status">{language.t("browser.tools.nextLaunch")}</p>
      </Show>
      <section aria-label={language.t("browser.access.title")} class="min-w-0 space-y-4">
        <div class="flex flex-wrap items-center justify-between gap-3">
          <h3 class="text-14-medium">{language.t("browser.access.title")}</h3>
          <Button
            size="small"
            variant="secondary"
            disabled={props.busy}
            onClick={() => void props.command({ op: "state" })}
          >
            {language.t("browser.access.refresh")}
          </Button>
        </div>
        <p class="text-text-weak">{language.t("browser.access.tabGrantHelp")}</p>
        <SettingsRows>
          <SettingRow
            title={language.t("browser.settings.agent")}
            description={language.t("browser.settings.agent.tabGrantHelp")}
          >
            <Switch
              aria-label={language.t("browser.settings.agent")}
              checked={props.profile.preferences?.agentEnabled === true}
              disabled={
                props.profile.preferences?.agentEnabled === undefined ||
                (props.busy && !props.profile.preferences.agentEnabled)
              }
              onChange={(checked) => toggle("agentEnabled", checked)}
            />
          </SettingRow>
          <Show when={props.profile.preferences?.agentEnabled === undefined}>
            <p role="status">{language.t("browser.access.unknown")}</p>
          </Show>
        </SettingsRows>
        <section
          class="rounded-lg border border-border-weak-base p-4 space-y-4"
          aria-label={language.t("browser.access.tabs")}
        >
          <h4 class="text-14-medium">{language.t("browser.access.tabs")}</h4>
          <For each={props.tabs} fallback={<p>{language.t("browser.tabs.empty")}</p>}>
            {(tab) => (
              <div class="min-w-0 border-t border-border-weaker-base pt-3 space-y-2" data-access-tab={tab.id}>
                <strong dir={tab.title ? "auto" : "ltr"} class="block text-start break-all">
                  {tab.title || tab.url}
                </strong>
                <p dir="ltr" class="break-all text-start text-text-weak">
                  {tab.url}
                </p>
                <p role="status">
                  {language.t(
                    !tab.access || props.profile.preferences?.agentEnabled === undefined
                      ? "browser.access.unknown"
                      : !props.profile.preferences.agentEnabled
                        ? "browser.access.off"
                        : !tab.agentAccess
                          ? "browser.access.private"
                          : tab.access.blank
                            ? "browser.access.blank"
                            : tab.access.loading
                              ? "browser.access.tabGrantLoading"
                              : "browser.access.tabGrantEligible",
                  )}
                </p>
                <Show when={tab.access}>
                  {(access) => (
                    <div class="text-text-weak space-y-1">
                      <p>
                        {language.t(access().transferGuarded ? "browser.access.guarded" : "browser.access.unguarded")}
                      </p>
                      <Show when={access().transferGuarded}>
                        <p class="break-all">
                          {language.t(`browser.access.${access().transferSource}`, {
                            origin: access().transferRule.origin,
                          })}
                        </p>
                        <p>
                          {language.t("browser.access.uploads", {
                            policy: language.t(
                              access().transferRule.uploads === "ask"
                                ? "browser.transfer.choose"
                                : "browser.permission.block",
                            ),
                          })}
                        </p>
                        <p>
                          {language.t("browser.access.downloads", {
                            policy: language.t(`browser.permission.${access().transferRule.downloads}`),
                          })}
                        </p>
                      </Show>
                    </div>
                  )}
                </Show>
                <div class="flex flex-wrap gap-2">
                  <Show when={!tab.agentAccess}>
                    <Button
                      size="small"
                      disabled={
                        props.busy ||
                        !tab.access ||
                        tab.access.loading !== false ||
                        tab.access.blank !== false ||
                        props.profile.preferences?.agentEnabled !== true
                      }
                      onClick={() => void props.command({ op: "access", tabID: tab.id, enabled: true })}
                    >
                      {language.t("browser.access.grant")}
                    </Button>
                  </Show>
                  <Button
                    size="small"
                    variant="secondary"
                    class="max-w-full whitespace-normal h-auto min-h-6"
                    onClick={() => void props.command({ op: "access", tabID: tab.id, enabled: false })}
                  >
                    {language.t("browser.access.revoke")}
                  </Button>
                </div>
              </div>
            )}
          </For>
        </section>
        <fieldset disabled={props.busy} class="min-w-0 space-y-4">
          <SettingsRows>
            <SettingRow
              title={language.t("browser.history.agent")}
              description={language.t("browser.history.agent.help")}
            >
              <Select
                aria-label={language.t("browser.history.agent")}
                triggerProps={{ "aria-label": language.t("browser.history.agent") }}
                options={["never", "ask", "allow"] as const}
                current={props.profile.preferences?.agentHistory ?? "never"}
                disabled={props.busy || props.profile.preferences?.agentHistory === undefined}
                label={(value) => language.t(`browser.history.agent.${value}`)}
                onSelect={(value) =>
                  value && void props.command({ op: "preferences", values: { agentHistory: value } })
                }
                variant="secondary"
                size="small"
                triggerVariant="settings"
              />
            </SettingRow>
            <p role="status">
              {props.profile.preferences?.agentEnabled === false
                ? language.t("browser.access.historyOff")
                : props.profile.preferences?.agentEnabled === true &&
                    props.profile.preferences.agentHistory !== undefined
                  ? language.t("browser.access.historyEffective", {
                      policy: language.t(`browser.history.agent.${props.profile.preferences.agentHistory}`),
                    })
                  : language.t("browser.access.unknown")}
            </p>
          </SettingsRows>
          <BrowserTransfers rules={props.profile.transferRules} command={(value) => props.command(value)} />
          <p class="text-text-weak">{language.t("browser.access.transferLimits")}</p>
        </fieldset>
      </section>
      <fieldset disabled={!props.profile.preferences || props.busy} class="min-w-0 space-y-5">
        <h3 class="text-14-medium">{language.t("browser.settings.general")}</h3>
        <SettingsRows>
          <SettingRow
            title={language.t("browser.settings.search")}
            description={language.t("browser.settings.search.help")}
          >
            <Select
              disabled={props.busy || !props.profile.preferences}
              aria-label={language.t("browser.settings.search")}
              triggerProps={{ "aria-label": language.t("browser.settings.search") }}
              options={[...BROWSER_SEARCH_ENGINES]}
              current={props.profile.preferences?.searchEngine ?? "duckduckgo"}
              label={(engine) => language.t(`browser.search.${engine}`)}
              onSelect={(engine) =>
                engine && void props.command({ op: "preferences", values: { searchEngine: engine } })
              }
              variant="secondary"
              size="small"
              triggerVariant="settings"
            />
          </SettingRow>
          <For each={["webLinks", "localLinks"] as const}>
            {(key) => {
              const options = [
                { value: "external", label: language.t("browser.links.external") },
                { value: "browser", label: language.t("browser.links.internal") },
              ]
              return (
                <SettingRow
                  title={language.t(`browser.settings.${key}`)}
                  description={key === "webLinks" ? language.t("browser.settings.linksHelp") : ""}
                >
                  <Select
                    aria-label={language.t(`browser.settings.${key}`)}
                    triggerProps={{ "aria-label": language.t(`browser.settings.${key}`) }}
                    options={options}
                    current={options.find(
                      (option) =>
                        option.value ===
                        (props.profile.preferences?.[key] ?? (key === "webLinks" ? "external" : "browser")),
                    )}
                    disabled={props.busy || props.profile.preferences?.[key] === undefined}
                    value={(option) => option.value}
                    label={(option) => option.label}
                    onSelect={(option) =>
                      option && void props.command({ op: "preferences", values: { [key]: option.value } })
                    }
                    variant="secondary"
                    size="small"
                    triggerVariant="settings"
                  />
                </SettingRow>
              )
            }}
          </For>
          <For each={["showFullURL", "selectionScreenshots", "restoreTabs"] as const}>
            {(key) => (
              <SettingRow
                title={language.t(`browser.settings.${key}`)}
                description={language.t(`browser.settings.${key}.help`)}
              >
                <Switch
                  aria-label={language.t(`browser.settings.${key}`)}
                  disabled={props.busy}
                  checked={props.profile.preferences?.[key] ?? key === "showFullURL"}
                  onChange={(checked) => toggle(key, checked)}
                />
              </SettingRow>
            )}
          </For>
          <SettingRow title={language.t("browser.settings.history")} description="">
            <Switch
              aria-label={language.t("browser.settings.history")}
              checked={props.profile.rememberHistory}
              disabled={props.busy}
              onChange={(checked) => void props.command({ op: "settings", rememberHistory: checked })}
            />
          </SettingRow>
          <div class="flex flex-wrap gap-2">
            <For each={["import", "history", "clear"] as const}>
              {(panel) => (
                <Button size="small" variant="secondary" onClick={() => props.open(panel)}>
                  {language.t(`browser.menu.${panel}`)}
                </Button>
              )}
            </For>
          </div>
        </SettingsRows>
        <h3 class="text-14-medium">{language.t("browser.menu.passwords")}</h3>
        <SettingsRows>
          <SettingRow title={language.t("browser.menu.passwords")} description="">
            <Button size="small" onClick={() => props.open("passwords")}>
              {language.t("browser.settings.passwords.manage")}
            </Button>
          </SettingRow>
        </SettingsRows>
        <SettingsRows>
          <SettingRow
            title={language.t("browser.passwords.offers")}
            description={language.t("browser.passwords.offers.help")}
          >
            <Switch
              aria-label={language.t("browser.passwords.offers")}
              disabled={props.busy || props.profile.preferences?.offerSaveLogins === undefined}
              checked={props.profile.preferences?.offerSaveLogins ?? false}
              onChange={(checked) => toggle("offerSaveLogins", checked)}
            />
          </SettingRow>
          <Show when={props.profile.loginOfferExclusions?.length}>
            <h4>{language.t("browser.passwords.offers.never")}</h4>
            <For each={props.profile.loginOfferExclusions}>
              {(origin) => (
                <div class="flex items-center justify-between gap-3">
                  <span dir="ltr" class="break-all text-start">
                    {origin}
                  </span>
                  <Button
                    size="small"
                    variant="ghost"
                    onClick={() => void props.command({ op: "allow-login-offers", origin })}
                  >
                    {language.t("browser.passwords.offers.allow")}
                  </Button>
                </div>
              )}
            </For>
          </Show>
        </SettingsRows>
        <h3 class="text-14-medium">{language.t("browser.menu.downloads")}</h3>
        <SettingsRows>
          <SettingRow
            title={language.t("browser.settings.location")}
            description={props.profile.downloadDirectory ?? ""}
          >
            <div class="flex gap-2">
              <Button
                size="small"
                disabled={props.busy}
                onClick={() => void props.command({ op: "download-directory" })}
              >
                {language.t("browser.settings.change")}
              </Button>
              <Button
                size="small"
                variant="ghost"
                disabled={props.busy}
                onClick={() => void props.command({ op: "download-directory", reset: true })}
              >
                {language.t("browser.settings.resetLocation")}
              </Button>
            </div>
          </SettingRow>
          <SettingRow
            title={language.t("browser.settings.askDownloadLocation")}
            description={language.t("browser.settings.askDownloadLocation.help")}
          >
            <Switch
              aria-label={language.t("browser.settings.askDownloadLocation")}
              disabled={props.busy}
              checked={props.profile.preferences?.askDownloadLocation ?? true}
              onChange={(checked) => toggle("askDownloadLocation", checked)}
            />
          </SettingRow>
          <SettingRow title={language.t("browser.settings.downloads.manage")} description="">
            <Button size="small" onClick={() => props.open("downloads")}>
              {language.t("browser.settings.downloads.manage")}
            </Button>
          </SettingRow>
        </SettingsRows>
        <h3 class="text-14-medium">{language.t("browser.settings.sites")}</h3>
        <section class="rounded-lg border border-border-weak-base p-4 space-y-4">
          <p class="text-text-weak">{language.t("browser.settings.sites.help")}</p>
          <form
            class="flex flex-wrap items-end gap-3"
            onSubmit={(event) => {
              event.preventDefault()
              void props.command({
                op: "site-permission",
                origin: state.origin,
                camera: state.camera,
                microphone: state.microphone,
                ...(props.profile.notificationsSupported === true ? { notifications: state.notifications } : {}),
                ...(props.profile.displayCaptureSupported === true ? { displayCapture: state.displayCapture } : {}),
                ...(props.profile.clipboardSupported === true ? { clipboard: state.clipboard } : {}),
              })
            }}
          >
            <label class="flex-1 min-w-40">
              {language.t("browser.settings.origin")}
              <input
                type="url"
                dir="ltr"
                required
                value={state.origin}
                onInput={(event) => setState("origin", event.currentTarget.value)}
                class="block w-full border border-border-weak-base rounded p-2 mt-1"
                placeholder="https://example.com"
              />
            </label>
            <For each={siteControls()}>
              {(device) => (
                <label>
                  {language.t(`browser.settings.${device}`)}
                  <Select
                    disabled={props.busy || !props.profile.preferences}
                    aria-label={language.t(`browser.settings.${device}`)}
                    triggerProps={{ "aria-label": language.t(`browser.settings.${device}`) }}
                    options={[...permissions]}
                    current={state[device]}
                    label={(value) => language.t(`browser.permission.${value}`)}
                    onSelect={(value) => value && setState(device, value)}
                    variant="secondary"
                    size="small"
                    triggerVariant="settings"
                  />
                </label>
              )}
            </For>
            <Button type="submit" size="small" disabled={props.busy}>
              {language.t("browser.settings.site.save")}
            </Button>
          </form>
          <p>{language.t("browser.notifications.help")}</p>
          <p>{language.t("browser.notifications.os")}</p>
          <Show when={props.profile.displayCaptureSupported === true}>
            <p>{language.t("browser.displayCapture.help")}</p>
          </Show>
          <Show when={props.profile.clipboardSupported === true}>
            <p>{language.t("browser.clipboard.help")}</p>
          </Show>
          <p>{language.t("browser.location.unsupported")}</p>
          <Show when={props.profile.notificationsSupported !== true}>
            <p>
              {language.t(
                props.profile.notificationsSupported === false
                  ? "browser.notifications.unavailable"
                  : "browser.notifications.nextLaunch",
              )}
            </p>
          </Show>
          <For each={props.profile.sites}>
            {(site) => (
              <div class="flex flex-wrap items-center gap-3 border-t border-border-weaker-base pt-3">
                <strong dir="ltr" class="flex-1 break-all text-start">
                  {site.origin}
                </strong>
                <For each={siteControls()}>
                  {(device) => (
                    <label>
                      {language.t(`browser.settings.${device}`)}
                      <Select
                        aria-label={language.t(`browser.settings.${device}`)}
                        triggerProps={{ "aria-label": language.t(`browser.settings.${device}`) }}
                        options={[...permissions]}
                        current={site[device] ?? "block"}
                        disabled={props.busy}
                        label={(value) => language.t(`browser.permission.${value}`)}
                        onSelect={(value) =>
                          value &&
                          void props.command({
                            op: "site-permission",
                            origin: site.origin,
                            [device]: value,
                          })
                        }
                        variant="secondary"
                        size="small"
                        triggerVariant="settings"
                      />
                    </label>
                  )}
                </For>
              </div>
            )}
          </For>
        </section>
      </fieldset>
    </div>
  )
}
