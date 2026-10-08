import { Show } from "solid-js"
import { createStore } from "solid-js/store"
import { Button } from "@opencode-ai/ui/button"
import { Popover } from "@opencode-ai/ui/popover"
import { usePlatform } from "@/context/platform"
import { useLanguage } from "@/context/language"
import { useSettings } from "@/context/settings"
import { showToast } from "@/utils/toast"
import "./wpp-auth-control.css"

export function WppAuthControl(props: { compact?: boolean }) {
  const platform = usePlatform()
  const language = useLanguage()
  const settings = useSettings()
  const [state, setState] = createStore({ open: false })
  const auth = () => platform.wppAuth
  const status = () => auth()?.state().status ?? "unknown"
  const label = () => language.t(`wpp.auth.${status()}`)
  const failed = () => showToast({ title: language.t("common.requestFailed") })

  return (
    <Show when={auth()}>
      <Popover
        open={state.open}
        onOpenChange={(open) => setState("open", open)}
        triggerAs={Button}
        triggerProps={{
          variant: "ghost",
          class: "flex items-center gap-2 px-2 text-xs [app-region:no-drag]",
          "aria-label": language.t("wpp.auth.label", { status: label() }),
        }}
        trigger={
          <>
            <span
              aria-hidden="true"
              class="size-2 shrink-0 rounded-full"
              classList={{
                "bg-icon-success-base": status() === "signed-in",
                "bg-icon-critical-base": status() === "signed-out",
                "bg-icon-warning-base": status() === "checking",
                "bg-icon-weak": status() === "unknown",
              }}
            />
            <span>{language.t("wpp.auth.label", { status: label() })}</span>
          </>
        }
        placement={props.compact ? "bottom-end" : "top-start"}
        class="wpp-auth-popover"
        classList={{ "cm3-wpp-popover": settings.general.quietCompanion() }}
      >
        <div data-component="wpp-auth-controls">
          <p role="status" class="wpp-auth-status">
            {language.t("wpp.auth.label", { status: label() })}
          </p>
          <p class="wpp-auth-checked">
            <Show keyed when={auth()?.state().checkedAt} fallback={language.t("wpp.auth.notChecked")}>
              {(time) => language.t("wpp.auth.lastChecked", { time: language.formatDate(time) })}
            </Show>
          </p>
          <Button
            variant="ghost"
            size="small"
            onClick={() => {
              void auth()?.toggleLogin().catch(failed)
            }}
          >
            {language.t(auth()?.state().loginVisible ? "wpp.auth.hideLogin" : "wpp.auth.showLogin")}
          </Button>
          <Button
            variant="ghost"
            size="small"
            disabled={status() === "checking"}
            onClick={() => {
              void auth()?.check().catch(failed)
            }}
          >
            {language.t("wpp.auth.check")}
          </Button>
        </div>
      </Popover>
    </Show>
  )
}
