import { createEffect, onCleanup, onMount } from "solid-js"
import { usePlatform } from "@/context/platform"
import { useLanguage } from "@/context/language"
import { showToast } from "@/utils/toast"

export function useBrowserLinks(input: { sessionID(): string | undefined; open(): void }) {
  const browser = usePlatform().browserPanel
  const language = useLanguage()
  if (!browser?.linkContext || !browser.onOpened) return
  const lease = crypto.randomUUID()
  createEffect(() => {
    void browser
      .linkContext?.(input.sessionID() ?? null, lease)
      .catch(() => showToast({ variant: "error", title: language.t("browser.toast.failed") }))
  })
  onMount(() => {
    const unsubscribe = browser.onOpened?.((sessionID) => {
      if (sessionID === input.sessionID()) input.open()
    })
    onCleanup(() => {
      unsubscribe?.()
      void browser.linkContext?.(null, lease).catch(() => undefined)
    })
  })
}
