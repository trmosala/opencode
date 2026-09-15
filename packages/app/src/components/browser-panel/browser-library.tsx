import { Button } from "@opencode-ai/ui/button"
import { For, Show } from "solid-js"
import { createStore } from "solid-js/store"
import { useLanguage } from "@/context/language"
import type { BrowserBookmark, BrowserCommand } from "@/browser-panel"

export function BrowserLibrary(props: {
  bookmarks: BrowserBookmark[]
  busy: boolean
  command(value: BrowserCommand): Promise<unknown>
}) {
  const language = useLanguage()
  const [state, setState] = createStore({
    query: "",
    editing: false,
    id: undefined as string | undefined,
    title: "",
    url: "",
    pinned: false,
  })
  return (
    <div class="space-y-3">
      <p class="text-text-weak">{language.t("browser.bookmarks.help")}</p>
      <div class="flex flex-wrap gap-2">
        <Button
          size="small"
          disabled={props.busy}
          onClick={() => setState({ editing: true, id: undefined, title: "", url: "https://", pinned: false })}
        >
          {language.t("browser.bookmarks.add")}
        </Button>
        <Button size="small" disabled={props.busy} onClick={() => void props.command({ op: "bookmark-import" })}>
          {language.t("browser.bookmarks.import")}
        </Button>
        <Button size="small" disabled={props.busy} onClick={() => void props.command({ op: "bookmark-export" })}>
          {language.t("browser.bookmarks.export")}
        </Button>
      </div>
      <Show when={state.editing}>
        <form
          class="flex flex-wrap gap-2"
          onSubmit={(event) => {
            event.preventDefault()
            void props
              .command({ op: "bookmark-save", id: state.id, title: state.title, url: state.url, pinned: state.pinned })
              .then((result) => {
                if (result !== false) setState("editing", false)
              })
          }}
        >
          <input
            aria-label={language.t("browser.bookmarks.title")}
            placeholder={language.t("browser.bookmarks.title")}
            class="border rounded px-2 py-1"
            maxLength={512}
            value={state.title}
            onInput={(event) => setState("title", event.currentTarget.value)}
          />
          <input
            aria-label={language.t("browser.address.label")}
            class="border rounded px-2 py-1 flex-1 min-w-40"
            required
            type="url"
            maxLength={2048}
            value={state.url}
            onInput={(event) => setState("url", event.currentTarget.value)}
          />
          <label class="flex items-center gap-1">
            <input
              type="checkbox"
              checked={state.pinned}
              onChange={(event) => setState("pinned", event.currentTarget.checked)}
            />
            {language.t("browser.bookmarks.pin")}
          </label>
          <Button type="submit" size="small" disabled={props.busy}>
            {language.t("browser.bookmarks.save")}
          </Button>
          <Button type="button" size="small" variant="ghost" onClick={() => setState("editing", false)}>
            {language.t("common.cancel")}
          </Button>
        </form>
      </Show>
      <input
        type="search"
        aria-label={language.t("browser.bookmarks.search")}
        placeholder={language.t("browser.bookmarks.search")}
        class="w-full border rounded px-2 py-1"
        value={state.query}
        onInput={(event) => setState("query", event.currentTarget.value)}
      />
      <For
        each={props.bookmarks.filter((row) =>
          `${row.title} ${row.url}`.toLowerCase().includes(state.query.toLowerCase()),
        )}
        fallback={<p>{language.t("browser.bookmarks.empty")}</p>}
      >
        {(row) => (
          <div class="flex flex-wrap items-center gap-2 border-t border-border-weaker-base py-2">
            <button
              class="min-w-0 flex-1 text-left truncate"
              title={row.url}
              onClick={() => void props.command({ op: "open-link", url: row.url, destination: "browser" })}
            >
              {row.title}
              <span class="block text-text-weak truncate">{row.url}</span>
            </button>
            <Button
              size="small"
              variant="ghost"
              disabled={props.busy}
              onClick={() => void props.command({ op: "bookmark-save", ...row, pinned: !row.pinned })}
            >
              {language.t(row.pinned ? "browser.bookmarks.unpin" : "browser.bookmarks.pin")}
            </Button>
            <Button size="small" variant="ghost" onClick={() => setState({ ...row, editing: true })}>
              {language.t("browser.bookmarks.edit")}
            </Button>
            <Button
              size="small"
              variant="ghost"
              disabled={props.busy}
              onClick={() => void props.command({ op: "bookmark-delete", id: row.id })}
            >
              {language.t("browser.bookmarks.delete")}
            </Button>
          </div>
        )}
      </For>
    </div>
  )
}
