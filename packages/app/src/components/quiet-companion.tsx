import { createEffect, createMemo, For, on, Show, type JSX } from "solid-js"
import { Dynamic } from "solid-js/web"
import { useTheme } from "@opencode-ai/ui/theme/context"
import { createStore } from "solid-js/store"
import { Cm3Icon } from "./cm3-icon"
import { useLanguage } from "@/context/language"
import { usePlatform } from "@/context/platform"
import "./quiet-companion.css"

type Attachment = { name: string; size: number; type: string; lastModified: number }
type Message = { text: string; mode: string; model: string; project: string; attachments: Attachment[] }

export default function QuietCompanion(props: { controls: JSX.Element }) {
  const language = useLanguage()
  const platform = usePlatform()
  const theme = useTheme()
  const refs: {
    context?: HTMLElement
    composer?: HTMLTextAreaElement
    search?: HTMLInputElement
    attachment?: HTMLInputElement
  } = {}
  const threads = [
    {
      id: "sample",
      title: "quietCompanion.authThread",
      user: "quietCompanion.userMessage",
      reply: "quietCompanion.assistantMessage",
      project: "quietCompanion.bridgeProject",
    },
    {
      id: "permissions",
      title: "quietCompanion.permissionsThread",
      user: "quietCompanion.permissionsMessage",
      reply: "quietCompanion.permissionsReply",
      project: "quietCompanion.browserProject",
    },
    {
      id: "release",
      title: "quietCompanion.releaseThread",
      user: "quietCompanion.releaseMessage",
      reply: "quietCompanion.releaseReply",
      project: "quietCompanion.releaseProject",
    },
    {
      id: "recovery",
      title: "quietCompanion.recoveryThread",
      user: "quietCompanion.recoveryMessage",
      reply: "quietCompanion.recoveryReply",
      project: "quietCompanion.sessionProject",
    },
  ] as const
  const modes = [
    { id: "code", label: "quietCompanion.code" },
    { id: "plan", label: "quietCompanion.plan" },
  ] as const
  const models = [
    { id: "astra", label: "quietCompanion.astra" },
    { id: "compact", label: "quietCompanion.compactModel" },
  ] as const
  const files = [
    {
      name: "worker-pool.ts",
      start: 214,
      lines: [
        "  async run(job, onProgress) {",
        "    const worker = await this.acquire(job.agent)",
        "    const result = await worker.runJob(job)",
        "    const authRequired = result.authRequired",
        " ",
        "    if (authRequired) {",
        "-     this.release(worker)",
        "+     await this.discard(worker)",
        "+     this.authEpoch++",
        "      return result",
        "    }",
        " ",
        "    onProgress(result)",
        "    this.release(worker)",
        "    return result",
        "  }",
        " ",
        "  async discard(worker) {",
        "    this.workers.delete(worker.id)",
        "    await worker.close()",
        "  }",
        " ",
        "  release(worker) {",
        "    worker.busy = false",
        "    worker.lastUsed = Date.now()",
        "  }",
      ],
    },
    {
      name: "worker-pool.test.ts",
      start: 38,
      lines: [
        '  test("discards expired worker", async () => {',
        "    const pool = await createPool()",
        "    await pool.run(expiredSession)",
        " ",
        "-   expect(pool.idle).toHaveLength(1)",
        "+   expect(pool.idle).toHaveLength(0)",
        "    await pool.close()",
        "  })",
      ],
    },
    {
      name: "openaiCompat.mjs",
      start: 92,
      lines: [
        "  const authState = await bridge.checkAuthState()",
        " ",
        "  if (authState.loggedOut) {",
        "-   return captureFailure()",
        "+   return loginRequiredFailure()",
        "  }",
        " ",
        "  return result",
      ],
    },
  ].map((file) => ({
    ...file,
    added: file.lines.filter((line) => line.startsWith("+")).length,
    removed: file.lines.filter((line) => line.startsWith("-")).length,
    rows: file.lines.map((line, index) => ({
      text: line.slice(1),
      kind: line.startsWith("+") ? "ins" : line.startsWith("-") ? "del" : "span",
      old: line.startsWith("+")
        ? ""
        : file.start + file.lines.slice(0, index).filter((line) => !line.startsWith("+")).length,
      next: line.startsWith("-")
        ? ""
        : file.start + file.lines.slice(0, index).filter((line) => !line.startsWith("-")).length,
      sign: line.startsWith("+") ? "+" : line.startsWith("-") ? "-" : " ",
    })),
  }))
  const pages = [
    {
      url: "http://localhost:3000/",
      label: "quietCompanion.site",
      heading: "quietCompanion.siteHeading",
      description: "quietCompanion.siteDescription",
    },
    {
      url: "http://localhost:3000/product",
      label: "quietCompanion.product",
      heading: "quietCompanion.productHeading",
      description: "quietCompanion.productDescription",
    },
    {
      url: "http://localhost:3000/customers",
      label: "quietCompanion.customers",
      heading: "quietCompanion.customersHeading",
      description: "quietCompanion.customersDescription",
    },
  ] as const
  const [state, setState] = createStore({
    thread: "sample" as false | string,
    project: "sample",
    navigation: false,
    projects: false,
    settings: false,
    search: "",
    context: "changes",
    file: 0,
    message: "",
    mode: "code",
    model: "astra",
    attachments: [] as Attachment[],
    attachmentError: false,
    messages: [] as Message[],
    address: pages[0].url as string,
    history: [pages[0].url] as string[],
    index: 0,
    invalidAddress: false,
    reloads: 0,
    browserSettings: false,
    pageDetails: true,
  })
  const sample = createMemo(() => threads.find((thread) => thread.id === state.thread))
  const project = createMemo(() => threads.find((thread) => thread.id === state.project) ?? threads[0])
  const landing = () => !state.thread && !state.projects && !state.settings
  const filtered = createMemo(() => {
    const query = state.search.trim().toLowerCase()
    return threads.filter((thread) =>
      [thread.title, thread.user, thread.reply, thread.project].some((key) =>
        language.t(key).toLowerCase().includes(query),
      ),
    )
  })
  const localMatch = createMemo(
    () =>
      state.messages.length > 0 &&
      [
        language.t("quietCompanion.conversation"),
        ...state.messages.flatMap((message) => [message.text, ...message.attachments.map((file) => file.name)]),
      ].some((text) => text.toLowerCase().includes(state.search.trim().toLowerCase())),
  )
  const currentUrl = () => state.history[state.index]
  const page = createMemo(() => pages.find((page) => page.url === currentUrl()))
  const modeLabel = (id: string) => language.t(modes.find((mode) => mode.id === id)!.label)
  const modelLabel = (id: string) => language.t(models.find((model) => model.id === id)!.label)
  const navigate = (address: string) => {
    const url = httpUrl(address)
    if (!url) {
      setState("invalidAddress", true)
      return
    }
    setState({
      address: url,
      history: [...state.history.slice(0, state.index + 1), url],
      index: state.index + 1,
      invalidAddress: false,
      reloads: 0,
    })
  }
  const travel = (offset: number) => {
    const index = state.index + offset
    if (index < 0 || index >= state.history.length) return
    setState({ index, address: state.history[index], invalidAddress: false, reloads: 0 })
  }
  const starters = [
    {
      icon: "magnifying-glass",
      title: "quietCompanion.trace",
      prompt: "quietCompanion.tracePrompt",
    },
    {
      icon: "code",
      title: "quietCompanion.build",
      prompt: "quietCompanion.buildPrompt",
    },
    {
      icon: "eye",
      title: "quietCompanion.review",
      prompt: "quietCompanion.reviewPrompt",
    },
  ] as const

  createEffect(
    on(
      () => [state.message, landing()] as const,
      () => {
        if (!refs.composer) return
        refs.composer.style.height = "0px"
        refs.composer.style.height = `${Math.min(refs.composer.scrollHeight, 160)}px`
      },
    ),
  )

  return (
    <div
      class="cm-quiet-design"
      data-thread={!!state.thread}
      data-landing={landing()}
      data-navigation={state.navigation}
    >
      <aside class="qc-nav" aria-label={language.t("quietCompanion.threads")}>
        <div class="qc-brand">
          <strong>{language.t("quietCompanion.title")}</strong>
          <button
            type="button"
            class="qc-nav-close"
            aria-label={language.t("quietCompanion.closeNavigation")}
            onClick={() => {
              setState("navigation", false)
              refs.composer?.focus()
            }}
          >
            <Cm3Icon name="x" />
          </button>
        </div>
        <button
          type="button"
          class="qc-new-task"
          onClick={() => {
            setState({ thread: false, projects: false, settings: false, navigation: false })
            refs.composer?.focus()
          }}
        >
          <Cm3Icon name="note-pencil" />
          {language.t("quietCompanion.newTask")}
        </button>
        <label class="qc-search">
          <Cm3Icon name="magnifying-glass" />
          <input
            ref={(element) => (refs.search = element)}
            type="search"
            placeholder={language.t("quietCompanion.search")}
            aria-label={language.t("quietCompanion.searchThreads")}
            value={state.search}
            onInput={(event) => setState("search", event.currentTarget.value)}
          />
          <Show when={state.search}>
            <button
              type="button"
              aria-label={language.t("quietCompanion.clearSearch")}
              onClick={() => {
                setState("search", "")
                refs.search?.focus()
              }}
            >
              <Cm3Icon name="x" />
            </button>
          </Show>
        </label>
        <p class="qc-section-label">{language.t("quietCompanion.pinned")}</p>
        <div class="qc-history">
          <For each={filtered()}>
            {(thread) => (
              <button
                type="button"
                data-thread-id={thread.id}
                classList={{ active: !state.projects && state.thread === thread.id }}
                aria-current={!state.projects && state.thread === thread.id ? "page" : undefined}
                onClick={() => {
                  setState({
                    thread: thread.id,
                    project: thread.id,
                    projects: false,
                    settings: false,
                    navigation: false,
                  })
                  refs.composer?.focus()
                }}
              >
                <Cm3Icon name="star" />
                <span>{language.t(thread.title)}</span>
              </button>
            )}
          </For>
          <Show when={localMatch()}>
            <button
              type="button"
              data-action="quiet-companion-conversation"
              classList={{ active: !state.projects && state.thread === "conversation" }}
              aria-current={!state.projects && state.thread === "conversation" ? "page" : undefined}
              onClick={() => {
                setState({ thread: "conversation", projects: false, settings: false, navigation: false })
                refs.composer?.focus()
              }}
            >
              {language.t("quietCompanion.conversation")}
            </button>
          </Show>
          <Show when={!filtered().length && !localMatch()}>
            <p role="status">{language.t("quietCompanion.noThreads")}</p>
          </Show>
        </div>
        <div class="qc-primary">
          <button
            type="button"
            class="qc-nav-link"
            aria-pressed={state.projects}
            onClick={() => {
              setState({ projects: !state.projects, settings: false, navigation: false })
              refs.composer?.focus()
            }}
          >
            {language.t("quietCompanion.projects")}
            <Cm3Icon name="caret-right" />
          </button>
          <For each={filtered()}>
            {(thread) => (
              <button
                type="button"
                class="qc-project-link"
                onClick={() => {
                  setState({
                    thread: thread.id,
                    project: thread.id,
                    projects: false,
                    settings: false,
                    navigation: false,
                  })
                  refs.composer?.focus()
                }}
              >
                <Cm3Icon name="folder" />
                <span>{language.t(thread.project)}</span>
              </button>
            )}
          </For>
        </div>
        <button
          type="button"
          class="qc-settings"
          aria-pressed={state.settings}
          onClick={() => setState({ settings: !state.settings, projects: false, navigation: false })}
        >
          <Cm3Icon name="gear" />
          {language.t("quietCompanion.settings")}
        </button>
      </aside>

      <header class="qc-main-header">
        <button
          type="button"
          class="qc-mobile-nav"
          aria-label={language.t("quietCompanion.threads")}
          aria-expanded={state.navigation}
          onClick={() => setState("navigation", !state.navigation)}
        >
          <Cm3Icon name="sidebar-simple" />
        </button>
        <div class="qc-breadcrumb">
          <strong>
            {language.t(
              state.settings
                ? "quietCompanion.settings"
                : state.projects
                  ? "quietCompanion.projects"
                  : (sample()?.title ??
                    (state.thread === "conversation" ? "quietCompanion.conversation" : "quietCompanion.newTask")),
            )}
          </strong>
          <Show when={sample() && !state.projects && !state.settings}>
            <span>{language.t(sample()!.project)}</span>
          </Show>
        </div>
        <Show when={state.thread}>
          <button
            type="button"
            class="qc-context-shortcut"
            aria-label={language.t("quietCompanion.reviewTab")}
            onClick={() => {
              setState("context", "changes")
              refs.context?.scrollIntoView({ block: "nearest" })
            }}
          >
            <Cm3Icon name="git-diff" />
          </button>
        </Show>
        {props.controls}
      </header>

      <main class="qc-main">
        <div class="qc-conversation">
          <Show when={landing()}>
            <div class="qc-heading">
              <h1 dir="auto">{language.t("quietCompanion.heading", { project: language.t(project().project) })}</h1>
            </div>
          </Show>
          <div class="qc-content" hidden={landing()}>
            <Show when={state.settings}>
              <section class="qc-appearance" aria-label={language.t("quietCompanion.settings")}>
                <h1>{language.t("quietCompanion.settingsHeading")}</h1>
                <label>
                  <span>{language.t("settings.general.row.colorScheme.title")}</span>
                  <span class="cm3-select">
                    <select
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
              </section>
            </Show>
            <Show when={state.projects}>
              <section class="qc-projects" aria-label={language.t("quietCompanion.projects")}>
                <For each={threads}>
                  {(thread) => (
                    <button
                      type="button"
                      onClick={() => {
                        setState({
                          thread: thread.id,
                          project: thread.id,
                          projects: false,
                          settings: false,
                          navigation: false,
                        })
                        refs.composer?.focus()
                      }}
                    >
                      <strong>{language.t(thread.project)}</strong>
                      <span>{language.t(thread.title)}</span>
                    </button>
                  )}
                </For>
              </section>
            </Show>
            <Show when={!state.projects && !state.settings}>
              <Show when={state.thread}>
                <div class="qc-thread">
                  <Show
                    when={sample()}
                    fallback={
                      <div>
                        <For each={state.messages}>
                          {(message) => (
                            <article class="qc-local-message">
                              <Show when={message.text}>
                                <p class="qc-user-message" dir="auto">
                                  {message.text}
                                </p>
                              </Show>
                              <p class="qc-message-options">
                                {language.t("quietCompanion.projectOptions", {
                                  project: language.t(
                                    (threads.find((thread) => thread.id === message.project) ?? threads[0]).project,
                                  ),
                                  mode: modeLabel(message.mode),
                                  model: modelLabel(message.model),
                                })}
                              </p>
                              <ul class="qc-message-attachments">
                                <For each={message.attachments}>
                                  {(file) => (
                                    <li dir="auto">
                                      {language.t("quietCompanion.fileMetadata", {
                                        name: file.name,
                                        size: file.size,
                                        type: file.type || language.t("quietCompanion.unknownType"),
                                      })}
                                    </li>
                                  )}
                                </For>
                              </ul>
                            </article>
                          )}
                        </For>
                      </div>
                    }
                  >
                    {(thread) => (
                      <div>
                        <p class="qc-user-message" dir="auto">
                          {language.t(thread().user)}
                        </p>
                        <article class="qc-assistant-message">
                          <div>
                            <p>{language.t(thread().reply)}</p>
                            <Show when={thread().id === "sample"}>
                              <p>{language.t("quietCompanion.assistantDetail")}</p>
                              <section class="qc-change-card" aria-label={language.t("quietCompanion.changeSummary")}>
                                <button
                                  type="button"
                                  class="qc-inline-change"
                                  onClick={() => {
                                    setState("context", "changes")
                                    refs.context?.scrollIntoView({ block: "nearest" })
                                  }}
                                >
                                  <strong>{language.t("quietCompanion.changeSummary")}</strong>
                                  <small dir="ltr">{language.t("quietCompanion.diffSummary")}</small>
                                </button>
                                <For each={files}>
                                  {(file, index) => (
                                    <button
                                      type="button"
                                      class="qc-change-file"
                                      onClick={() => {
                                        setState({ file: index(), context: "changes" })
                                        refs.context?.scrollIntoView({ block: "nearest" })
                                      }}
                                    >
                                      <bdi dir="ltr">{file.name}</bdi>
                                      <span class="qc-file-stats" dir="ltr">
                                        <span class="qc-added">+{file.added}</span>
                                        <span class="qc-removed">−{file.removed}</span>
                                      </span>
                                      <Cm3Icon name="caret-right" />
                                    </button>
                                  )}
                                </For>
                              </section>
                            </Show>
                          </div>
                        </article>
                      </div>
                    )}
                  </Show>
                </div>
              </Show>
            </Show>
          </div>
          <form
            class="qc-composer"
            onSubmit={(event) => {
              event.preventDefault()
              const message = state.message.trim()
              if (!message && !state.attachments.length) return
              setState({
                messages: [
                  ...state.messages,
                  {
                    text: message,
                    mode: state.mode,
                    model: state.model,
                    project: project().id,
                    attachments: state.attachments.map((file) => ({ ...file })),
                  },
                ],
                message: "",
                attachments: [],
                attachmentError: false,
                thread: "conversation",
                projects: false,
                settings: false,
                navigation: false,
              })
              refs.composer?.focus()
            }}
          >
            <textarea
              ref={(element) => (refs.composer = element)}
              aria-label={language.t("quietCompanion.message")}
              placeholder={language.t("quietCompanion.placeholder")}
              value={state.message}
              dir="auto"
              rows={2}
              onInput={(event) => setState("message", event.currentTarget.value)}
              onKeyDown={(event) => {
                if (event.isComposing || event.key !== "Enter" || (!event.ctrlKey && !event.metaKey)) return
                event.preventDefault()
                event.currentTarget.form?.requestSubmit()
              }}
            />
            <div class="qc-attachments">
              <input
                ref={(element) => (refs.attachment = element)}
                type="file"
                hidden
                aria-label={language.t("quietCompanion.attach")}
                multiple
                aria-describedby="cm3-attachment-help"
                onChange={(event) => {
                  const selected = Array.from(event.currentTarget.files ?? [])
                  event.currentTarget.value = ""
                  const files = [
                    ...state.attachments,
                    ...selected.map((file) => ({
                      name: file.name,
                      size: file.size,
                      type: file.type,
                      lastModified: file.lastModified,
                    })),
                  ]
                  if (
                    files.length > 5 ||
                    files.some((file) => file.size > 5 * 1024 * 1024) ||
                    files.reduce((total, file) => total + file.size, 0) > 10 * 1024 * 1024
                  ) {
                    setState("attachmentError", true)
                    return
                  }
                  setState({ attachments: files, attachmentError: false })
                }}
              />
              <Show when={state.attachmentError}>
                <p role="alert">{language.t("quietCompanion.attachmentError")}</p>
              </Show>
              <ul>
                <For each={state.attachments}>
                  {(file, index) => (
                    <li>
                      <bdi>
                        {language.t("quietCompanion.fileMetadata", {
                          name: file.name,
                          size: file.size,
                          type: file.type || language.t("quietCompanion.unknownType"),
                        })}
                      </bdi>
                      <button
                        type="button"
                        aria-label={language.t("quietCompanion.removeAttachment", { name: file.name })}
                        onClick={() => {
                          setState({
                            attachments: state.attachments.filter((_, current) => current !== index()),
                            attachmentError: false,
                          })
                          refs.composer?.focus()
                        }}
                      >
                        {language.t("quietCompanion.remove")}
                      </button>
                    </li>
                  )}
                </For>
              </ul>
            </div>
            <div class="qc-composer-footer">
              <button
                type="button"
                class="qc-attach"
                aria-label={language.t("quietCompanion.attach")}
                aria-describedby="cm3-attachment-help"
                title={language.t("quietCompanion.attach")}
                onClick={() => refs.attachment?.click()}
              >
                <Cm3Icon name="plus" />
              </button>
              <label class="qc-mode">
                <span class="qc-sr-only">{language.t("quietCompanion.mode")}</span>
                <span class="cm3-select">
                  <select
                    value={state.mode}
                    onChange={(event) => {
                      if (modes.some((mode) => mode.id === event.currentTarget.value))
                        setState("mode", event.currentTarget.value)
                    }}
                  >
                    <For each={modes}>{(mode) => <option value={mode.id}>{language.t(mode.label)}</option>}</For>
                  </select>
                  <Cm3Icon name="caret-down" size={12} />
                </span>
              </label>
              <label class="qc-model">
                <span class="qc-sr-only">{language.t("quietCompanion.model")}</span>
                <span class="cm3-select">
                  <select
                    value={state.model}
                    onChange={(event) => {
                      if (models.some((model) => model.id === event.currentTarget.value))
                        setState("model", event.currentTarget.value)
                    }}
                  >
                    <For each={models}>{(model) => <option value={model.id}>{language.t(model.label)}</option>}</For>
                  </select>
                  <Cm3Icon name="caret-down" size={12} />
                </span>
              </label>
              <details class="qc-attachment-limits">
                <summary
                  aria-label={language.t("quietCompanion.attachmentLimits")}
                  title={language.t("quietCompanion.attachmentLimits")}
                >
                  <Cm3Icon name="question" />
                </summary>
                <p id="cm3-attachment-help">{language.t("quietCompanion.attachmentHelp")}</p>
              </details>
              <button
                type="submit"
                class="qc-send"
                aria-label={language.t("quietCompanion.openThread")}
                aria-keyshortcuts="Control+Enter Meta+Enter"
                title={language.t("quietCompanion.submitShortcut", {
                  shortcut: platform.os === "macos" ? "⌘ Enter" : "Ctrl+Enter",
                })}
                disabled={!state.message.trim() && !state.attachments.length}
              >
                <Cm3Icon name="arrow-up" />
              </button>
            </div>
          </form>
          <Show when={landing()}>
            <div class="qc-project-row">
              <label class="qc-project-picker">
                <Cm3Icon name="folder" />
                <span class="qc-sr-only">{language.t("quietCompanion.selectProject")}</span>
                <span class="cm3-select">
                  <select
                    value={state.project}
                    onChange={(event) => {
                      if (threads.some((thread) => thread.id === event.currentTarget.value))
                        setState("project", event.currentTarget.value)
                    }}
                  >
                    <For each={threads}>
                      {(thread) => <option value={thread.id}>{language.t(thread.project)}</option>}
                    </For>
                  </select>
                  <Cm3Icon name="caret-down" size={12} />
                </span>
              </label>
              <span>{language.t("quietCompanion.local")}</span>
            </div>
            <ul class="qc-starters" aria-label={language.t("quietCompanion.suggestions")}>
              <For each={starters}>
                {(starter) => (
                  <li>
                    <button
                      type="button"
                      onClick={() => {
                        const prompt = language.t(starter.prompt)
                        setState("message", (message) => (message ? `${message}\n\n${prompt}` : prompt))
                        refs.composer?.focus()
                      }}
                    >
                      <Cm3Icon name={starter.icon} />
                      {language.t(starter.title)}
                    </button>
                  </li>
                )}
              </For>
            </ul>
          </Show>
          <p class="cm-quiet-notice">{language.t("quietCompanion.notice")}</p>
        </div>
      </main>

      <aside
        ref={(element) => (refs.context = element)}
        class="qc-context"
        hidden={!state.thread}
        inert={!state.thread}
        aria-label={language.t("quietCompanion.context")}
      >
        <header class="qc-context-header">
          <For each={["changes", "browser"] as const}>
            {(context) => (
              <button
                type="button"
                data-context={context}
                aria-pressed={state.context === context}
                onClick={() => setState("context", context)}
              >
                <Cm3Icon name={context === "browser" ? "browser" : "git-diff"} />
                {language.t(context === "browser" ? "quietCompanion.browser" : "quietCompanion.reviewTab")}
              </button>
            )}
          </For>
        </header>
        <Show
          when={state.context === "browser"}
          fallback={
            <div class="qc-changes">
              <div class="qc-change-summary">
                <strong>{language.t("quietCompanion.sampleChanges")}</strong>
                <span dir="ltr">{language.t("quietCompanion.diffSummary")}</span>
              </div>
              <For each={files}>
                {(file, index) => (
                  <button
                    type="button"
                    class="qc-file"
                    aria-label={file.name}
                    aria-pressed={state.file === index()}
                    onClick={() => setState("file", index())}
                  >
                    <Cm3Icon name="file-code" />
                    <bdi dir="ltr">{file.name}</bdi>
                    <span class="qc-file-stats" dir="ltr" aria-hidden="true">
                      <span class="qc-added">+{file.added}</span>
                      <span class="qc-removed">−{file.removed}</span>
                    </span>
                  </button>
                )}
              </For>
              <h3 class="qc-diff-title">{language.t("quietCompanion.diffTitle", { file: files[state.file].name })}</h3>
              <pre
                class="qc-diff"
                dir="ltr"
                tabIndex={0}
                aria-label={language.t("quietCompanion.diffTitle", { file: files[state.file].name })}
              >
                <code>
                  <For each={files[state.file].rows}>
                    {(line) => (
                      <Dynamic component={line.kind} class="qc-diff-line">
                        <span class="qc-line-number" aria-hidden="true">
                          {line.old}
                        </span>
                        <span class="qc-line-number" aria-hidden="true">
                          {line.next}
                        </span>
                        <span class="qc-line-sign" aria-hidden="true">
                          {line.sign}
                        </span>
                        <span class="qc-line-text">{line.text}</span>
                      </Dynamic>
                    )}
                  </For>
                </code>
              </pre>
            </div>
          }
        >
          <div class="qc-browser">
            <form
              class="qc-address"
              onSubmit={(event) => {
                event.preventDefault()
                navigate(state.address)
              }}
            >
              <label>
                <span>{language.t("quietCompanion.address")}</span>
                <input
                  dir="ltr"
                  value={state.address}
                  aria-invalid={state.invalidAddress}
                  onInput={(event) => setState({ address: event.currentTarget.value, invalidAddress: false })}
                />
              </label>
              <button type="submit">{language.t("quietCompanion.go")}</button>
            </form>
            <div class="qc-browser-tools">
              <button
                type="button"
                aria-label={language.t("quietCompanion.back")}
                title={language.t("quietCompanion.back")}
                disabled={state.index === 0}
                onClick={() => travel(-1)}
              >
                <Cm3Icon name="arrow-left" />
              </button>
              <button
                type="button"
                aria-label={language.t("quietCompanion.forward")}
                title={language.t("quietCompanion.forward")}
                disabled={state.index === state.history.length - 1}
                onClick={() => travel(1)}
              >
                <Cm3Icon name="arrow-right" />
              </button>
              <button
                type="button"
                aria-label={language.t("quietCompanion.reload")}
                title={language.t("quietCompanion.reload")}
                onClick={() =>
                  setState({
                    address: currentUrl(),
                    invalidAddress: false,
                    reloads: state.reloads + 1,
                  })
                }
              >
                <Cm3Icon name="arrow-clockwise" />
              </button>
              <button
                type="button"
                aria-label={language.t("quietCompanion.browserSettings")}
                title={language.t("quietCompanion.browserSettings")}
                aria-expanded={state.browserSettings}
                onClick={() => setState("browserSettings", !state.browserSettings)}
              >
                <Cm3Icon name="sliders" />
              </button>
              <button
                type="button"
                aria-label={language.t("quietCompanion.external")}
                title={language.t("quietCompanion.external")}
                onClick={() => {
                  const url = httpUrl(state.address)
                  if (!url) {
                    setState("invalidAddress", true)
                    return
                  }
                  platform.openExternal(url)
                }}
              >
                <Cm3Icon name="arrow-square-out" />
              </button>
            </div>
            <Show when={state.invalidAddress}>
              <p class="qc-browser-notice" role="alert">
                {language.t("quietCompanion.invalidAddress")}
              </p>
            </Show>
            <Show when={state.browserSettings}>
              <fieldset class="qc-browser-settings">
                <legend>{language.t("quietCompanion.browserSettings")}</legend>
                <label>
                  <input
                    type="checkbox"
                    checked={state.pageDetails}
                    onChange={(event) => setState("pageDetails", event.currentTarget.checked)}
                  />
                  {language.t("quietCompanion.pageDetails")}
                </label>
              </fieldset>
            </Show>
            <nav class="qc-sample-pages" aria-label={language.t("quietCompanion.samplePages")}>
              <For each={pages}>
                {(sample) => (
                  <button type="button" aria-pressed={sample.url === currentUrl()} onClick={() => navigate(sample.url)}>
                    {language.t(sample.label)}
                  </button>
                )}
              </For>
            </nav>
            <div class="qc-browser-canvas">
              <div class="qc-site">
                <Show
                  when={page()}
                  fallback={
                    <p class="qc-unsupported" role="status">
                      {language.t("quietCompanion.unsupportedAddress")}
                    </p>
                  }
                >
                  {(sample) => (
                    <div>
                      <div class="qc-site-nav">
                        <strong>{language.t(sample().label)}</strong>
                        <button type="button" onClick={() => navigate(pages[1].url)}>
                          {language.t("quietCompanion.getStarted")}
                        </button>
                      </div>
                      <div class="qc-site-hero">
                        <h2>{language.t(sample().heading)}</h2>
                        <p>{language.t(sample().description)}</p>
                        <button type="button" onClick={() => navigate(pages[2].url)}>
                          {language.t("quietCompanion.startBuilding")}
                        </button>
                      </div>
                    </div>
                  )}
                </Show>
              </div>
            </div>
            <Show when={state.pageDetails}>
              <footer>
                <code class="qc-page-url" dir="ltr">
                  {currentUrl()}
                </code>
              </footer>
            </Show>
          </div>
        </Show>
      </aside>
    </div>
  )
}

function httpUrl(value: string) {
  const address = value.trim()
  if (address.length > 2048 || !/^https?:\/\//i.test(address) || /[\s\\]/.test(address) || !URL.canParse(address))
    return undefined
  const url = new URL(address)
  if (url.username || url.password) return undefined
  return url.href
}
