import { createMemo, createResource, For, onCleanup, Show } from "solid-js"
import { createStore } from "solid-js/store"
import { useNavigate } from "@solidjs/router"
import { Dialog } from "@opencode-ai/ui/dialog"
import { useDialog } from "@opencode-ai/ui/context/dialog"
import { Cm3Icon } from "@/components/cm3-icon"
import { useLanguage } from "@/context/language"
import { useServerSDK } from "@/context/server-sdk"
import { usePlatform } from "@/context/platform"
import { useServer } from "@/context/server"
import { useSettings } from "@/context/settings"
import { legacySessionHref, sessionHref } from "@/utils/session-route"
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
import "./scheduled.css"

export default function Scheduled() {
  const language = useLanguage()
  const server = useServer()
  const platform = usePlatform()
  const settings = useSettings()
  const navigate = useNavigate()
  const dialog = useDialog()
  const client = createMemo(() => server.current && createSchedulingClient(server.current.http, platform.fetch))
  const [data, actions] = createResource(client, (value) => value.list())
  const [state, setState] = createStore({ view: "tasks", busy: "", error: "" })
  const snapshot = () => (data.error ? undefined : data())
  const tasks = createMemo(() => snapshot()?.schedules.filter((item) => !item.deleted) ?? [])
  const runs = createMemo(() => [...(snapshot()?.occurrences ?? [])].reverse())
  const review = createMemo(() => runs().filter((run) => run.state === "attention").length)
  const refresh = () => {
    if (!data.loading && !state.busy) void actions.refetch()
  }
  const timer = setInterval(() => {
    if (!document.hidden) refresh()
  }, 10000)
  window.addEventListener("focus", refresh)
  onCleanup(() => {
    clearInterval(timer)
    window.removeEventListener("focus", refresh)
  })
  const error = (value: unknown) =>
    value instanceof SchedulingError && [404, 503].includes(value.status)
      ? language.t("schedules.unavailable")
      : language.t("schedules.requestFailed", { message: value instanceof Error ? value.message : String(value) })
  const manage = async (action: "pause" | "resume" | "delete" | "acknowledge", id: string) => {
    const current = client()
    if (!current || state.busy) return
    setState({ busy: id, error: "" })
    await current
      .manage({ action, id })
      .then(() => actions.refetch())
      .catch((value) => setState("error", error(value)))
    setState("busy", "")
  }
  const edit = (task?: ScheduledTask) => {
    const current = client()
    if (!current) return
    void dialog.show(() => (
      <ScheduleEditor
        task={task}
        client={current}
        onSaved={() => {
          void actions.refetch()
        }}
      />
    ))
  }
  const remove = (task: ScheduledTask) =>
    dialog.show(() => (
      <Dialog title={language.t("schedules.deleteTitle")}>
        <div class="schedule-form">
          <p>{language.t("schedules.deleteConfirm", { name: task.definition.name })}</p>
          <div class="schedule-form-actions">
            <button type="button" onClick={() => dialog.close()}>
              {language.t("schedules.cancel")}
            </button>
            <button
              type="button"
              class="schedule-primary"
              onClick={() => {
                dialog.close()
                void manage("delete", task.id)
              }}
            >
              {language.t("schedules.delete")}
            </button>
          </div>
        </div>
      </Dialog>
    ))
  const openRun = (run: ScheduledRun) => {
    if (!run.directory || !run.admitted) return
    navigate(
      settings.general.newLayoutDesigns()
        ? sessionHref(server.key, run.sessionID)
        : legacySessionHref(run.directory, run.sessionID),
    )
  }
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
    if (!task.definition.enabled) return "schedules.paused" as const
    const run = runs().find((item) => item.scheduleID === task.id)
    if (run && !["completed", "skipped"].includes(run.state)) return `schedules.state.${run.state}` as const
    return task.next === undefined ? "schedules.finished" : "schedules.active"
  }

  return (
    <section class="scheduled-page" aria-labelledby="scheduled-title">
      <header class="scheduled-header">
        <div>
          <h1 id="scheduled-title">{language.t("schedules.title")}</h1>
          <p>{language.t("schedules.subtitle")}</p>
        </div>
        <button
          type="button"
          class="schedule-primary"
          disabled={!!data.error || data.loading || !client()}
          onClick={() => edit()}
        >
          <Cm3Icon name="plus" />
          {language.t("schedules.new")}
        </button>
      </header>
      <nav class="scheduled-tabs" aria-label={language.t("schedules.views")}>
        <button
          type="button"
          data-active={state.view === "tasks"}
          aria-pressed={state.view === "tasks"}
          onClick={() => setState("view", "tasks")}
        >
          {language.t("schedules.tasks")}
          <span>{tasks().length}</span>
        </button>
        <button
          type="button"
          data-active={state.view === "runs"}
          aria-pressed={state.view === "runs"}
          onClick={() => setState("view", "runs")}
        >
          {language.t("schedules.runs")}
          <Show when={review()}>
            <span>{review()}</span>
          </Show>
        </button>
        <button
          type="button"
          class="scheduled-refresh"
          aria-label={language.t("schedules.refresh")}
          disabled={data.loading || !!state.busy}
          onClick={refresh}
        >
          <Cm3Icon name="arrow-clockwise" />
        </button>
      </nav>
      <Show when={data.error || state.error}>
        <div class="scheduled-error" role="alert">
          <p>{state.error || error(data.error)}</p>
          <button
            type="button"
            onClick={() => {
              setState("error", "")
              refresh()
            }}
          >
            {language.t("schedules.retry")}
          </button>
        </div>
      </Show>
      <Show when={data.loading && !snapshot()}>
        <p role="status" class="scheduled-loading">
          {language.t("schedules.loading")}
        </p>
      </Show>
      <Show when={snapshot()}>
        <Show
          when={state.view === "tasks"}
          fallback={
            <div class="scheduled-list">
              <Show
                when={runs().length}
                fallback={
                  <EmptySchedule
                    title={language.t("schedules.noRuns")}
                    description={language.t("schedules.noRunsDescription")}
                  />
                }
              >
                <For each={runs()}>
                  {(run) => (
                    <article class="scheduled-run" data-state={run.state}>
                      <span class="scheduled-dot" />
                      <div class="scheduled-run-copy">
                        <strong>{run.definition.name}</strong>
                        <p>
                          {language.formatDate(run.at)}
                          <span class="scheduled-separator">·</span>
                          {language.t(`schedules.state.${run.state}`)}
                        </p>
                        <Show when={run.detail}>
                          <p class="scheduled-detail">{run.detail}</p>
                        </Show>
                      </div>
                      <div class="scheduled-row-actions">
                        <Show when={run.admitted && run.directory}>
                          <button type="button" onClick={() => openRun(run)}>
                            {language.t("schedules.openRun")}
                            <Cm3Icon name="arrow-square-out" />
                          </button>
                        </Show>
                        <Show when={run.state === "attention"}>
                          <button
                            type="button"
                            disabled={!!state.busy}
                            onClick={() => void manage("acknowledge", run.id)}
                          >
                            {language.t("schedules.acknowledge")}
                          </button>
                        </Show>
                      </div>
                    </article>
                  )}
                </For>
                <Show when={(snapshot()?.totalOccurrences ?? 0) > runs().length}>
                  <p class="scheduled-footnote">{language.t("schedules.recentRuns", { count: runs().length })}</p>
                </Show>
              </Show>
            </div>
          }
        >
          <div class="scheduled-list">
            <Show
              when={tasks().length}
              fallback={
                <EmptySchedule
                  title={language.t("schedules.emptyTitle")}
                  description={language.t("schedules.emptyDescription")}
                >
                  <button type="button" class="schedule-primary" onClick={() => edit()}>
                    <Cm3Icon name="plus" />
                    {language.t("schedules.new")}
                  </button>
                </EmptySchedule>
              }
            >
              <For each={tasks()}>
                {(task) => (
                  <article class="scheduled-task">
                    <div class="scheduled-task-top">
                      <button type="button" class="scheduled-task-name" onClick={() => edit(task)}>
                        {task.definition.name}
                      </button>
                      <span class="scheduled-badge" data-enabled={task.definition.enabled && task.next !== undefined}>
                        {language.t(status(task))}
                      </span>
                    </div>
                    <p class="scheduled-prompt">{task.definition.prompt}</p>
                    <p class="scheduled-frequency">
                      <ScheduleClock />
                      {frequency(task.definition)}
                    </p>
                    <div class="scheduled-task-bottom">
                      <div class="scheduled-task-meta">
                        <span title={task.directory}>
                          {task.directory.split(/[\\/]/).filter(Boolean).at(-1) || task.directory}
                        </span>
                        <span class="scheduled-separator">·</span>
                        <span>
                          {task.definition.enabled && task.next !== undefined
                            ? language.t("schedules.nextRun", { date: language.formatDate(task.next) })
                            : language.t("schedules.runCount", { count: task.runs })}
                        </span>
                      </div>
                      <div class="scheduled-row-actions">
                        <button
                          type="button"
                          disabled={!!state.busy}
                          onClick={() => void manage(task.definition.enabled ? "pause" : "resume", task.id)}
                        >
                          {language.t(task.definition.enabled ? "schedules.pause" : "schedules.resume")}
                        </button>
                        <button type="button" onClick={() => edit(task)}>
                          {language.t("schedules.edit")}
                        </button>
                        <button type="button" disabled={!!state.busy} onClick={() => remove(task)}>
                          {language.t("schedules.delete")}
                        </button>
                      </div>
                    </div>
                  </article>
                )}
              </For>
            </Show>
          </div>
        </Show>
      </Show>
      <p class="scheduled-footnote">{language.t("schedules.runtimeNote")}</p>
    </section>
  )
}

function ScheduleClock() {
  return (
    <svg
      width="18"
      height="18"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      stroke-width="1.5"
      aria-hidden="true"
    >
      <circle cx="12" cy="12" r="8.5" />
      <path d="M12 7v5l3 2" />
    </svg>
  )
}

function EmptySchedule(props: { title: string; description: string; children?: import("solid-js").JSX.Element }) {
  return (
    <div class="scheduled-empty">
      <div class="scheduled-empty-icon">
        <ScheduleClock />
      </div>
      <h2>{props.title}</h2>
      <p>{props.description}</p>
      {props.children}
    </div>
  )
}

function ScheduleEditor(props: {
  task?: ScheduledTask
  client: ReturnType<typeof createSchedulingClient>
  onSaved: () => void
}) {
  const language = useLanguage()
  const server = useServer()
  const sdk = useServerSDK()
  const dialog = useDialog()
  const original = props.task?.definition
  const target = original?.target
  const schedule = original?.schedule
  const [form, setForm] = createStore({
    name: original?.name ?? "",
    prompt: original?.prompt ?? "",
    directory:
      target?.type === "new_session"
        ? target.directory
        : (props.task?.directory ?? server.projects.last() ?? server.projects.list()[0]?.worktree ?? ""),
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
    busy: false,
    error: "",
  })
  const [providers] = createResource(
    () => form.directory.trim(),
    async (directory) => {
      const result = await sdk().client.provider.list({ directory })
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
  const save = async (event: SubmitEvent) => {
    event.preventDefault()
    if (form.busy) return
    if (form.recurrence === "calendar" && !form.days.length) {
      setForm("error", language.t("schedules.chooseDay"))
      return
    }
    if (form.recurrence !== "calendar" && !Number.isFinite(Date.parse(form.date))) {
      setForm("error", language.t("schedules.invalidDate"))
      return
    }
    const model = form.model ? models().find((item) => `${item.provider.id}/${item.id}` === form.model) : undefined
    const definition: ScheduleDefinition = {
      ...original,
      schemaVersion: 1,
      name: form.name.trim(),
      prompt: form.prompt.trim(),
      execution: "while_app_running",
      enabled: original?.enabled ?? true,
      target:
        target?.type === "existing_session"
          ? target
          : {
              ...target,
              type: "new_session",
              directory: form.directory.trim(),
              workspace:
                form.workspace === "worktree" ? { type: "worktree", baseRef: form.baseRef.trim() } : { type: "local" },
              model: model
                ? {
                    providerID: model.provider.id,
                    id: model.id,
                    ...(target?.type === "new_session" &&
                    target.model?.id === model.id &&
                    target.model.providerID === model.provider.id
                      ? { variant: target.model.variant }
                      : {}),
                  }
                : target?.type === "new_session" && form.model
                  ? target.model
                  : undefined,
            },
      schedule:
        form.recurrence === "calendar"
          ? { type: "calendar", timezone: form.timezone.trim(), time: form.time, weekdays: form.days }
          : form.recurrence === "once"
            ? { type: "once", at: scheduleInstant(form.date, schedule?.type === "once" ? schedule.at : undefined) }
            : {
                type: "interval",
                everyMinutes: form.minutes,
                startsAt: scheduleInstant(form.date, schedule?.type === "interval" ? schedule.startsAt : undefined),
              },
      misfire: original?.misfire ?? { type: "catch_up_once", withinMinutes: 60 },
      notification: form.notification,
    }
    setForm({ busy: true, error: "" })
    await props.client
      .manage({ action: props.task ? "update" : "create", id: props.task?.id, definition })
      .then(() => {
        props.onSaved()
        dialog.close()
      })
      .catch((value) => {
        setForm({
          busy: false,
          error: language.t("schedules.requestFailed", {
            message: value instanceof Error ? value.message : String(value),
          }),
        })
      })
  }
  return (
    <Dialog class="schedule-dialog" title={language.t(props.task ? "schedules.editTitle" : "schedules.new")}>
      <form class="schedule-form" onSubmit={save}>
        <fieldset disabled={form.busy}>
          <label>
            {language.t("schedules.name")}
            <input
              autofocus
              required
              maxlength={120}
              value={form.name}
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
              value={form.prompt}
              onInput={(event) => setForm("prompt", event.currentTarget.value)}
              placeholder={language.t("schedules.promptPlaceholder")}
            />
          </label>
          <Show
            when={target?.type !== "existing_session"}
            fallback={
              <p>
                {language.t("schedules.existingSession", {
                  id: target?.type === "existing_session" ? target.sessionID : "",
                })}
              </p>
            }
          >
            <label>
              {language.t("schedules.project")}
              <input
                required
                value={form.directory}
                onInput={(event) => setForm("directory", event.currentTarget.value)}
                list="schedule-projects"
                placeholder={language.t("schedules.projectPlaceholder")}
              />
              <datalist id="schedule-projects">
                <For each={server.projects.list()}>{(project) => <option value={project.worktree} />}</For>
              </datalist>
            </label>
            <div class="schedule-form-grid">
              <label>
                {language.t("schedules.workspace")}
                <select
                  aria-label={language.t("schedules.workspace")}
                  value={form.workspace}
                  onChange={(event) =>
                    setForm("workspace", event.currentTarget.value === "worktree" ? "worktree" : "local")
                  }
                >
                  <option value="local">{language.t("schedules.local")}</option>
                  <option value="worktree">{language.t("schedules.worktree")}</option>
                </select>
              </label>
              <Show when={form.workspace === "worktree"}>
                <label>
                  {language.t("schedules.baseRef")}
                  <input
                    required
                    value={form.baseRef}
                    onInput={(event) => setForm("baseRef", event.currentTarget.value)}
                  />
                </label>
              </Show>
            </div>
            <label>
              {language.t("schedules.model")}
              <select
                aria-label={language.t("schedules.model")}
                value={form.model}
                onChange={(event) => setForm("model", event.currentTarget.value)}
              >
                <option value="" selected={!form.model}>
                  {language.t("schedules.defaultModel")}
                </option>
                <Show when={form.model && !models().some((item) => `${item.provider.id}/${item.id}` === form.model)}>
                  <option value={form.model} selected>
                    {form.model}
                  </option>
                </Show>
                <For each={models()}>
                  {(model) => (
                    <option
                      value={`${model.provider.id}/${model.id}`}
                      selected={form.model === `${model.provider.id}/${model.id}`}
                    >
                      {model.name}
                    </option>
                  )}
                </For>
              </select>
            </label>
          </Show>
          <label>
            {language.t("schedules.repeat")}
            <select
              aria-label={language.t("schedules.repeat")}
              value={form.recurrence}
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
            when={form.recurrence === "calendar"}
            fallback={
              <div class="schedule-form-grid">
                <label>
                  {language.t("schedules.startsAt")}
                  <input
                    required
                    type="datetime-local"
                    value={form.date}
                    onInput={(event) => setForm("date", event.currentTarget.value)}
                  />
                </label>
                <Show when={form.recurrence === "interval"}>
                  <label>
                    {language.t("schedules.everyMinutes")}
                    <input
                      required
                      type="number"
                      min={1}
                      max={525600}
                      step={1}
                      value={form.minutes}
                      onInput={(event) => setForm("minutes", event.currentTarget.valueAsNumber)}
                    />
                  </label>
                </Show>
              </div>
            }
          >
            <div class="schedule-days" role="group" aria-label={language.t("schedules.days")}>
              <For each={weekdays}>
                {(day) => (
                  <button
                    type="button"
                    aria-pressed={form.days.includes(day)}
                    onClick={() =>
                      setForm(
                        "days",
                        form.days.includes(day)
                          ? form.days.filter((value) => value !== day)
                          : weekdays.filter((value) => value === day || form.days.includes(value)),
                      )
                    }
                  >
                    {language.t(`schedules.day.${day}`)}
                  </button>
                )}
              </For>
            </div>
            <div class="schedule-form-grid">
              <label>
                {language.t("schedules.time")}
                <input
                  required
                  type="time"
                  value={form.time}
                  onInput={(event) => setForm("time", event.currentTarget.value)}
                />
              </label>
              <label>
                {language.t("schedules.timezone")}
                <input
                  required
                  value={form.timezone}
                  onInput={(event) => setForm("timezone", event.currentTarget.value)}
                />
              </label>
            </div>
          </Show>
          <label>
            {language.t("schedules.notifications")}
            <select
              aria-label={language.t("schedules.notifications")}
              value={form.notification}
              onChange={(event) =>
                setForm("notification", event.currentTarget.value === "failures_only" ? "failures_only" : "all_runs")
              }
            >
              <option value="all_runs">{language.t("schedules.allRuns")}</option>
              <option value="failures_only">{language.t("schedules.failuresOnly")}</option>
            </select>
          </label>
        </fieldset>
        <p class="scheduled-footnote">{language.t("schedules.runtimeNote")}</p>
        <Show when={form.error}>
          <p class="scheduled-error" role="alert">
            {form.error}
          </p>
        </Show>
        <div class="schedule-form-actions">
          <button type="button" disabled={form.busy} onClick={() => dialog.close()}>
            {language.t("schedules.cancel")}
          </button>
          <button type="submit" class="schedule-primary" disabled={form.busy}>
            {language.t(form.busy ? "schedules.saving" : "schedules.save")}
          </button>
        </div>
      </form>
    </Dialog>
  )
}
