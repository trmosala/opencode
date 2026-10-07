import { createEffect, on, type ParentProps } from "solid-js"
import { useDialog } from "@opencode-ai/ui/context/dialog"
import { useTheme } from "@opencode-ai/ui/theme/context"
import { useLanguage } from "@/context/language"
import { usePlatform } from "@/context/platform"
import { useSettings } from "@/context/settings"
import { Cm3Icon } from "./cm3-icon"
import "./quiet-companion-switch.css"
import "./cm3-live.css"

export function QuietCompanionSwitch(props: ParentProps) {
  const settings = useSettings()
  const platform = usePlatform()
  const dialog = useDialog()
  const refs: { root?: HTMLDivElement; focus?: HTMLElement } = {}
  const enabled = () => settings.general.quietCompanion()
  const zoom = () => platform.webviewZoom?.() ?? 1
  createEffect(
    on(enabled, (value, previous) => {
      if (value || !previous) return
      queueMicrotask(() => {
        if (enabled() || dialog.active) return
        const target = refs.focus?.isConnected
          ? refs.focus
          : refs.root?.querySelector<HTMLElement>(
              'textarea:not([disabled]), [contenteditable="true"], button:not([disabled])',
            )
        target?.focus({ preventScroll: true })
      })
    }),
  )
  return (
    <div
      ref={(element) => (refs.root = element)}
      onFocusIn={(event) => {
        if (!enabled() && event.target instanceof HTMLElement) refs.focus = event.target
      }}
      data-component="current-ui"
      classList={{ "cm3-live": enabled(), "cm-quiet-shell": enabled() }}
      style={{
        display: enabled() ? "flex" : "contents",
        "--cm3-native-start":
          platform.platform === "desktop" && platform.os === "macos" && !platform.windowFullscreen?.()
            ? `${80 / zoom()}px`
            : "0px",
        "--cm3-native-end": platform.platform === "desktop" && platform.os === "windows" ? `${138 / zoom()}px` : "0px",
        "--cm3-header-height": platform.platform === "desktop" ? `${40 / Math.min(zoom(), 1)}px` : "40px",
      }}
    >
      {props.children}
    </div>
  )
}

export function QuietCompanionControls() {
  const settings = useSettings()
  const language = useLanguage()
  const theme = useTheme()
  return (
    <div class="cm-quiet-bar">
      <label class="cm-quiet-scheme">
        <span class="qc-sr-only">{language.t("settings.general.row.colorScheme.title")}</span>
        <span class="cm3-select">
          <select
            data-action="quiet-companion-scheme"
            value={theme.colorScheme()}
            onChange={(event) => {
              const scheme = event.currentTarget.value
              if (scheme === "light" || scheme === "dark" || scheme === "system") theme.setColorScheme(scheme)
            }}
          >
            <option value="system">{language.t("theme.scheme.system")}</option>
            <option value="light">{language.t("theme.scheme.light")}</option>
            <option value="dark">{language.t("theme.scheme.dark")}</option>
          </select>
          <Cm3Icon name="caret-down" size={12} />
        </span>
      </label>
      <button
        type="button"
        data-action="quiet-companion-return"
        onClick={() => settings.general.setQuietCompanion(false)}
      >
        {language.t("quietCompanion.return")}
      </button>
    </div>
  )
}
