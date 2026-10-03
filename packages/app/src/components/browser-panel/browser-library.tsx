import { Button } from "@opencode-ai/ui/button"
import { For, Show } from "solid-js"
import { createStore } from "solid-js/store"
import { useLanguage } from "@/context/language"
import type { BrowserBookmark, BrowserCommand } from "@/browser-panel"

const folderLabel = (folder: string[]) => folder.join(" › ")
const folderValue = (value: string) => (value.trim() ? value.split("›").map((name) => name.trim()) : [])

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
    folder: "",
    pinned: false,
  })
  const groups = () => {
    const result = new Map<string, { folder: string[]; rows: BrowserBookmark[] }>()
    props.bookmarks
      .filter((row) =>
        `${row.title} ${row.url} ${folderLabel(row.folder)}`.toLowerCase().includes(state.query.toLowerCase()),
      )
      .forEach((row) => {
        const key = JSON.stringify(row.folder)
        const group = result.get(key) ?? { folder: row.folder, rows: [] }
        group.rows.push(row)
        result.set(key, group)
      })
    return [...result.values()]
  }
  const position = (row: BrowserBookmark) => {
    const siblings = props.bookmarks.filter((entry) => JSON.stringify(entry.folder) === JSON.stringify(row.folder))
    return { index: siblings.findIndex((entry) => entry.id === row.id), count: siblings.length }
  }
  return (
    <div class="space-y-3">
      <p class="text-text-weak">{language.t("browser.bookmarks.help")}</p>
      <div class="flex flex-wrap gap-2">
        <Button
          size="small"
          disabled={props.busy}
          onClick={() =>
            setState({ editing: true, id: undefined, title: "", url: "https://", folder: "", pinned: false })
          }
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
              .command({
                op: "bookmark-save",
                id: state.id,
                title: state.title,
                url: state.url,
                folder: folderValue(state.folder),
                pinned: state.pinned,
              })
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
            maxLength={65536}
            value={state.url}
            onInput={(event) => setState("url", event.currentTarget.value)}
          />
          <input
            aria-label={language.t("browser.bookmarks.folder")}
            placeholder={language.t("browser.bookmarks.folderPlaceholder")}
            class="border rounded px-2 py-1 min-w-40"
            maxLength={1031}
            value={state.folder}
            onInput={(event) => setState("folder", event.currentTarget.value)}
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
      <For each={groups()} fallback={<p>{language.t("browser.bookmarks.empty")}</p>}>
        {(group) => (
          <section class="space-y-1">
            <h3 class="font-medium text-text-strong">
              {group.folder.length ? folderLabel(group.folder) : language.t("browser.bookmarks.root")}
            </h3>
            <For each={group.rows}>
              {(row) => {
                const order = () => position(row)
                return (
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
                      disabled={props.busy || order().index <= 0}
                      onClick={() => void props.command({ op: "bookmark-move", id: row.id, direction: "up" })}
                    >
                      {language.t("browser.bookmarks.up")}
                    </Button>
                    <Button
                      size="small"
                      variant="ghost"
                      disabled={props.busy || order().index >= order().count - 1}
                      onClick={() => void props.command({ op: "bookmark-move", id: row.id, direction: "down" })}
                    >
                      {language.t("browser.bookmarks.down")}
                    </Button>
                    <Button
                      size="small"
                      variant="ghost"
                      disabled={props.busy}
                      onClick={() => void props.command({ op: "bookmark-save", ...row, pinned: !row.pinned })}
                    >
                      {language.t(row.pinned ? "browser.bookmarks.unpin" : "browser.bookmarks.pin")}
                    </Button>
                    <Button
                      size="small"
                      variant="ghost"
                      disabled={props.busy}
                      onClick={() => setState({ ...row, folder: folderLabel(row.folder), editing: true })}
                    >
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
                )
              }}
            </For>
          </section>
        )}
      </For>
    </div>
  )
}
