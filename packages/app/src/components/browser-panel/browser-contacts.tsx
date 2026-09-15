import { Button } from "@opencode-ai/ui/button"
import { For, Show, createEffect } from "solid-js"
import { createStore } from "solid-js/store"
import {
  CONTACT_FIELDS,
  type BrowserContact,
  type BrowserCommand,
  type BrowserProfile,
  type BrowserTab,
} from "@/browser-panel"
import { useLanguage } from "@/context/language"

export function BrowserContacts(props: {
  profile: BrowserProfile
  tab?: BrowserTab
  busy: boolean
  command(value: BrowserCommand): Promise<unknown>
}) {
  const language = useLanguage()
  const [state, setState] = createStore({
    editing: undefined as BrowserContact | undefined,
    creating: false,
    query: "",
  })
  createEffect(() => {
    if (props.profile.vaultStatus !== "unlocked") setState({ editing: undefined, query: "" })
  })
  return (
    <div class="space-y-3">
      <p>{language.t("browser.contacts.help")}</p>
      <Show when={props.profile.contactsUnavailable}>
        <p role="alert">{language.t("browser.contacts.unavailable")}</p>
      </Show>
      <Show
        when={props.profile.vaultStatus === "unlocked" && !props.profile.contactsUnavailable}
        fallback={
          <Button
            size="small"
            disabled={props.busy || !props.profile.vaultAvailable || props.profile.vaultStatus !== "locked"}
            onClick={() => void props.command({ op: "unlock-vault" })}
          >
            {language.t("browser.passwords.unlock")}
          </Button>
        }
      >
        <Button
          size="small"
          disabled={props.busy}
          onClick={() =>
            setState({
              creating: true,
              editing: { id: crypto.randomUUID(), revision: crypto.randomUUID(), label: "", values: {} },
            })
          }
        >
          {language.t("browser.contacts.add")}
        </Button>
        <Show when={state.editing}>
          {(editing) => (
            <form
              class="space-y-2"
              onSubmit={(event) => {
                event.preventDefault()
                void props
                  .command({
                    op: "contact-save",
                    contact: { ...editing(), values: { ...editing().values } },
                    create: state.creating,
                  })
                  .then((result) => {
                    if (result !== false) setState("editing", undefined)
                  })
              }}
            >
              <label class="block">
                {language.t("browser.contacts.label")}
                <input
                  required
                  maxLength={100}
                  value={editing().label}
                  class="block w-full border rounded px-2 py-1"
                  onInput={(event) => setState("editing", "label", event.currentTarget.value)}
                />
              </label>
              <div class="grid grid-cols-1 sm:grid-cols-2 gap-2">
                <For each={CONTACT_FIELDS}>
                  {(field) => (
                    <label class="block">
                      {language.t(`browser.contacts.${field}`)}
                      <Show
                        when={field === "street-address"}
                        fallback={
                          <input
                            maxLength={field === "country" ? 2 : 1000}
                            value={editing().values[field] ?? ""}
                            type={field === "email" ? "email" : field === "tel" ? "tel" : "text"}
                            pattern={field === "country" ? "[A-Z]{2}" : undefined}
                            autocomplete="off"
                            class="block w-full border rounded px-2 py-1"
                            onInput={(event) =>
                              setState(
                                "editing",
                                "values",
                                field,
                                field === "country"
                                  ? event.currentTarget.value.toUpperCase()
                                  : event.currentTarget.value,
                              )
                            }
                          />
                        }
                      >
                        <textarea
                          maxLength={1000}
                          value={editing().values[field] ?? ""}
                          class="block w-full border rounded px-2 py-1"
                          onInput={(event) => setState("editing", "values", field, event.currentTarget.value)}
                        />
                      </Show>
                    </label>
                  )}
                </For>
              </div>
              <Button type="submit" size="small" disabled={props.busy}>
                {language.t("browser.bookmarks.save")}
              </Button>
              <Button type="button" size="small" variant="ghost" onClick={() => setState("editing", undefined)}>
                {language.t("common.cancel")}
              </Button>
            </form>
          )}
        </Show>
        <input
          type="search"
          value={state.query}
          aria-label={language.t("browser.contacts.search")}
          placeholder={language.t("browser.contacts.search")}
          class="block w-full border rounded px-2 py-1"
          onInput={(event) => setState("query", event.currentTarget.value)}
        />
        <For
          each={props.profile.contacts?.filter((row) =>
            `${row.label} ${Object.values(row.values).join(" ")}`.toLowerCase().includes(state.query.toLowerCase()),
          )}
          fallback={<p>{language.t("browser.records.noMatches")}</p>}
        >
          {(row) => (
            <div class="flex flex-wrap gap-2 items-center border-t py-2">
              <span class="flex-1 break-words">{row.label}</span>
              <Button
                size="small"
                disabled={props.busy || !props.tab || props.tab.agentAccess}
                onClick={() =>
                  props.tab &&
                  void props.command({ op: "contact-fill", tabID: props.tab.id, id: row.id, revision: row.revision })
                }
              >
                {language.t("browser.contacts.fill")}
              </Button>
              <Button
                size="small"
                variant="ghost"
                disabled={props.busy}
                onClick={() => setState({ creating: false, editing: { ...row, values: { ...row.values } } })}
              >
                {language.t("browser.bookmarks.edit")}
              </Button>
              <Button
                size="small"
                variant="ghost"
                disabled={props.busy}
                onClick={() => void props.command({ op: "contact-delete", id: row.id, revision: row.revision })}
              >
                {language.t("browser.bookmarks.delete")}
              </Button>
            </div>
          )}
        </For>
      </Show>
    </div>
  )
}
