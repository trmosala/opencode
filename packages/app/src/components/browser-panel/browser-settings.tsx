import { Button } from "@opencode-ai/ui/button"
import { For, Show } from "solid-js"
import { createStore } from "solid-js/store"
import { useLanguage } from "@/context/language"
import type { BrowserCommand, BrowserPermission, BrowserPreferences, BrowserProfile } from "@/browser-panel"
import type { BrowserToolPanel } from "./browser-tools"
import { BrowserTransfers } from "./browser-transfers"

export function BrowserSettings(props: {
  profile: BrowserProfile
  busy: boolean
  command(value: BrowserCommand): Promise<unknown>
  open(panel: BrowserToolPanel): void
}) {
  const language = useLanguage()
  const [state, setState] = createStore({
    origin: "",
    host: "",
    camera: "block" as BrowserPermission,
    microphone: "block" as BrowserPermission,
  })
  const toggle = (key: keyof BrowserPreferences, value: boolean) =>
    void props.command({ op: "preferences", values: { [key]: value } })
  const permissions = ["block", "ask", "allow"] as const
  return (
    <div class="max-w-3xl mx-auto space-y-6 pb-4">
      <p class="text-text-weak">{language.t("browser.settings.description")}</p>
      <Show when={!props.profile.preferences}>
        <p role="status">{language.t("browser.tools.nextLaunch")}</p>
      </Show>
      <fieldset disabled={!props.profile.preferences || props.busy} class="min-w-0 space-y-5">
        <section class="rounded-lg border border-border-weak-base p-4 space-y-4">
          <label class="flex items-center justify-between gap-4">
            <span>
              <strong>{language.t("browser.settings.agent")}</strong>
              <p class="text-text-weak mt-1">{language.t("browser.settings.agent.help")}</p>
            </span>
            <input
              type="checkbox"
              checked={props.profile.preferences?.agentEnabled ?? true}
              disabled={props.busy}
              onChange={(event) => toggle("agentEnabled", event.currentTarget.checked)}
            />
          </label>
        </section>
        <h3 class="text-14-medium">{language.t("browser.settings.general")}</h3>
        <section class="rounded-lg border border-border-weak-base p-4 space-y-4">
          <p>{language.t("browser.settings.search")}</p>
          <p class="text-text-weak">{language.t("browser.settings.linksHelp")}</p>
          <For each={["webLinks", "localLinks"] as const}>
            {(key) => (
              <label class="flex items-center justify-between gap-4">
                <span>{language.t(`browser.settings.${key}`)}</span>
                <select
                  disabled={props.profile.preferences?.[key] === undefined}
                  value={props.profile.preferences?.[key] ?? (key === "webLinks" ? "external" : "browser")}
                  onChange={(event) =>
                    void props.command({ op: "preferences", values: { [key]: event.currentTarget.value } })
                  }
                >
                  <option value="external">{language.t("browser.links.external")}</option>
                  <option value="browser">{language.t("browser.links.internal")}</option>
                </select>
              </label>
            )}
          </For>
          <For each={["showFullURL", "selectionScreenshots", "restoreTabs"] as const}>
            {(key) => (
              <label class="flex items-center justify-between gap-4">
                <span>
                  <strong>{language.t(`browser.settings.${key}`)}</strong>
                  <p class="text-text-weak mt-1">{language.t(`browser.settings.${key}.help`)}</p>
                </span>
                <input
                  type="checkbox"
                  disabled={props.busy}
                  checked={props.profile.preferences?.[key] ?? key === "showFullURL"}
                  onChange={(event) => toggle(key, event.currentTarget.checked)}
                />
              </label>
            )}
          </For>
          <label class="flex items-center justify-between gap-4">
            <span>{language.t("browser.settings.history")}</span>
            <input
              type="checkbox"
              checked={props.profile.rememberHistory}
              disabled={props.busy}
              onChange={(event) => void props.command({ op: "settings", rememberHistory: event.currentTarget.checked })}
            />
          </label>
          <div class="flex flex-wrap gap-2">
            <For each={["import", "history", "clear"] as const}>
              {(panel) => (
                <Button size="small" variant="secondary" onClick={() => props.open(panel)}>
                  {language.t(`browser.menu.${panel}`)}
                </Button>
              )}
            </For>
          </div>
        </section>
        <h3 class="text-14-medium">{language.t("browser.menu.passwords")}</h3>
        <section class="rounded-lg border border-border-weak-base p-4">
          <Button size="small" onClick={() => props.open("passwords")}>
            {language.t("browser.settings.passwords.manage")}
          </Button>
        </section>
        <section class="rounded-lg border border-border-weak-base p-4 space-y-4">
          <label class="flex items-center justify-between gap-4">
            <span>
              <strong>{language.t("browser.passwords.offers")}</strong>
              <p class="text-text-weak mt-1">{language.t("browser.passwords.offers.help")}</p>
            </span>
            <input
              type="checkbox"
              disabled={props.profile.preferences?.offerSaveLogins === undefined}
              checked={props.profile.preferences?.offerSaveLogins ?? false}
              onChange={(event) => toggle("offerSaveLogins", event.currentTarget.checked)}
            />
          </label>
          <Show when={props.profile.loginOfferExclusions?.length}>
            <h4>{language.t("browser.passwords.offers.never")}</h4>
            <For each={props.profile.loginOfferExclusions}>
              {(origin) => (
                <div class="flex items-center justify-between gap-3">
                  <span class="break-all">{origin}</span>
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
        </section>
        <h3 class="text-14-medium">{language.t("browser.menu.downloads")}</h3>
        <section class="rounded-lg border border-border-weak-base p-4 space-y-4">
          <div class="flex flex-wrap justify-between gap-3">
            <span class="min-w-0">
              <strong>{language.t("browser.settings.location")}</strong>
              <p class="break-all mt-1 text-text-weak">{props.profile.downloadDirectory}</p>
            </span>
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
          </div>
          <label class="flex items-center justify-between gap-4">
            <span>
              <strong>{language.t("browser.settings.askDownloadLocation")}</strong>
              <p class="text-text-weak mt-1">{language.t("browser.settings.askDownloadLocation.help")}</p>
            </span>
            <input
              type="checkbox"
              disabled={props.busy}
              checked={props.profile.preferences?.askDownloadLocation ?? true}
              onChange={(event) => toggle("askDownloadLocation", event.currentTarget.checked)}
            />
          </label>
          <Button size="small" onClick={() => props.open("downloads")}>
            {language.t("browser.settings.downloads.manage")}
          </Button>
        </section>
        <section class="rounded-lg border border-border-weak-base p-4 space-y-4">
          <label class="flex items-center justify-between gap-4">
            <span>
              <strong>{language.t("browser.history.agent")}</strong>
              <p class="text-text-weak mt-1">{language.t("browser.history.agent.help")}</p>
            </span>
            <select
              disabled={props.profile.preferences?.agentHistory === undefined}
              value={props.profile.preferences?.agentHistory ?? "ask"}
              onChange={(event) => {
                const value = event.currentTarget.value
                if (value !== "never" && value !== "ask" && value !== "allow") return
                void props.command({
                  op: "preferences",
                  values: { agentHistory: value },
                })
              }}
            >
              <For each={["never", "ask", "allow"] as const}>
                {(value) => <option value={value}>{language.t(`browser.history.agent.${value}`)}</option>}
              </For>
            </select>
          </label>
        </section>
        <BrowserTransfers rules={props.profile.transferRules} command={(value) => props.command(value)} />
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
              })
            }}
          >
            <label class="flex-1 min-w-40">
              {language.t("browser.settings.origin")}
              <input
                type="url"
                required
                value={state.origin}
                onInput={(event) => setState("origin", event.currentTarget.value)}
                class="block w-full border border-border-weak-base rounded p-2 mt-1"
                placeholder="https://example.com"
              />
            </label>
            <For each={["camera", "microphone"] as const}>
              {(device) => (
                <label>
                  {language.t(`browser.settings.${device}`)}
                  <select
                    class="block border border-border-weak-base rounded p-2 mt-1"
                    value={state[device]}
                    onChange={(event) => setState(device, event.currentTarget.value as BrowserPermission)}
                  >
                    <For each={permissions}>
                      {(value) => <option value={value}>{language.t(`browser.permission.${value}`)}</option>}
                    </For>
                  </select>
                </label>
              )}
            </For>
            <Button type="submit" size="small" disabled={props.busy}>
              {language.t("browser.settings.site.save")}
            </Button>
          </form>
          <For each={props.profile.sites}>
            {(site) => (
              <div class="flex flex-wrap items-center gap-3 border-t border-border-weaker-base pt-3">
                <strong class="flex-1 break-all">{site.origin}</strong>
                <For each={["camera", "microphone"] as const}>
                  {(device) => (
                    <label>
                      {language.t(`browser.settings.${device}`)}
                      <select
                        class="block border border-border-weak-base rounded p-2 mt-1"
                        disabled={props.busy}
                        value={site[device]}
                        onChange={(event) =>
                          void props.command({
                            op: "site-permission",
                            ...site,
                            [device]: event.currentTarget.value as BrowserPermission,
                          })
                        }
                      >
                        <For each={permissions}>
                          {(value) => <option value={value}>{language.t(`browser.permission.${value}`)}</option>}
                        </For>
                      </select>
                    </label>
                  )}
                </For>
              </div>
            )}
          </For>
        </section>
        <h3 class="text-14-medium">{language.t("browser.settings.agentHosts")}</h3>
        <section class="rounded-lg border border-border-weak-base p-4 space-y-4">
          <p class="text-text-weak">{language.t("browser.settings.agentHosts.help")}</p>
          <form
            class="flex gap-2"
            onSubmit={(event) => {
              event.preventDefault()
              void props.command({ op: "agent-host", host: state.host })
            }}
          >
            <input
              class="min-w-0 flex-1 border border-border-weak-base rounded p-2"
              value={state.host}
              onInput={(event) => setState("host", event.currentTarget.value)}
              aria-label={language.t("browser.settings.agentHosts.host")}
              placeholder="example.com"
              required
            />
            <Button size="small" type="submit" disabled={props.busy}>
              {language.t("browser.settings.agentHosts.add")}
            </Button>
          </form>
          <For each={props.profile.agentHosts}>
            {(host) => (
              <div class="flex items-center justify-between gap-2">
                <span>{host}</span>
                <Button
                  size="small"
                  variant="ghost"
                  disabled={props.busy}
                  onClick={() => void props.command({ op: "agent-host", host, remove: true })}
                >
                  {language.t("browser.settings.agentHosts.remove")}
                </Button>
              </div>
            )}
          </For>
        </section>
      </fieldset>
    </div>
  )
}
