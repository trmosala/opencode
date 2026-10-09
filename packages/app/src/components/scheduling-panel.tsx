import {
  createContext,
  createEffect,
  createMemo,
  createResource,
  For,
  on,
  onCleanup,
  Show,
  useContext,
  type ParentProps,
} from "solid-js"
import { createStore } from "solid-js/store"
import { useLocation, useNavigate } from "@solidjs/router"
import { useDialog } from "@opencode-ai/ui/context/dialog"
import { Cm3Icon } from "@/components/cm3-icon"
import { useLanguage } from "@/context/language"
import { usePlatform } from "@/context/platform"
import { ServerConnection, useServer } from "@/context/server"
import { useGlobal } from "@/context/global"
import { useTabs } from "@/context/tabs"
import { useLayout } from "@/context/layout"
import { decode64 } from "@/utils/base64"
import { sessionHref } from "@/utils/session-route"
import {
  createSchedulingClient,
  localDateTime,
  scheduleInstant,
  SchedulingError,
  weekdays,
  type ScheduleDefinition,
  type ScheduledTask,
  type ScheduledRun,
} from "@/utils/scheduling"
import "./scheduling-panel.css"

function draft(task?: ScheduledTask, directory = "") {
  const original = task?.definition
  const target = original?.target
  const schedule = original?.schedule
  return {
    name: original?.name ?? "",
    prompt: original?.prompt ?? "",
    directory: target?.type === "new_session" ? target.directory : (task?.directory ?? directory),
    workspace: target?.type === "new_session" ? target.workspace.type : "local",
    baseRef: target?.type === "new_session" && target.workspace.type === "worktree" ? target.workspace.baseRef : "HEAD",
    model: target?.type === "new_session" && target.model ? `${target.model.providerID}/${target.model.id}` : "",
    recurrence: schedule?.type ?? "calendar",
    date: localDateTime(
      schedule?.type === "once"
        ? Date.parse(schedule.at)
        : schedule?.type === "interval"
          ? Date.parse(schedule.startsAt)
          : Date.now() + 3600000,
    ),
    minutes: schedule?.type === "interval" ? schedule.everyMinutes : 60,
    time: schedule?.type === "calendar" ? schedule.time : "09:00",
    timezone: schedule?.type === "calendar" ? schedule.timezone : Intl.DateTimeFormat().resolvedOptions().timeZone,
    days: schedule?.type === "calendar" ? [...schedule.weekdays] : weekdays.slice(0, 5),
    notification: original?.notification ?? "all_runs",
  }
}

type Scope = {
  data?: Awaited<ReturnType<ReturnType<typeof createSchedulingClient>["list"]>>
  loading: boolean
  busy: boolean
  error: string
  view: "tasks" | "runs"
  selected: string
  editor?: { task?: ScheduledTask; form: ReturnType<typeof draft>; baseline: string }
}

function createScheduling() {
  const server = useServer()
  const global = useGlobal()
  const tabs = useTabs()
  const location = useLocation()
  const platform = usePlatform()
  const language = useLanguage()
  const dialog = useDialog()
  const [state, setState] = createStore({
    opened: false,
    scopes: {} as Record<string, Scope>,
    confirmation: "",
    homeServer: "",
    homeDirectory: "",
  })
  const refs: { invoker?: HTMLElement; heading?: HTMLElement; confirm?: () => void } = {}
  const requests = new Set<AbortController>()
  const connection = createMemo(() => {
    const route = location.pathname.match(/^\/server\/([^/]+)\/session\//)
    const draftID =
      location.pathname === "/new-session" ? new URLSearchParams(location.search).get("draftId") : undefined
    const selected = draftID ? tabs.store.find((tab) => tab.type === "draft" && tab.draftID === draftID) : undefined
    const routeKey = route
      ? decode64(route[1])
      : (selected?.server ?? (location.pathname === "/" ? state.homeServer : undefined))
    if (routeKey) return global.servers.list().find((item) => ServerConnection.key(item) === routeKey)
    return server.current
  })
  const serverKey = () => {
    const value = connection()
    return value ? ServerConnection.key(value) : server.key
  }
  const projects = () => server.projects.forServer(serverKey())
  const key = () => connection()?.http.url ?? ""
  const scope = () => state.scopes[key()]
  const client = createMemo(() => {
    const value = connection()
    return value && createSchedulingClient(value.http, platform.fetch)
  })
  const error = (value: unknown) =>
    value instanceof SchedulingError && [404, 503].includes(value.status)
      ? language.t("schedules.unavailable")
      : language.t("schedules.requestFailed", { message: value instanceof Error ? value.message : String(value) })
  const cancelRequests = () => {
    requests.forEach((controller) => controller.abort())
    requests.clear()
    Object.keys(state.scopes).forEach((id) => setState("scopes", id, { loading: false, busy: false }))
  }
  const focus = () =>
    queueMicrotask(() => {
      if (dialog.active) return
      const confirmation = refs.heading
        ?.closest("aside")
        ?.querySelector<HTMLButtonElement>('[role="alertdialog"] button')
      ;(confirmation ?? refs.heading)?.focus({ preventScroll: true })
    })
  createEffect(
    on(
      () => !!dialog.active,
      (active) => {
        if (!active && state.opened) focus()
      },
    ),
  )
  const refresh = async () => {
    const current = client()
    const id = key()
    if (!current || !state.opened || document.hidden || scope()?.loading || scope()?.busy) return
    const controller = new AbortController()
    requests.add(controller)
    setState("scopes", id, { loading: true })
    await current
      .list(controller.signal)
      .then((data) => {
        if (controller.signal.aborted || key() !== id) return
        setState("scopes", id, { data, error: "" })
      })
      .catch((value) => {
        if (!controller.signal.aborted && key() === id) setState("scopes", id, "error", error(value))
      })
      .finally(() => {
        if (requests.delete(controller)) setState("scopes", id, "loading", false)
      })
  }
  createEffect(
    on(key, () => {
      const id = key()
      cancelRequests()
      setState("confirmation", "")
      refs.confirm = undefined
      if (!state.scopes[id])
        setState("scopes", id, { loading: false, busy: false, error: "", view: "tasks", selected: "" })
      void refresh()
    }),
  )
  createEffect(
    on(
      () => state.opened,
      () => {
        if (!state.opened) return
        void refresh()
        const timer = setInterval(() => void refresh(), 10000)
        const visible = () => {
          if (!document.hidden) void refresh()
        }
        window.addEventListener("focus", visible)
        document.addEventListener("visibilitychange", visible)
        onCleanup(() => {
          clearInterval(timer)
          window.removeEventListener("focus", visible)
          document.removeEventListener("visibilitychange", visible)
        })
      },
    ),
  )
  const manage = async (body: Parameters<ReturnType<typeof createSchedulingClient>["manage"]>[0]) => {
    const current = client()
    const id = key()
    if (!current || scope()?.busy) return false
    cancelRequests()
    const controller = new AbortController()
    requests.add(controller)
    setState("scopes", id, { busy: true, error: "" })
    const success = await current
      .manage(body, controller.signal)
      .then(() => !controller.signal.aborted && key() === id)
      .catch((value) => {
        if (!controller.signal.aborted && key() === id) setState("scopes", id, "error", error(value))
        return false
      })
    if (requests.delete(controller)) setState("scopes", id, "busy", false)
    if (success) await refresh()
    return success
  }
  const dirty = () => !!scope()?.editor && JSON.stringify(scope().editor?.form) !== scope().editor?.baseline
  const leave = (next: () => void) => {
    if (scope()?.busy) return
    if (!dirty()) {
      next()
      focus()
      return
    }
    refs.confirm = next
    setState("confirmation", "discard")
    focus()
  }
  const close = () => {
    if (scope()?.busy) return
    cancelRequests()
    setState({ opened: false, confirmation: "" })
    if (refs.invoker?.isConnected) refs.invoker.focus({ preventScroll: true })
  }
  const open = () => {
    if (!state.opened && document.activeElement instanceof HTMLElement) {
      refs.invoker = document.activeElement.closest('[role="dialog"]')
        ? (document.querySelector<HTMLElement>('[data-component="prompt-input"][contenteditable="true"]') ??
          document.querySelector<HTMLElement>('[data-action="scheduling"]') ??
          undefined)
        : document.activeElement
    }
    setState("opened", true)
    void refresh()
    focus()
  }
  const escape = (event: KeyboardEvent) => {
    if (event.key !== "Escape" || event.defaultPrevented || !state.opened || dialog.active) return
    if (document.querySelector<HTMLElement>('[role="menu"], [role="listbox"]')?.checkVisibility()) return
    event.preventDefault()
    event.stopPropagation()
    if (state.confirmation) {
      setState("confirmation", "")
      focus()
      return
    }
    close()
  }
  window.addEventListener("keydown", escape, { capture: true })
  onCleanup(() => window.removeEventListener("keydown", escape, { capture: true }))
  const edit = (task?: ScheduledTask) =>
    leave(() => {
      const form = draft(
        task,
        (location.pathname === "/" ? state.homeDirectory : undefined) ||
          projects().last() ||
          projects().list()[0]?.worktree ||
          "",
      )
      setState("scopes", key(), "editor", { task, form, baseline: JSON.stringify(form) })
    })
  onCleanup(cancelRequests)
  return {
    state,
    refs,
    key,
    connection,
    serverKey,
    projects,
    scope,
    setState,
    open,
    close,
    isOpen: () => state.opened,
    refresh,
    manage,
    dirty,
    leave,
    edit,
    focus,
  }
}

const SchedulingContext = createContext<ReturnType<typeof createScheduling>>()
export const useOptionalScheduling = () => useContext(SchedulingContext)
export function useScheduling() {
  const value = useOptionalScheduling()
  if (!value) throw new Error("SchedulingProvider is missing")
  return value
}
export function SchedulingProvider(props: ParentProps) {
  return <SchedulingContext.Provider value={createScheduling()}>{props.children}</SchedulingContext.Provider>
}

export function SchedulingPanel() {
  const scheduling = useScheduling()
  const language = useLanguage()
  const navigate = useNavigate()
  const layout = useLayout()
  createEffect(() => {
    const selection = layout.home.selection()
    scheduling.setState({ homeServer: selection.server ?? "", homeDirectory: selection.directory ?? "" })
  })
  createEffect(
    on(
      () => scheduling.scope()?.error,
      (error) => {
        if (error && scheduling.isOpen())
          queueMicrotask(() =>
            scheduling.refs.heading
              ?.closest("aside")
              ?.querySelector<HTMLElement>('[role="alert"]')
              ?.focus({ preventScroll: true }),
          )
      },
    ),
  )
  const tasks = createMemo(() => scheduling.scope()?.data?.schedules.filter((task) => !task.deleted) ?? [])
  const runs = createMemo(() => [...(scheduling.scope()?.data?.occurrences ?? [])].reverse())
  const selected = () => tasks().find((task) => task.id === scheduling.scope()?.selected)
  const frequency = (definition: ScheduleDefinition) => {
    const schedule = definition.schedule
    if (schedule.type === "once")
      return language.t("schedules.onceAt", { date: language.formatDate(Date.parse(schedule.at)) })
    if (schedule.type === "interval") return language.t("schedules.intervalSummary", { minutes: schedule.everyMinutes })
    return language.t("schedules.calendarSummary", {
      days: schedule.weekdays.map((day) => language.t(`schedules.day.${day}`)).join(", "),
      time: schedule.time,
      timezone: schedule.timezone,
    })
  }
  const status = (task: ScheduledTask) => {
    if (!task.definition.enabled) return language.t("schedules.paused")
    const run = runs().find((item) => item.scheduleID === task.id)
    if (run && !["completed", "skipped"].includes(run.state)) return language.t(`schedules.state.${run.state}`)
    return language.t(task.next === undefined ? "schedules.finished" : "schedules.active")
  }
  const back = () =>
    scheduling.leave(() => scheduling.setState("scopes", scheduling.key(), { selected: "", editor: undefined }))
  const runRow = (run: ScheduledRun) => (
    <article class="scheduling-run">
      <strong>{run.definition.name}</strong>
      <p>{language.formatDate(run.at)}</p>
      <p>{language.t(`schedules.state.${run.state}`)}</p>
      <Show when={run.detail}>
        <p>{run.detail}</p>
      </Show>
      <div class="scheduling-actions">
        <Show when={run.admitted && run.directory}>
          <button type="button" onClick={() => navigate(sessionHref(scheduling.serverKey(), run.sessionID))}>
            {language.t("schedules.openRun")}
          </button>
        </Show>
        <Show when={run.state === "attention"}>
          <button
            type="button"
            disabled={scheduling.scope()?.busy}
            onClick={() => void scheduling.manage({ action: "acknowledge", id: run.id })}
          >
            {language.t("schedules.acknowledge")}
          </button>
        </Show>
      </div>
    </article>
  )
  return (
    <aside
      data-component="scheduling-panel"
      aria-labelledby="scheduling-heading"
      hidden={!scheduling.isOpen()}
      inert={!scheduling.isOpen()}
      class="scheduling-panel"
      onKeyDown={(event) => {
        if (event.key !== "Escape" || event.defaultPrevented) return
        event.preventDefault()
        if (scheduling.state.confirmation) {
          scheduling.setState("confirmation", "")
          return
        }
        scheduling.close()
      }}
    >
      <header class="scheduling-header">
        <h2 id="scheduling-heading" tabindex={-1} ref={(element) => (scheduling.refs.heading = element)}>
          {language.t("schedules.panelTitle")}
        </h2>
        <button
          type="button"
          disabled={scheduling.scope()?.busy || !scheduling.connection() || !!scheduling.state.confirmation}
          onClick={() => scheduling.edit()}
        >
          {language.t("schedules.new")}
        </button>
        <button
          type="button"
          aria-label={language.t("schedules.closePanel")}
          disabled={scheduling.scope()?.busy}
          onClick={scheduling.close}
        >
          <Cm3Icon name="x" />
        </button>
      </header>
      <Show when={scheduling.state.confirmation}>
        <div
          class="scheduling-confirm"
          role="alertdialog"
          aria-label={language.t(
            scheduling.state.confirmation === "discard" ? "schedules.discardTitle" : "schedules.deleteTitle",
          )}
        >
          <p>
            {scheduling.state.confirmation === "discard"
              ? language.t("schedules.discardConfirm")
              : language.t("schedules.deleteConfirm", { name: selected()?.definition.name ?? "" })}
          </p>
          <button type="button" onClick={() => scheduling.setState("confirmation", "")}>
            {language.t("schedules.cancel")}
          </button>
          <button
            type="button"
            onClick={() => {
              scheduling.setState("confirmation", "")
              scheduling.refs.confirm?.()
              scheduling.focus()
            }}
          >
            {language.t(scheduling.state.confirmation === "delete" ? "schedules.delete" : "schedules.discard")}
          </button>
        </div>
      </Show>
      <div class="scheduling-body" inert={!!scheduling.state.confirmation}>
        <Show when={scheduling.scope()?.error}>
          <div role="alert" tabindex={-1} class="scheduling-error">
            <p>{scheduling.scope()?.error}</p>
            <button type="button" onClick={() => void scheduling.refresh()}>
              {language.t("schedules.retry")}
            </button>
          </div>
        </Show>
        <Show when={scheduling.scope()?.loading && !scheduling.scope()?.data}>
          <p role="status">{language.t("schedules.loading")}</p>
        </Show>
        <Show
          when={scheduling.scope()?.editor}
          fallback={
            <>
              <Show
                when={selected()}
                fallback={
                  <>
                    <nav class="scheduling-tabs" aria-label={language.t("schedules.views")}>
                      <button
                        type="button"
                        aria-pressed={scheduling.scope()?.view === "tasks"}
                        onClick={() => scheduling.setState("scopes", scheduling.key(), "view", "tasks")}
                      >
                        {language.t("schedules.tasks")}
                      </button>
                      <button
                        type="button"
                        aria-pressed={scheduling.scope()?.view === "runs"}
                        onClick={() => scheduling.setState("scopes", scheduling.key(), "view", "runs")}
                      >
                        {language.t("schedules.runs")}
                      </button>
                      <button
                        type="button"
                        aria-label={language.t("schedules.refresh")}
                        disabled={scheduling.scope()?.loading || scheduling.scope()?.busy}
                        onClick={() => void scheduling.refresh()}
                      >
                        <Cm3Icon name="arrow-clockwise" />
                      </button>
                    </nav>
                    <Show when={scheduling.scope()?.data}>
                      <Show
                        when={scheduling.scope()?.view === "tasks"}
                        fallback={
                          <Show when={runs().length} fallback={<p>{language.t("schedules.noRunsDescription")}</p>}>
                            <For each={runs()}>{runRow}</For>
                          </Show>
                        }
                      >
                        <Show
                          when={tasks().length}
                          fallback={
                            <div class="scheduling-empty">
                              <h3>{language.t("schedules.emptyTitle")}</h3>
                              <p>{language.t("schedules.emptyDescription")}</p>
                            </div>
                          }
                        >
                          <For each={tasks()}>
                            {(task) => (
                              <button
                                type="button"
                                class="scheduling-task"
                                onClick={() => {
                                  scheduling.setState("scopes", scheduling.key(), "selected", task.id)
                                  scheduling.focus()
                                }}
                              >
                                <strong>{task.definition.name}</strong>
                                <span>{frequency(task.definition)}</span>
                                <span>{status(task)}</span>
                                <Show when={task.next !== undefined}>
                                  <span>
                                    {language.t("schedules.nextRun", { date: language.formatDate(task.next!) })}
                                  </span>
                                </Show>
                              </button>
                            )}
                          </For>
                        </Show>
                      </Show>
                      <Show
                        when={
                          scheduling.scope()?.view === "runs" &&
                          (scheduling.scope()?.data?.totalOccurrences ?? 0) > runs().length
                        }
                      >
                        <p>{language.t("schedules.recentRuns", { count: runs().length })}</p>
                      </Show>
                    </Show>
                  </>
                }
              >
                {(task) => (
                  <>
                    <button type="button" onClick={back}>
                      {language.t("quietCompanion.back")}
                    </button>
                    <h3>{task().definition.name}</h3>
                    <p>{status(task())}</p>
                    <p>{frequency(task().definition)}</p>
                    <p class="scheduling-instructions">{task().definition.prompt}</p>
                    <p>{task().directory}</p>
                    <div class="scheduling-actions">
                      <button type="button" disabled={scheduling.scope()?.busy} onClick={() => scheduling.edit(task())}>
                        {language.t("schedules.edit")}
                      </button>
                      <button
                        type="button"
                        disabled={scheduling.scope()?.busy}
                        onClick={() =>
                          void scheduling.manage({
                            action: task().definition.enabled ? "pause" : "resume",
                            id: task().id,
                          })
                        }
                      >
                        {language.t(task().definition.enabled ? "schedules.pause" : "schedules.resume")}
                      </button>
                      <button
                        type="button"
                        disabled={scheduling.scope()?.busy}
                        onClick={() => {
                          const id = task().id
                          scheduling.refs.confirm = () =>
                            void scheduling.manage({ action: "delete", id }).then((saved) => {
                              if (saved) back()
                            })
                          scheduling.setState("confirmation", "delete")
                        }}
                      >
                        {language.t("schedules.delete")}
                      </button>
                    </div>
                    <h3>{language.t("schedules.runs")}</h3>
                    <For each={runs().filter((run) => run.scheduleID === task().id)}>{runRow}</For>
                  </>
                )}
              </Show>
            </>
          }
        >
          <Show when={scheduling.key()} keyed>
            {(_) => <ScheduleEditor />}
          </Show>
        </Show>
      </div>
      <footer>{language.t("schedules.runtimeNote")}</footer>
    </aside>
  )
}

function ScheduleEditor() {
  const scheduling = useScheduling()
  const language = useLanguage()
  const global = useGlobal()
  const editor = () => scheduling.scope().editor!
  const form = () => editor().form
  const original = () => editor().task?.definition
  const target = () => original()?.target
  const schedule = () => original()?.schedule
  const existingSessionID = () => {
    const value = target()
    return value?.type === "existing_session" ? value.sessionID : ""
  }
  const setForm = <K extends keyof ReturnType<typeof draft>>(key: K, value: ReturnType<typeof draft>[K]) =>
    scheduling.setState("scopes", scheduling.key(), "editor", "form", key, value)
  const [providers] = createResource(
    () => scheduling.isOpen() && !document.hidden && form().directory.trim(),
    async (directory) => {
      const connection = scheduling.connection()
      if (!connection) return undefined
      const result = await global.ensureServerCtx(connection).sdk.client.provider.list({ directory })
      return result.data
    },
  )
  const models = createMemo(() => {
    const catalog = providers.error ? undefined : providers()
    return (
      catalog?.all
        .filter((provider) => catalog.connected.includes(provider.id))
        .flatMap((provider) => Object.values(provider.models).map((model) => ({ ...model, provider }))) ?? []
    )
  })
  const cancel = () => scheduling.leave(() => scheduling.setState("scopes", scheduling.key(), "editor", undefined))
  const save = async (event: SubmitEvent) => {
    event.preventDefault()
    if (scheduling.scope().busy) return
    const savingScope = scheduling.key()
    const savingEditor = editor()
    const fail = (key: "schedules.chooseDay" | "schedules.invalidDate" | "schedules.invalidTimezone") =>
      scheduling.setState("scopes", scheduling.key(), "error", language.t(key))
    if (form().recurrence === "calendar" && !form().days.length) {
      fail("schedules.chooseDay")
      return
    }
    if (form().recurrence !== "calendar" && !Number.isFinite(Date.parse(form().date))) {
      fail("schedules.invalidDate")
      return
    }
    if (form().recurrence === "calendar") {
      const valid = Promise.resolve()
        .then(() => new Intl.DateTimeFormat("en", { timeZone: form().timezone.trim() }))
        .then(
          () => true,
          () => false,
        )
      if (!(await valid)) {
        fail("schedules.invalidTimezone")
        return
      }
    }
    if (scheduling.key() !== savingScope || editor() !== savingEditor) return
    const model = models().find((item) => `${item.provider.id}/${item.id}` === form().model)
    const previous = target()
    const timing = schedule()
    const definition: ScheduleDefinition = {
      ...original(),
      schemaVersion: 1,
      name: form().name.trim(),
      prompt: form().prompt.trim(),
      execution: "while_app_running",
      enabled: original()?.enabled ?? true,
      target:
        previous?.type === "existing_session"
          ? previous
          : {
              ...previous,
              type: "new_session",
              directory: form().directory.trim(),
              workspace:
                form().workspace === "worktree"
                  ? { type: "worktree", baseRef: form().baseRef.trim() }
                  : { type: "local" },
              model: model
                ? {
                    providerID: model.provider.id,
                    id: model.id,
                    ...(previous?.type === "new_session" &&
                    previous.model?.id === model.id &&
                    previous.model.providerID === model.provider.id
                      ? { variant: previous.model.variant }
                      : {}),
                  }
                : previous?.type === "new_session" && form().model
                  ? previous.model
                  : undefined,
            },
      schedule:
        form().recurrence === "calendar"
          ? { type: "calendar", timezone: form().timezone.trim(), time: form().time, weekdays: form().days }
          : form().recurrence === "once"
            ? { type: "once", at: scheduleInstant(form().date, timing?.type === "once" ? timing.at : undefined) }
            : {
                type: "interval",
                everyMinutes: form().minutes,
                startsAt: scheduleInstant(form().date, timing?.type === "interval" ? timing.startsAt : undefined),
              },
      misfire: original()?.misfire ?? { type: "catch_up_once", withinMinutes: 60 },
      notification: form().notification,
    }
    const id = scheduling.key()
    const saved = await scheduling.manage({
      action: editor().task ? "update" : "create",
      id: editor().task?.id,
      definition,
    })
    if (!saved || scheduling.key() !== id) return
    scheduling.setState("scopes", id, "editor", undefined)
    scheduling.focus()
  }
  return (
    <form class="scheduling-form" onSubmit={save}>
      <button type="button" disabled={scheduling.scope().busy} onClick={cancel}>
        {language.t("quietCompanion.back")}
      </button>
      <h3>{language.t(editor().task ? "schedules.editTitle" : "schedules.new")}</h3>
      <fieldset disabled={scheduling.scope().busy}>
        <label>
          {language.t("schedules.name")}
          <input
            autofocus
            required
            maxlength={120}
            value={form().name}
            onInput={(event) => setForm("name", event.currentTarget.value)}
            placeholder={language.t("schedules.namePlaceholder")}
          />
        </label>
        <label>
          {language.t("schedules.prompt")}
          <textarea
            required
            maxlength={32768}
            rows={4}
            value={form().prompt}
            onInput={(event) => setForm("prompt", event.currentTarget.value)}
            placeholder={language.t("schedules.promptPlaceholder")}
          />
        </label>
        <Show
          when={target()?.type !== "existing_session"}
          fallback={
            <p>
              {language.t("schedules.existingSession", {
                id: existingSessionID(),
              })}
            </p>
          }
        >
          <label>
            {language.t("schedules.project")}
            <input
              required
              value={form().directory}
              onInput={(event) => setForm("directory", event.currentTarget.value)}
              list="scheduling-panel-projects"
              placeholder={language.t("schedules.projectPlaceholder")}
            />
          </label>
          <datalist id="scheduling-panel-projects">
            <For each={scheduling.projects().list()}>{(project) => <option value={project.worktree} />}</For>
          </datalist>
        </Show>
        <label>
          {language.t("schedules.repeat")}
          <select
            value={form().recurrence}
            onChange={(event) => {
              const value = event.currentTarget.value
              if (value === "once" || value === "interval" || value === "calendar") setForm("recurrence", value)
            }}
          >
            <option value="calendar">{language.t("schedules.weekly")}</option>
            <option value="interval">{language.t("schedules.interval")}</option>
            <option value="once">{language.t("schedules.once")}</option>
          </select>
        </label>
        <Show
          when={form().recurrence === "calendar"}
          fallback={
            <>
              <label>
                {language.t("schedules.startsAt")}
                <input
                  required
                  type="datetime-local"
                  value={form().date}
                  onInput={(event) => setForm("date", event.currentTarget.value)}
                />
              </label>
              <Show when={form().recurrence === "interval"}>
                <label>
                  {language.t("schedules.everyMinutes")}
                  <input
                    required
                    type="number"
                    min={1}
                    max={525600}
                    step={1}
                    value={form().minutes}
                    onInput={(event) => setForm("minutes", event.currentTarget.valueAsNumber)}
                  />
                </label>
              </Show>
            </>
          }
        >
          <div class="scheduling-days" role="group" aria-label={language.t("schedules.days")}>
            <For each={weekdays}>
              {(day) => (
                <button
                  type="button"
                  aria-pressed={form().days.includes(day)}
                  onClick={() =>
                    setForm(
                      "days",
                      form().days.includes(day)
                        ? form().days.filter((value) => value !== day)
                        : weekdays.filter((value) => value === day || form().days.includes(value)),
                    )
                  }
                >
                  {language.t(`schedules.day.${day}`)}
                </button>
              )}
            </For>
          </div>
          <label>
            {language.t("schedules.time")}
            <input
              required
              type="time"
              value={form().time}
              onInput={(event) => setForm("time", event.currentTarget.value)}
            />
          </label>
          <label>
            {language.t("schedules.timezone")}
            <input
              required
              value={form().timezone}
              onInput={(event) => setForm("timezone", event.currentTarget.value)}
            />
          </label>
        </Show>
        <label>
          {language.t("schedules.notifications")}
          <select
            value={form().notification}
            onChange={(event) =>
              setForm("notification", event.currentTarget.value === "failures_only" ? "failures_only" : "all_runs")
            }
          >
            <option value="all_runs">{language.t("schedules.allRuns")}</option>
            <option value="failures_only">{language.t("schedules.failuresOnly")}</option>
          </select>
        </label>
        <Show when={target()?.type !== "existing_session"}>
          <details>
            <summary>{language.t("schedules.advanced")}</summary>
            <label>
              {language.t("schedules.workspace")}
              <select
                value={form().workspace}
                onChange={(event) =>
                  setForm("workspace", event.currentTarget.value === "worktree" ? "worktree" : "local")
                }
              >
                <option value="local">{language.t("schedules.local")}</option>
                <option value="worktree">{language.t("schedules.worktree")}</option>
              </select>
            </label>
            <Show when={form().workspace === "worktree"}>
              <label>
                {language.t("schedules.baseRef")}
                <input
                  required
                  value={form().baseRef}
                  onInput={(event) => setForm("baseRef", event.currentTarget.value)}
                />
              </label>
            </Show>
            <label>
              {language.t("schedules.model")}
              <select value={form().model} onChange={(event) => setForm("model", event.currentTarget.value)}>
                <option value="">{language.t("schedules.defaultModel")}</option>
                <Show
                  when={form().model && !models().some((model) => `${model.provider.id}/${model.id}` === form().model)}
                >
                  <option value={form().model}>{form().model}</option>
                </Show>
                <For each={models()}>
                  {(model) => <option value={`${model.provider.id}/${model.id}`}>{model.name}</option>}
                </For>
              </select>
            </label>
          </details>
        </Show>
      </fieldset>
      <div class="scheduling-actions">
        <button type="button" disabled={scheduling.scope().busy} onClick={cancel}>
          {language.t("schedules.cancel")}
        </button>
        <button class="scheduling-primary" type="submit" disabled={scheduling.scope().busy}>
          {language.t(scheduling.scope().busy ? "schedules.saving" : "schedules.save")}
        </button>
      </div>
    </form>
  )
}
