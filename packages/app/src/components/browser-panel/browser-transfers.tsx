import { For, Show } from "solid-js"
import { createStore } from "solid-js/store"
import { Button } from "@opencode-ai/ui/button"
import { useLanguage } from "@/context/language"
import type { BrowserCommand, BrowserTransferRule } from "@/browser-panel"

export function BrowserTransfers(props: {
  rules?: BrowserTransferRule[]
  command(value: BrowserCommand): Promise<unknown>
}) {
  const language = useLanguage()
  const [state, setState] = createStore({ origin: "" })
  return (
    <section class="rounded-lg border border-border-weak-base p-4 space-y-4">
      <h3 class="text-14-medium">{language.t("browser.transfer.title")}</h3>
      <p class="text-text-weak">{language.t("browser.transfer.help")}</p>
      <Show when={props.rules} fallback={<p>{language.t("browser.tools.nextLaunch")}</p>}>
        <For each={props.rules}>
          {(rule) => (
            <div class="flex flex-wrap items-center gap-3">
              <strong class="flex-1 break-all text-start" dir="ltr">
                {rule.origin === "*" ? language.t("browser.transfer.default") : rule.origin}
              </strong>
              <For each={["uploads", "downloads"] as const}>
                {(kind) => (
                  <label>
                    {language.t(`browser.transfer.${kind}`)}
                    <select
                      class="block border border-border-weak-base rounded p-2"
                      value={rule[kind]}
                      onChange={(event) =>
                        void props.command({
                          op: "transfer-rule",
                          rule: { ...rule, [kind]: event.currentTarget.value },
                        })
                      }
                    >
                      <For
                        each={kind === "uploads" ? (["block", "ask"] as const) : (["block", "ask", "allow"] as const)}
                      >
                        {(value) => (
                          <option value={value}>
                            {kind === "uploads" && value === "ask"
                              ? language.t("browser.transfer.choose")
                              : language.t(`browser.permission.${value}`)}
                          </option>
                        )}
                      </For>
                    </select>
                  </label>
                )}
              </For>
              <Show when={rule.origin !== "*"}>
                <Button
                  size="small"
                  variant="ghost"
                  onClick={() => void props.command({ op: "transfer-rule", rule, remove: true })}
                >
                  {language.t("browser.transfer.remove")}
                </Button>
              </Show>
            </div>
          )}
        </For>
        <form
          class="flex flex-wrap gap-3"
          onSubmit={(event) => {
            event.preventDefault()
            void props.command({
              op: "transfer-rule",
              rule: { origin: state.origin, uploads: "ask", downloads: "ask" },
            })
          }}
        >
          <label class="min-w-0 flex-1">
            {language.t("browser.settings.origin")}
            <input
              type="url"
              dir="ltr"
              required
              value={state.origin}
              onInput={(event) => setState("origin", event.currentTarget.value)}
              class="block w-full border border-border-weak-base rounded p-2"
              placeholder="https://example.com"
            />
          </label>
          <Button size="small" type="submit">
            {language.t("browser.settings.site.save")}
          </Button>
        </form>
      </Show>
    </section>
  )
}
