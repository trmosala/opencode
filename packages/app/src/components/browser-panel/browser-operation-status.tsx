import { Button } from "@opencode-ai/ui/button"
import { Show } from "solid-js"
import type { BrowserCommand, BrowserTab } from "@/browser-panel"
import { useLanguage } from "@/context/language"

export function BrowserOperationStatus(props: {
  tab: BrowserTab
  command: (command: BrowserCommand) => Promise<boolean>
}) {
  const language = useLanguage()
  const recovery = () => props.tab.operation?.status === "quarantined" || props.tab.failure?.kind === "crash"
  return (
    <Show when={props.tab.operation || props.tab.failure || props.tab.notice}>
      <div
        role={
          recovery() || props.tab.operation?.status === "failed" || props.tab.failure || props.tab.notice
            ? "alert"
            : "status"
        }
        aria-live="polite"
        data-browser-operation
        class="shrink-0 border-b border-border-weaker-base p-2 text-12-regular"
      >
        <Show when={props.tab.operation}>
          {(operation) => <p>{language.t(`browser.operation.${operation().status}`)}</p>}
        </Show>
        <Show when={props.tab.failure?.message || props.tab.operation?.message}>{(message) => <p>{message()}</p>}</Show>
        <Show when={props.tab.notice?.message}>{(message) => <p>{message()}</p>}</Show>
        <Show when={props.tab.operation?.actionStatus === "dispatched_uncertain"}>
          <p>{language.t("browser.operation.uncertain")}</p>
        </Show>
        <Show when={recovery()}>
          <p>{language.t("browser.operation.recovery")}</p>
          <Button type="button" size="small" onClick={() => void props.command({ op: "close", tabID: props.tab.id })}>
            {language.t("browser.operation.close")}
          </Button>
        </Show>
        <Show when={props.tab.agentAccess}>
          <Button
            type="button"
            size="small"
            onClick={() => void props.command({ op: "access", tabID: props.tab.id, enabled: false })}
          >
            {language.t("browser.operation.takeover")}
          </Button>
        </Show>
      </div>
    </Show>
  )
}
