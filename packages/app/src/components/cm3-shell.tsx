import { useChatSplit } from "@/context/chat-split"
import { sessionHref } from "@/utils/session-route"
import { createStore, reconcile } from "solid-js/store"
import { ResizeHandle } from "@opencode-ai/ui/resize-handle"
import { createEffect, createMemo, For, on, onCleanup, Show, type Accessor } from "solid-js"
import { useLocation, useNavigate } from "@solidjs/router"
import { useLanguage } from "@/context/language"
import { useSettings } from "@/context/settings"
import { ServerConnection, useServer } from "@/context/server"
import { base64Encode } from "@opencode-ai/core/util/encode"
import { decode64 } from "@/utils/base64"
import { pathKey } from "@/utils/path-key"
import { tabKey, useTabs, type DraftTab } from "@/context/tabs"
import { createDraftPromptSession } from "@/context/prompt-state"
import type { LocalProject } from "@/context/layout"
import { displayName } from "@/pages/layout/helpers"
import { legacySessionHref } from "@/utils/session-route"
import { Persist, persisted } from "@/utils/persist"
import { createHomeController } from "@/pages/home/home-controller"
import { createHomeSessionsController, type HomeSessionRecord } from "@/pages/home/home-sessions-controller"
import { createHomeProjectsController } from "@/pages/home/home-projects-controller"
import { HomeProjects } from "@/pages/home/home-projects"
import { shouldOpenSessionInBackground } from "@/pages/home-session-open"
import { SessionTabAvatarView } from "@/pages/layout/session-tab-avatar"
import { useSessionTabAvatarState } from "@/pages/layout/project-avatar-state"
import { useDirectoryPicker } from "./directory-picker"
import { useSettingsDialog } from "./settings-dialog"
import { Cm3Icon } from "./cm3-icon"
import { WppAuthControl } from "./wpp-auth-control"
import { Icon } from "@opencode-ai/ui/v2/icon"
import { MenuV2 } from "@opencode-ai/ui/v2/menu-v2"
import { useTheme } from "@opencode-ai/ui/theme"
import cookieMonsterBannerLight from "@/assets/cookie-monster-banner-light.svg"
import cookieMonsterBannerDark from "@/assets/cookie-monster-banner-dark.svg"
import { useScheduling } from "./scheduling-panel"

const PROJECT_SESSIONS_PAGE = 5
type ProjectChat = { key: string; title: string; updated: number } & (
  | { type: "session"; record: HomeSessionRecord }
  | { type: "draft"; tab: DraftTab; project: LocalProject }
)

export function Cm3Shell() {
  const split = useChatSplit()
  const scheduling = useScheduling()
  const home = createHomeController()
  const sessions = createHomeSessionsController(home, { registerPalette: false, allProjects: true })
  const language = useLanguage()
  const theme = useTheme()
  const settings = useSettings()
  const server = useServer()
  const location = useLocation()
  const tabs = useTabs()
  const navigate = useNavigate()
  const pickDirectory = useDirectoryPicker()
  const openSettings = useSettingsDialog()
  const projects = createHomeProjectsController(home, { openSettings })
  const [state, setState] = createStore({
    search: "",
    navigation: false,
  })
  const [sessionLimits, setSessionLimits] = createStore<Record<string, number>>({})
  createEffect(
    on(
      () => state.search,
      () => setSessionLimits(reconcile({})),
      { defer: true },
    ),
  )
  const [sidebar, setSidebar] = persisted(
    Persist.global("cm3.sidebar"),
    createStore({ collapsed: false, width: 260, expanded: {} as Record<string, boolean> }),
  )
  const refs: { toggle?: HTMLButtonElement; nav?: HTMLElement; search?: HTMLInputElement } = {}
  createEffect(() => {
    refs.nav?.parentElement?.style.setProperty("--cm3-sidebar-width", `${sidebar.collapsed ? 48 : sidebar.width}px`)
  })
  onCleanup(() => {
    refs.nav?.parentElement?.style.removeProperty("--cm3-sidebar-width")
  })
  const closeNavigation = () => {
    setState("navigation", false)
    refs.toggle?.focus({ preventScroll: true })
  }
  createEffect(on(() => `${location.pathname}${location.search}`, closeNavigation, { defer: true }))
  const activePath = () =>
    split.state.active === "secondary" && split.store.href ? split.path() : `${location.pathname}${location.search}`
  const routeProject = createMemo(
    () => {
      const path = activePath()
      const target = path.split("?")[0].match(/^\/server\/([^/]+)\/session\/([^/]+)$/)
      if (target) {
        const key = decode64(target[1])
        const conn = home.server.list().find((item) => ServerConnection.key(item) === key)
        if (!conn) return undefined
        const tab = tabs.store.find(
          (item) => item.type === "session" && item.server === key && item.sessionId === target[2],
        )
        const directory = tab ? tabs.info[tabKey(tab)]?.directory : undefined
        if (!directory) return undefined
        return { path, server: ServerConnection.key(conn), directory }
      }
      const legacy = path.split("?")[0].match(/^\/([^/]+)\/session(?:\/[^/]+)?$/)
      if (legacy) {
        const directory = decode64(legacy[1])
        if (directory) return { path, server: server.key, directory }
        return undefined
      }
      if (path.split("?")[0] !== "/new-session") return undefined
      const draftID = new URLSearchParams(path.split("?")[1]).get("draftId")
      const draft = tabs.store.find((item) => item.type === "draft" && item.draftID === draftID)
      if (draft?.type === "draft") return { path, server: draft.server, directory: draft.directory }
      return undefined
    },
    undefined,
    {
      // Unrelated tab hydration must not undo a project explicitly selected in the sidebar.
      equals: (previous, next) =>
        previous?.path === next?.path && previous?.server === next?.server && previous?.directory === next?.directory,
    },
  )
  createEffect(
    on(routeProject, (project) => {
      if (!project) return
      home.selection.set({ server: project.server, directory: project.directory })
      const conn = home.server.list().find((item) => ServerConnection.key(item) === project.server)
      if (!conn) return
      const ctx = home.server.context(conn)
      const item = ctx.projects
        .list()
        .find((item) =>
          [item.worktree, ...(item.sandboxes ?? [])].some(
            (directory) => pathKey(directory) === pathKey(project.directory),
          ),
        )
      if (item) ctx.projects.expand(item.worktree)
    }),
  )
  const projectPending = () => /^\/server\/[^/]+\/session\/[^/]+$/.test(location.pathname) && !routeProject()
  const searchRecords = createMemo(() => {
    const value = state.search.trim().toLowerCase()
    return sessions.data
      .searchRecords()
      .filter((record) => `${record.session.title} ${record.projectName}`.toLowerCase().includes(value))
  })
  const drafts = createMemo(() =>
    tabs.store.filter((tab): tab is DraftTab => tab.type === "draft" && tab.server === sessions.session.server()),
  )
  const draftID = () =>
    activePath().startsWith("/new-session?") && new URLSearchParams(activePath().split("?")[1]).get("draftId")
  const activeSession = (id: string) =>
    activePath().split("?")[0].endsWith(`/session/${id}`) && routeProject()?.server === sessions.session.server()
  const chats = createMemo<ProjectChat[]>(() => {
    const value = state.search.trim().toLowerCase()
    return [
      ...searchRecords().map((record) => ({
        type: "session" as const,
        key: record.session.id,
        title: record.session.title,
        updated: sessions.session.workflowTime(record.session),
        record,
      })),
      ...drafts().flatMap((tab) => {
        const project = home.project
          .list()
          .find((project) =>
            [project.worktree, ...(project.sandboxes ?? [])].some(
              (directory) => pathKey(directory) === pathKey(tab.directory),
            ),
          )
        if (!project) return []
        const prompt = tabs.state(tab, "prompt", () => createDraftPromptSession(tab.draftID))
        const title =
          prompt
            .current()
            .map((part) => ("content" in part ? part.content : ""))
            .join("")
            .split(/\r?\n/)
            .find((line) => line.trim())
            ?.trim()
            .slice(0, 80) || language.t("quietCompanion.newTask")
        if (!`${title} ${displayName(project)}`.toLowerCase().includes(value)) return []
        return [{ type: "draft" as const, key: `draft:${tab.draftID}`, title, updated: tab.updated ?? 0, tab, project }]
      }),
    ].sort(
      (a, b) =>
        Number(b.type === "session" && sessions.session.needsAttention(b.record.session)) -
          Number(a.type === "session" && sessions.session.needsAttention(a.record.session)) ||
        b.updated - a.updated ||
        a.key.localeCompare(b.key),
    )
  })
  const activeChat = (chat: ProjectChat) =>
    chat.type === "draft" ? draftID() === chat.tab.draftID : activeSession(chat.record.session.id)
  const section = (chat: ProjectChat) => {
    if (chat.type === "draft") return "inbox"
    const state = sessions.session.workflow(chat.record.session)
    if (state === "snoozed" || state === "settled") return state
    return sessions.session.isPinned(chat.record.session) ? "pinned" : state
  }
  const sectionKey = (value: string) => JSON.stringify([sessions.session.server(), "workflow", value])
  const openChat = (chat: ProjectChat, background = false) => {
    if (chat.type === "session") return openSession(chat.record, background)
    if (background) return
    closeNavigation()
    tabs.select(chat.tab)
  }
  const openSession = (record: HomeSessionRecord, background = false) => {
    if (settings.general.newLayoutDesigns()) {
      if (!background) closeNavigation()
      sessions.session.open(record.session, { background })
      return
    }
    const conn = home.server.focused()
    if (!conn) return
    closeNavigation()
    server.setActive(ServerConnection.key(conn))
    navigate(legacySessionHref(record.session.directory, record.session.id))
  }
  const backgroundOpen = (event: MouseEvent) =>
    shouldOpenSessionInBackground({
      button: event.button,
      mac: /(Mac|iPod|iPhone|iPad)/.test(navigator.platform),
      meta: event.metaKey,
      ctrl: event.ctrlKey,
      shift: event.shiftKey,
      alt: event.altKey,
    })
  const navigateSearch = (event: KeyboardEvent) => {
    if (event.isComposing || event.altKey || event.ctrlKey || event.metaKey) return
    if (event.key === "Enter" && event.target === refs.search && state.search.trim()) {
      const chat = chats()[0]
      if (!chat) return
      event.preventDefault()
      openChat(chat)
      return
    }
    if (event.key !== "ArrowDown" && event.key !== "ArrowUp") return
    const seen = new Set<string>()
    const controls = Array.from(refs.nav?.querySelectorAll<HTMLButtonElement>(".cm3-sidebar-task") ?? []).filter(
      (element) => {
        if (!element.getClientRects().length) return false
        const id = element.closest<HTMLElement>("[data-session-id], [data-draft-id]")?.dataset
        const key = id?.sessionId ?? id?.draftId
        if (!key || seen.has(key)) return false
        seen.add(key)
        return true
      },
    )
    if (!controls.length) return
    event.preventDefault()
    const current =
      event.currentTarget instanceof HTMLElement
        ? event.currentTarget.closest<HTMLElement>("[data-session-id], [data-draft-id]")?.dataset
        : undefined
    const key = current?.sessionId ?? current?.draftId
    const index = controls.findIndex((element) => {
      const id = element.closest<HTMLElement>("[data-session-id], [data-draft-id]")?.dataset
      return key !== undefined && key === (id?.sessionId ?? id?.draftId)
    })
    const next =
      index < 0
        ? event.key === "ArrowDown"
          ? 0
          : controls.length - 1
        : (index + (event.key === "ArrowDown" ? 1 : -1) + controls.length) % controls.length
    controls[next]?.focus()
  }
  const openTask = (conn: ServerConnection.Any, directory: string) => {
    if (settings.general.newLayoutDesigns()) return home.project.openProjectNewSession(conn, directory)
    home.server.context(conn).projects.open(directory)
    home.server.context(conn).projects.touch(directory)
    server.setActive(ServerConnection.key(conn))
    navigate(`/${base64Encode(directory)}/session`)
  }
  const create = () => {
    if (projectPending()) return
    const conn = home.server.focused()
    const project = home.project.newSession()
    if (!conn) return
    closeNavigation()
    if (!project) {
      pickDirectory({
        server: conn,
        onSelect: (result) => {
          if (!result) return
          const directories = Array.isArray(result) ? result : [result]
          home.project.add(conn, directories)
          if (directories[0]) openTask(conn, directories[0])
        },
      })
      return
    }
    openTask(conn, project.worktree)
  }
  const renderSession = (record: Accessor<HomeSessionRecord>) => {
    const avatar = useSessionTabAvatarState(
      sessions.session.server,
      () => record().session.directory,
      () => record().session.id,
    )
    const description = () => {
      if (sessions.session.settling(record().session)) return language.t("session.workflow.settling")
      if (avatar.hasQuestions()) return language.t("sidebar.session.status.question")
      if (avatar.hasPermissions()) return language.t("sidebar.session.status.permission")
      if (avatar.loading()) return language.t("sidebar.session.status.running")
      if (avatar.unread()) return language.t("sidebar.session.status.unread")
      return undefined
    }
    return (
      <div
        class="cm3-sidebar-session"
        data-session-id={record().session.id}
        role="group"
        aria-label={record().session.title}
      >
        <button
          class="cm3-sidebar-task"
          data-action="sidebar-session"
          aria-label={record().session.title}
          draggable={settings.general.newLayoutDesigns() && split.state.available}
          onDragStart={(event) => {
            const href = sessionHref(sessions.session.server(), record().session.id)
            event.dataTransfer?.setData("text/plain", href)
            split.startDrag(href)
          }}
          onDragEnd={split.endDrag}
          type="button"
          data-active={activeSession(record().session.id)}
          aria-current={activeSession(record().session.id) ? "page" : undefined}
          aria-description={description()}
          onKeyDown={navigateSearch}
          onMouseDown={(event) => {
            if (event.button === 1) event.preventDefault()
          }}
          onClick={(event) => openSession(record(), backgroundOpen(event))}
          onAuxClick={(event) => {
            if (!backgroundOpen(event)) return
            event.preventDefault()
            openSession(record(), true)
          }}
        >
          <div class="size-4 shrink-0" aria-hidden="true">
            <SessionTabAvatarView
              project={record().project}
              directory={record().session.directory}
              unread={avatar.unread()}
              loading={avatar.loading()}
              revealProjectOnHover={false}
            />
          </div>
          <span class="cm3-sidebar-task-copy">
            <span dir="auto">{record().session.title}</span>
            <span class="cm3-sidebar-task-project" dir="auto">
              {record().projectName}
            </span>
          </span>
          <Show when={sessions.session.settling(record().session)}>
            <span class="cm3-sidebar-draft-label">{language.t("session.workflow.settling")}</span>
          </Show>
        </button>
        <button
          class="cm3-sidebar-session-pin"
          type="button"
          disabled={!sessions.session.pinsReady()}
          aria-pressed={sessions.session.isPinned(record().session)}
          aria-label={language.t(
            sessions.session.isPinned(record().session) ? "sidebar.session.unpin" : "sidebar.session.pin",
          )}
          title={language.t(
            sessions.session.isPinned(record().session) ? "sidebar.session.unpin" : "sidebar.session.pin",
          )}
          onClick={() => {
            const item = record()
            const pin = !sessions.session.isPinned(item.session)
            const state = sessions.session.workflow(item.session)
            const destination = state === "snoozed" || state === "settled" ? state : pin ? "pinned" : state
            const key = sectionKey(destination)
            const items = chats().filter((chat) => chat.key === item.session.id || section(chat) === destination)
            const position = items.findIndex((chat) => chat.key === item.session.id)
            setSidebar("expanded", key, true)
            setSessionLimits(
              key,
              Math.max(
                sessionLimits[key] ?? PROJECT_SESSIONS_PAGE,
                position + 1 + Number(items.findIndex(activeChat) > position),
              ),
            )
            sessions.session.pin(item.session, pin)
            queueMicrotask(() =>
              refs.nav
                ?.querySelector<HTMLButtonElement>(
                  `[data-session-id="${CSS.escape(item.session.id)}"] .cm3-sidebar-session-pin`,
                )
                ?.focus({ preventScroll: true }),
            )
          }}
        >
          <Icon
            name={sessions.session.isPinned(record().session) ? "push-pin-fill" : "push-pin"}
            style={{ width: "12.8px", height: "12.8px" }}
          />
        </button>
        <Show when={settings.general.newLayoutDesigns()}>
          <button
            class="cm3-sidebar-session-archive"
            type="button"
            aria-label={language.t("common.archive")}
            title={language.t("common.archive")}
            onClick={() => void sessions.session.archive(record().session)}
          >
            <Icon name="archive" size="small" />
          </button>
        </Show>
        <MenuV2 modal={false} placement="bottom-end">
          <MenuV2.Trigger class="cm3-sidebar-session-menu" type="button" aria-label={language.t("common.moreOptions")}>
            <Icon name="outline-dots" size="small" />
          </MenuV2.Trigger>
          <MenuV2.Portal>
            <MenuV2.Content>
              <Show when={settings.general.newLayoutDesigns()}>
                <MenuV2.Item
                  disabled={!split.state.available}
                  onSelect={() => split.open(sessionHref(sessions.session.server(), record().session.id))}
                >
                  {language.t("chat.split.open")}
                </MenuV2.Item>
              </Show>
              <MenuV2.Item
                disabled={
                  !server.ready() ||
                  (!sessions.session.settling(record().session) &&
                    sessions.session.workflow(record().session) !== "settled" &&
                    !sessions.session.canSettle(record().session))
                }
                onSelect={() =>
                  sessions.session.organize(
                    record().session,
                    sessions.session.workflow(record().session) === "settled" ||
                      sessions.session.settling(record().session)
                      ? "inbox"
                      : "settled",
                  )
                }
              >
                {language.t(
                  sessions.session.settling(record().session)
                    ? "session.workflow.cancelSettle"
                    : sessions.session.workflow(record().session) === "settled"
                      ? "session.workflow.moveToInbox"
                      : "session.workflow.settle",
                )}
              </MenuV2.Item>
              <Show
                when={sessions.session.workflow(record().session) === "snoozed"}
                fallback={
                  <>
                    <MenuV2.Item
                      disabled={!server.ready() || !sessions.session.canSnooze(record().session)}
                      onSelect={() =>
                        sessions.session.organize(record().session, "snoozed", Date.now() + 60 * 60 * 1000)
                      }
                    >
                      {language.t("session.workflow.snoozeHour")}
                    </MenuV2.Item>
                    <MenuV2.Item
                      disabled={!server.ready() || !sessions.session.canSnooze(record().session)}
                      onSelect={() => {
                        const tomorrow = new Date()
                        tomorrow.setDate(tomorrow.getDate() + 1)
                        tomorrow.setHours(9, 0, 0, 0)
                        void sessions.session.organize(record().session, "snoozed", tomorrow.getTime())
                      }}
                    >
                      {language.t("session.workflow.snoozeTomorrow")}
                    </MenuV2.Item>
                  </>
                }
              >
                <MenuV2.Item
                  disabled={!server.ready()}
                  onSelect={() => sessions.session.organize(record().session, "inbox")}
                >
                  {language.t("session.workflow.wake")}
                </MenuV2.Item>
              </Show>
              <Show when={settings.general.newLayoutDesigns()}>
                <MenuV2.Item onSelect={() => void sessions.session.archive(record().session)}>
                  {language.t("common.archive")}
                </MenuV2.Item>
              </Show>
            </MenuV2.Content>
          </MenuV2.Portal>
        </MenuV2>
      </div>
    )
  }
  const renderDraft = (chat: Accessor<Extract<ProjectChat, { type: "draft" }>>) => (
    <div class="cm3-sidebar-session" data-draft-id={chat().tab.draftID} role="group" aria-label={chat().title}>
      <button
        class="cm3-sidebar-task"
        data-action="project-draft"
        type="button"
        data-active={activeChat(chat())}
        aria-current={activeChat(chat()) ? "page" : undefined}
        onKeyDown={navigateSearch}
        onClick={() => openChat(chat())}
      >
        <div class="size-4 shrink-0" aria-hidden="true">
          <Cm3Icon name="note-pencil" size={16} />
        </div>
        <span class="cm3-sidebar-task-copy">
          <span dir="auto">{chat().title}</span>
          <span class="cm3-sidebar-task-project" dir="auto">
            {displayName(chat().project)}
          </span>
        </span>
        <span class="cm3-sidebar-draft-label">{language.t("sidebar.session.draft")}</span>
      </button>
      <MenuV2 modal={false} placement="bottom-end">
        <MenuV2.Trigger
          class="cm3-sidebar-session-menu"
          type="button"
          aria-label={language.t("common.moreOptions")}
          title={language.t("common.moreOptions")}
        >
          <Icon name="outline-dots" size="small" />
        </MenuV2.Trigger>
        <MenuV2.Portal>
          <MenuV2.Content>
            <MenuV2.Item
              onSelect={() => {
                const index = tabs.store.findIndex((tab) => tab.type === "draft" && tab.draftID === chat().tab.draftID)
                if (index !== -1) tabs.removeTab(index)
                queueMicrotask(() => refs.search?.focus({ preventScroll: true }))
              }}
            >
              {language.t("sidebar.session.discardDraft")}
            </MenuV2.Item>
          </MenuV2.Content>
        </MenuV2.Portal>
      </MenuV2>
    </div>
  )

  const renderWorkflow = (values: Array<"pinned" | "inbox" | "working" | "snoozed" | "settled">) => (
    <For each={values}>
      {(value) => {
        const key = () => sectionKey(value)
        const items = () => chats().filter((chat) => section(chat) === value)
        const expanded = () =>
          !!state.search.trim() || (sidebar.expanded[key()] ?? (value === "inbox" || value === "pinned"))
        const limit = () => sessionLimits[key()] ?? (value === "settled" ? 10 : PROJECT_SESSIONS_PAGE)
        const visible = () => {
          if (!expanded()) return items().filter(activeChat)
          const page = items().slice(0, limit())
          const active = items().find(activeChat)
          if (!active || page.includes(active)) return page
          return [...page.slice(0, -1), active]
        }
        const label = () =>
          value === "pinned" ? language.t("sidebar.session.pinned") : language.t(`session.workflow.${value}`)
        return (
          <Show when={value !== "pinned" || items().length}>
            <section data-workflow={value} aria-label={label()}>
              <button
                class="cm-workflow-heading"
                type="button"
                aria-label={label()}
                aria-expanded={expanded()}
                onClick={() => setSidebar("expanded", key(), !expanded())}
              >
                <span aria-hidden="true">{expanded() ? "▾" : "▸"}</span>
                <span>{label()}</span>
                <span class="cm-workflow-count">{items().length}</span>
              </button>
              <For each={visible().map((chat) => chat.key)}>
                {(key) => {
                  const chat = createMemo(() => items().find((chat) => chat.key === key))
                  const draft = () => {
                    const value = chat()
                    return value?.type === "draft" ? value : undefined
                  }
                  const record = () => {
                    const value = chat()
                    return value?.type === "session" ? value.record : undefined
                  }
                  return (
                    <>
                      <Show when={draft()}>{renderDraft}</Show>
                      <Show when={record()}>{(record) => renderSession(record)}</Show>
                    </>
                  )
                }}
              </For>
              <Show when={expanded() && items().length > limit()}>
                <button
                  class="cm3-sidebar-action"
                  type="button"
                  data-action="workflow-show-more"
                  onClick={() => setSessionLimits(key(), limit() + (value === "settled" ? 25 : PROJECT_SESSIONS_PAGE))}
                >
                  {language.t("common.showMore")}
                </button>
              </Show>
            </section>
          </Show>
        )
      }}
    </For>
  )
  return (
    <>
      <button
        ref={(element) => (refs.toggle = element)}
        class="cm3-navigation-toggle"
        type="button"
        aria-label={language.t("command.sidebar.toggle")}
        aria-expanded={state.navigation}
        onClick={() => {
          setState("navigation", true)
          queueMicrotask(() =>
            Array.from(refs.nav?.querySelectorAll<HTMLButtonElement>("button") ?? [])
              .find((element) => element.getClientRects().length > 0)
              ?.focus(),
          )
        }}
      >
        <Cm3Icon name="sidebar-simple" />
      </button>
      <Show when={state.navigation}>
        <button
          class="cm3-navigation-backdrop"
          type="button"
          tabIndex={-1}
          aria-label={language.t("quietCompanion.closeNavigation")}
          onClick={closeNavigation}
        />
      </Show>
      <aside
        ref={(element) => (refs.nav = element)}
        class="cm3-sidebar"
        style={{ "--cm3-sidebar-expanded-width": `${sidebar.width}px` }}
        data-open={state.navigation}
        data-collapsed={sidebar.collapsed}
        aria-label={language.t("sidebar.nav.projectsAndSessions")}
        on:keydown={(event) => {
          if (event.defaultPrevented || event.isComposing) return
          if (event.key === "Escape") {
            if (!state.navigation || (event.target instanceof HTMLElement && event.target.isContentEditable)) return
            event.preventDefault()
            event.stopPropagation()
            closeNavigation()
            return
          }
          if (event.key !== "Tab" || !state.navigation || !refs.toggle?.offsetParent) return
          const controls = Array.from(
            event.currentTarget.querySelectorAll<HTMLElement>(
              "a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]",
            ),
          ).filter((element) => element.tabIndex >= 0 && element.getClientRects().length > 0)
          const first = controls[0]
          const last = controls.at(-1)
          if (event.shiftKey && event.target === first) {
            event.preventDefault()
            last?.focus()
          }
          if (!event.shiftKey && event.target === last) {
            event.preventDefault()
            first?.focus()
          }
        }}
      >
        <div class="cm3-sidebar-brand">
          <img
            class="cm3-sidebar-logo"
            src={theme.mode() === "dark" ? cookieMonsterBannerDark : cookieMonsterBannerLight}
            alt={language.t("quietCompanion.brand")}
            width={720}
            height={180}
          />
          <button
            class="cm3-sidebar-collapse"
            type="button"
            aria-label={language.t("command.sidebar.toggle")}
            title={language.t("command.sidebar.toggle")}
            aria-expanded={!sidebar.collapsed}
            onClick={() => setSidebar("collapsed", (value) => !value)}
          >
            <Cm3Icon name="sidebar-simple" />
          </button>
          <button
            class="cm3-navigation-close"
            type="button"
            aria-label={language.t("quietCompanion.closeNavigation")}
            onClick={closeNavigation}
          >
            <Cm3Icon name="x" />
          </button>
        </div>
        <div class="cm3-sidebar-content">
          <button
            class="cm3-sidebar-action"
            type="button"
            onClick={create}
            disabled={!home.server.focused() || projectPending()}
          >
            <Cm3Icon name="note-pencil" />
            {language.t("quietCompanion.newTask")}
          </button>
          <button
            class="cm3-sidebar-action"
            type="button"
            aria-pressed={scheduling.isOpen()}
            data-action="scheduling"
            onClick={() => {
              scheduling.open()
              setState("navigation", false)
            }}
          >
            <Cm3Icon name="clock" />
            {language.t("schedules.title")}
          </button>
          <label class="cm3-sidebar-search">
            <Cm3Icon name="magnifying-glass" />
            <input
              ref={(element) => (refs.search = element)}
              type="search"
              value={state.search}
              onInput={(event) => setState("search", event.currentTarget.value)}
              onKeyDown={navigateSearch}
              placeholder={language.t("quietCompanion.search")}
              aria-label={language.t("quietCompanion.searchThreads")}
            />
          </label>
          <div class="cm3-sidebar-scroll">
            <div class="cm3-sidebar-workflow cm3-sidebar-inbox">
              {renderWorkflow(["pinned", "inbox"])}
              <Show
                when={!sessions.data.loading()}
                fallback={<p role="status">{language.t("quietCompanion.loading")}</p>}
              >
                <Show when={sessions.data.error()}>
                  <p role="alert">{language.t("common.requestFailed")}</p>
                  <button type="button" onClick={() => void sessions.data.retry()}>
                    {language.t("browser.action.reload")}
                  </button>
                </Show>
                <Show when={!chats().length && !sessions.data.error()}>
                  <p role="status">{language.t("quietCompanion.noThreads")}</p>
                </Show>
              </Show>
            </div>
            <details class="cm3-sidebar-project-navigation">
              <summary class="cm3-sidebar-section">
                <span class="cm3-project-disclosure-arrow" aria-hidden="true">
                  ▸
                </span>
                {language.t("home.projects")}
              </summary>
              <HomeProjects
                projects={projects}
                sidebar
                onOpenProjectNewSession={openTask}
                onSelectProject={home.project.select}
                onActivateProject={closeNavigation}
              />
              <button
                class="cm3-sidebar-action"
                type="button"
                onClick={() => {
                  const conn = home.server.focused()
                  if (!conn) return
                  pickDirectory({
                    server: conn,
                    onSelect: (result) => {
                      if (!result) return
                      const directories = Array.isArray(result) ? result : [result]
                      home.project.add(conn, directories)
                      if (directories[0]) openTask(conn, directories[0])
                    },
                  })
                }}
              >
                <Cm3Icon name="plus" />
                {language.t("command.project.open")}
              </button>
            </details>
          </div>
          <div class="cm3-sidebar-workflow cm3-sidebar-shelves">
            {renderWorkflow(["working", "snoozed", "settled"])}
          </div>
          <div class="cm3-sidebar-footer">
            <WppAuthControl />
            <button type="button" onClick={projects.utility.help}>
              <Cm3Icon name="question" />
              {language.t("sidebar.help")}
            </button>
            <button type="button" onClick={openSettings}>
              <Cm3Icon name="gear" />
              {language.t("quietCompanion.settings")}
            </button>
          </div>
        </div>
        <ResizeHandle
          class="cm3-sidebar-resize"
          direction="horizontal"
          size={sidebar.width}
          min={220}
          max={480}
          onResize={(width) => setSidebar("width", width)}
          role="separator"
          aria-label={language.t("sidebar.resize")}
          aria-orientation="vertical"
          aria-valuemin={220}
          aria-valuemax={480}
          aria-valuenow={sidebar.width}
          tabIndex={sidebar.collapsed ? -1 : 0}
          onKeyDown={(event) => {
            if (event.key !== "ArrowLeft" && event.key !== "ArrowRight") return
            event.preventDefault()
            const rtl = getComputedStyle(event.currentTarget).direction === "rtl"
            const delta = (event.key === "ArrowRight") !== rtl ? 10 : -10
            setSidebar("width", (width) => Math.min(480, Math.max(220, width + delta)))
          }}
        />
      </aside>
    </>
  )
}
