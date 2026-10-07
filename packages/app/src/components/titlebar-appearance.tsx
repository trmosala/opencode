import { useTheme } from "@opencode-ai/ui/theme/context"
import { useLanguage } from "@/context/language"
import { useSettings } from "@/context/settings"
import { Cm3Icon } from "./cm3-icon"
import { Show } from "solid-js"
import { WppAuthControl } from "./wpp-auth-control"

export function TitlebarAppearance() {
  const settings = useSettings()
  const language = useLanguage()
  const theme = useTheme()
  return (
    <div
      class="flex shrink-0 items-center gap-1 px-1 text-xs"
      data-component="titlebar-appearance"
      style={{ "-webkit-app-region": "no-drag" }}
    >
      <Show when={!settings.general.quietCompanion()}>
        <WppAuthControl compact />
      </Show>
      <button
        type="button"
        role="switch"
        aria-label={language.t("settings.general.row.quietCompanion.title")}
        aria-checked={settings.general.quietCompanion()}
        title={language.t("settings.general.row.quietCompanion.title")}
        disabled={!settings.ready()}
        class="flex size-8 items-center justify-center rounded hover:bg-surface-base-hover aria-checked:bg-surface-base-hover focus-visible:outline"
        onClick={() => settings.general.setQuietCompanion(!settings.general.quietCompanion())}
      >
        <Cm3Icon name="squares-four" size={18} />
      </button>
      <button
        type="button"
        role="switch"
        aria-label={language.t("theme.scheme.dark")}
        aria-checked={theme.mode() === "dark"}
        title={language.t(theme.mode() === "dark" ? "theme.scheme.light" : "theme.scheme.dark")}
        class="flex size-8 items-center justify-center rounded hover:bg-surface-base-hover focus-visible:outline"
        onClick={() => theme.setColorScheme(theme.mode() === "dark" ? "light" : "dark")}
      >
        <Cm3Icon name={theme.mode() === "dark" ? "moon" : "sun"} size={18} />
      </button>
    </div>
  )
}
