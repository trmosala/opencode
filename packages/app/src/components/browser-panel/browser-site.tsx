import { Button } from "@opencode-ai/ui/button"
import { createEffect, For, Show } from "solid-js"
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
      displayCapture: "block" as const,
      clipboard: "block" as const,
    }
  const practicalControls = () => [
    ...(props.profile.notificationsSupported === true ? (["notifications"] as const) : []),
    ...(props.profile.displayCaptureSupported === true ? (["displayCapture"] as const) : []),
    ...(props.profile.clipboardSupported === true ? (["clipboard"] as const) : []),
  ]
  const media = () =>
    props.tab.url.startsWith("https:") || ["localhost", "127.0.0.1", "[::1]"].includes(new URL(props.tab.url).hostname)
  const data = () => (props.tab.siteData?.origin === origin() ? props.tab.siteData : undefined)
  let inspected = ""
  const size = () => {
    const bytes = data()?.usage
    if (bytes === undefined) return ""
    const units = ["byte", "kilobyte", "megabyte", "gigabyte"] as const
    const unit = bytes < 1024 ? 0 : bytes < 1024 ** 2 ? 1 : bytes < 1024 ** 3 ? 2 : 3
    return new Intl.NumberFormat(language.intl(), {
      style: "unit",
      unit: units[unit],
      unitDisplay: "short",
      maximumFractionDigits: unit ? 1 : 0,
    }).format(bytes / 1024 ** unit)
  }
  createEffect(() => {
    const id = props.tab.id
    const url = props.tab.url
    const key = `${id}\u0000${url}`
    if (props.busy || props.tab.access?.loading || inspected === key || !/^https?:/.test(url)) return
    inspected = key
    void props.command({ op: "inspect-site", tabID: id })
  })
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
      <For each={practicalControls()}>
        {(permission) => (
          <label class="flex items-center justify-between gap-2">
            {language.t(`browser.settings.${permission}`)}
            <select
              disabled={props.busy || !media()}
              value={rule()[permission] ?? "block"}
              onChange={(event) =>
                void props.command({
                  op: "site-permission",
                  origin: origin(),
                  [permission]: event.currentTarget.value as BrowserPermission,
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
        <p>{language.t("browser.notifications.help")}</p>
        <p>{language.t("browser.notifications.os")}</p>
      </Show>
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
      <fieldset class="space-y-2 border-t border-border-weaker-base pt-2">
        <legend class="font-medium">{language.t("browser.site.data")}</legend>
        <Show when={data()} fallback={<p role="status">{language.t("browser.site.inspecting")}</p>}>
          {(inspection) => (
            <>
              <Show when={inspection().cookies !== undefined}>
                <p>{language.t("browser.site.cookies", { count: inspection().cookies ?? 0 })}</p>
              </Show>
              <Show when={inspection().usage !== undefined}>
                <p>{language.t("browser.site.usage", { size: size() })}</p>
              </Show>
              <Show when={inspection().storage.length}>
                <p>
                  {language.t("browser.site.storage", {
                    types: inspection()
                      .storage.map((type) => language.t(`browser.site.storage.${type}`))
                      .join(", "),
                  })}
                </p>
              </Show>
              <Show when={inspection().cookies === undefined && inspection().usage === undefined}>
                <p>{language.t("browser.site.unavailable")}</p>
              </Show>
            </>
          )}
        </Show>
        <p class="text-text-weak">{language.t("browser.site.clearScope")}</p>
        <Button
          size="small"
          variant="ghost"
          disabled={props.busy || props.tab.access?.loading}
          onClick={() => void props.command({ op: "inspect-site", tabID: props.tab.id })}
        >
          {language.t("browser.site.refresh")}
        </Button>
        <Button
          size="small"
          disabled={props.busy}
          onClick={() => void props.command({ op: "clear-site", tabID: props.tab.id })}
        >
          {language.t("browser.site.clear")}
        </Button>
      </fieldset>
    </div>
  )
}
