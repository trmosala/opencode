import { useTheme } from "@opencode-ai/ui/theme/context"
import { useLanguage } from "@/context/language"
import { useSettings } from "@/context/settings"

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
      <button
        type="button"
        role="switch"
        aria-label={language.t("settings.general.row.quietCompanion.title")}
        aria-checked={settings.general.quietCompanion()}
        disabled={!settings.ready()}
        class="rounded px-2 py-1 hover:bg-surface-base-hover focus-visible:outline"
        onClick={() => settings.general.setQuietCompanion(!settings.general.quietCompanion())}
      >
        CM3
      </button>
      <button
        type="button"
        role="switch"
        aria-label={language.t("theme.scheme.dark")}
        aria-checked={theme.mode() === "dark"}
        class="rounded px-2 py-1 hover:bg-surface-base-hover focus-visible:outline"
        onClick={() => theme.setColorScheme(theme.mode() === "dark" ? "light" : "dark")}
      >
        {language.t(theme.mode() === "dark" ? "theme.scheme.dark" : "theme.scheme.light")}
      </button>
    </div>
  )
}
