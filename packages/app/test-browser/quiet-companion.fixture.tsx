import { onCleanup, onMount, Show } from "solid-js"
import { createStore } from "solid-js/store"
import { render } from "solid-js/web"
import { DialogProvider } from "@opencode-ai/ui/context/dialog"
import { ThemeProvider, useTheme } from "@opencode-ai/ui/theme/context"
import { CommandProvider, useCommand } from "../src/context/command"
import { LanguageProvider, useLanguage } from "../src/context/language"
import { PlatformProvider, type Platform } from "../src/context/platform"
import { SettingsProvider, useSettings } from "../src/context/settings"
import { QuietCompanionControls, QuietCompanionSwitch } from "../src/components/quiet-companion-switch"
import { WppAuthControl } from "../src/components/wpp-auth-control"
import type { WppAuthState } from "../src/wpp-auth"

export function createAuthPlatform() {
  const [state, setState] = createStore<WppAuthState>({ status: "signed-out", checkedAt: null, loginVisible: false })
  const counts = { checks: 0, toggles: 0 }
  return {
    counts,
    update: setState,
    platform: {
      state: () => state,
      check: async () => {
        counts.checks++
        setState({ status: "signed-in", checkedAt: Date.now() })
        return { ...state }
      },
      toggleLogin: async () => {
        counts.toggles++
        setState("loginVisible", !state.loginVisible)
      },
    },
  }
}

export function mount(host: HTMLElement, platform: Platform) {
  const counts = { mounts: 0, cleanups: 0, commands: 0 }
  const refs: {
    settings?: ReturnType<typeof useSettings>
    command?: ReturnType<typeof useCommand>
    theme?: ReturnType<typeof useTheme>
    language?: ReturnType<typeof useLanguage>
  } = {}

  function Draft() {
    const [state, setState] = createStore({ draft: "" })
    onMount(() => counts.mounts++)
    onCleanup(() => counts.cleanups++)
    return (
      <textarea
        data-testid="draft"
        value={state.draft}
        onInput={(event) => setState("draft", event.currentTarget.value)}
      />
    )
  }

  function Content() {
    refs.settings = useSettings()
    refs.command = useCommand()
    refs.theme = useTheme()
    refs.language = useLanguage()
    refs.command.register(() => [
      { id: "quiet-test", title: "Test command", keybind: "alt+q", onSelect: () => counts.commands++ },
    ])
    return (
      <QuietCompanionSwitch>
        <Draft />
        <WppAuthControl />
        <Show when={refs.settings.general.quietCompanion()}>
          <QuietCompanionControls />
        </Show>
      </QuietCompanionSwitch>
    )
  }

  const dispose = render(
    () => (
      <PlatformProvider value={platform}>
        <LanguageProvider locale="en">
          <ThemeProvider>
            <SettingsProvider>
              <DialogProvider>
                <CommandProvider>
                  <Content />
                </CommandProvider>
              </DialogProvider>
            </SettingsProvider>
          </ThemeProvider>
        </LanguageProvider>
      </PlatformProvider>
    ),
    host,
  )

  return {
    dispose,
    counts,
    ready: () => refs.settings!.ready(),
    enabled: () => refs.settings!.general.quietCompanion(),
    enable: (value: boolean) => refs.settings!.general.setQuietCompanion(value),
    suspended: () => refs.command!.suspended(),
    theme: () => refs.theme!,
    language: () => refs.language!,
  }
}
