import { Button } from "@opencode-ai/ui/button"
import { For, Show } from "solid-js"
import { useLanguage } from "@/context/language"
import type { BrowserTab, BrowserProfile, BrowserCommand, BrowserPermission } from "@/browser-panel"

export function BrowserSite(props: {
  tab: BrowserTab
  profile: BrowserProfile
  busy: boolean
  command(value: BrowserCommand): Promise<unknown>
}) {
  const language = useLanguage()
  const origin = () => new URL(props.tab.url).origin
  const rule = () =>
    props.profile.sites?.find((row) => row.origin === origin()) ?? {
      origin: origin(),
      camera: "block" as const,
      microphone: "block" as const,
      notifications: "block" as const,
    }
  const media = () =>
    props.tab.url.startsWith("https:") || ["localhost", "127.0.0.1", "[::1]"].includes(new URL(props.tab.url).hostname)
  return (
    <div class="space-y-3">
      <strong class="break-all">{origin()}</strong>
      <p>{language.t(`browser.site.${props.tab.connection ?? "unknown"}`)}</p>
      <p class="text-text-weak">{language.t("browser.site.connectionHelp")}</p>
      <For each={["camera", "microphone"] as const}>
        {(device) => (
          <label class="flex items-center justify-between gap-2">
            {language.t(`browser.settings.${device}`)}
            <select
              disabled={props.busy || !media()}
              value={rule()[device]}
              onChange={(event) =>
                void props.command({
                  op: "site-permission",
                  origin: origin(),
                  [device]: event.currentTarget.value as BrowserPermission,
                })
              }
            >
              <For each={["block", "ask", "allow"] as const}>
                {(permission) => <option value={permission}>{language.t(`browser.permission.${permission}`)}</option>}
              </For>
            </select>
          </label>
        )}
      </For>
      <Show when={props.profile.notificationsSupported === true}>
        <label class="flex items-center justify-between gap-2">
          {language.t("browser.settings.notifications")}
          <select
            disabled={props.busy || !media()}
            value={rule().notifications ?? "block"}
            onChange={(event) =>
              void props.command({
                op: "site-permission",
                origin: origin(),
                notifications: event.currentTarget.value as BrowserPermission,
              })
            }
          >
            <For each={["block", "ask", "allow"] as const}>
              {(permission) => <option value={permission}>{language.t(`browser.permission.${permission}`)}</option>}
            </For>
          </select>
        </label>
        <p>{language.t("browser.notifications.help")}</p>
        <p>{language.t("browser.notifications.os")}</p>
      </Show>
      <Show when={props.profile.notificationsSupported !== true}>
        <p>
          {language.t(
            props.profile.notificationsSupported === false
              ? "browser.notifications.unavailable"
              : "browser.notifications.nextLaunch",
          )}
        </p>
      </Show>
      <Show when={!media()}>
        <p>{language.t("browser.site.mediaUnavailable")}</p>
      </Show>
      <p>{language.t(props.tab.agentAccess ? "browser.site.agentOn" : "browser.site.agentOff")}</p>
      <Button
        size="small"
        disabled={props.busy || !props.tab.agentAccess}
        onClick={() => void props.command({ op: "access", tabID: props.tab.id, enabled: false })}
      >
        {language.t("browser.site.revoke")}
      </Button>
      <Button
        size="small"
        disabled={props.busy}
        onClick={() => void props.command({ op: "clear-site", tabID: props.tab.id })}
      >
        {language.t("browser.site.clear")}
      </Button>
    </div>
  )
}
