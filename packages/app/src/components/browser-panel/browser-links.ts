import { createEffect, onCleanup, onMount } from "solid-js"
import { usePlatform } from "@/context/platform"
import { useLanguage } from "@/context/language"
import { showToast } from "@/utils/toast"
import type { DesktopPanelRequest } from "@/browser-panel"

export function useBrowserLinks(input: {
  sessionID(): string | undefined
  open(): void
  setPanel(request: DesktopPanelRequest): void
  reached(request: DesktopPanelRequest): boolean
}) {
  const browser = usePlatform().browserPanel
  const language = useLanguage()
  if (!browser?.linkContext) return
  const lease = crypto.randomUUID()
  let pending: DesktopPanelRequest | undefined
  let disposed = false
  let frame = 0
  const current = (request: DesktopPanelRequest) =>
    !disposed && pending === request && request.sessionID === input.sessionID() && Date.now() < request.deadline
  createEffect(() => {
    const sessionID = input.sessionID()
    if (pending?.sessionID !== sessionID) pending = undefined
    void browser
      .linkContext?.(sessionID ?? null, lease)
      .catch(() => showToast({ variant: "error", title: language.t("browser.toast.failed") }))
  })
  onMount(() => {
    const unsubscribe = browser.onOpened?.((sessionID) => {
      if (sessionID === input.sessionID()) input.open()
    })
    const cancel = browser.onPanelCancel?.((id) => {
      if (pending?.id !== id) return
      pending = undefined
      cancelAnimationFrame(frame)
    })
    const panel = browser.onPanelRequest?.((request) => {
      if (disposed || request.sessionID !== input.sessionID() || Date.now() >= request.deadline) return
      pending = request
      cancelAnimationFrame(frame)
      const acknowledge = async () => {
        if (!current(request)) return
        if (!(await browser.panelRequestCurrent?.(request.id, request.sessionID)) || !current(request)) return
        if (input.reached(request)) {
          const accepted = await browser.acknowledgePanel?.(
            request.view === "browser"
              ? { id: request.id, sessionID: request.sessionID, view: request.view, tabID: request.tabID }
              : { id: request.id, sessionID: request.sessionID, view: request.view },
          )
          if (accepted && pending === request) pending = undefined
        }
        // Main verifies native attachment. Keep waiting while renderer layout/viewport IPC settles.
        if (current(request)) frame = requestAnimationFrame(() => void acknowledge().catch(() => undefined))
      }
      void browser
        .panelRequestCurrent?.(request.id, request.sessionID)
        .then((valid) => {
          if (!valid || !current(request)) return
          input.setPanel(request)
          frame = requestAnimationFrame(() => void acknowledge().catch(() => undefined))
        })
        .catch(() => undefined)
    })
    onCleanup(() => {
      disposed = true
      pending = undefined
      cancelAnimationFrame(frame)
      panel?.()
      cancel?.()
      unsubscribe?.()
      void browser.linkContext?.(null, lease).catch(() => undefined)
    })
  })
}
