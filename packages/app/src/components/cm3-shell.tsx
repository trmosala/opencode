import { createStore } from "solid-js/store"
import { createEffect, createMemo, For, on, onCleanup, Show } from "solid-js"
import { useLocation, useNavigate } from "@solidjs/router"
import { useLanguage } from "@/context/language"
import { useSettings } from "@/context/settings"
import { useLayout } from "@/context/layout"
import { useCommand } from "@/context/command"
import { ServerConnection, serverName, useServer } from "@/context/server"
import { base64Encode } from "@opencode-ai/core/util/encode"
import { decode64 } from "@/utils/base64"
import { tabKey, useTabs } from "@/context/tabs"
import { legacySessionHref } from "@/utils/session-route"
import { createHomeController } from "@/pages/home/home-controller"
import { createHomeSessionsController } from "@/pages/home/home-sessions-controller"
import { displayName } from "@/pages/layout/helpers"
import { useDirectoryPicker } from "./directory-picker"
import { useSettingsDialog } from "./settings-dialog"
import { Cm3Icon } from "./cm3-icon"
import { QuietCompanionControls } from "./quiet-companion-switch"
import { WppAuthControl } from "./wpp-auth-control"

export function Cm3Shell() {
  const home = createHomeController()
  const sessions = createHomeSessionsController(home, { registerPalette: false })
  const language = useLanguage()
  const settings = useSettings()
  const server = useServer()
  const location = useLocation()
  const tabs = useTabs()
  const layout = useLayout()
  const command = useCommand()
  const navigate = useNavigate()
  const pickDirectory = useDirectoryPicker()
  const openSettings = useSettingsDialog()
  const [state, setState] = createStore({ search: "", navigation: false })
  const refs: { toggle?: HTMLButtonElement; nav?: HTMLElement } = {}
  const closeNavigation = () => {
    setState("navigation", false)
    refs.toggle?.focus({ preventScroll: true })
  }
  createEffect(on(() => `${location.pathname}${location.search}`, closeNavigation, { defer: true }))
  const routeProject = createMemo(
    () => {
      const path = `${location.pathname}${location.search}`
      const target = location.pathname.match(/^\/server\/([^/]+)\/session\/([^/]+)$/)
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
      const legacy = location.pathname.match(/^\/([^/]+)\/session(?:\/[^/]+)?$/)
      if (legacy) {
        const directory = decode64(legacy[1])
        if (directory) return { path, server: server.key, directory }
        return undefined
      }
      if (location.pathname !== "/new-session") return undefined
      const draftID = new URLSearchParams(location.search).get("draftId")
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
      if (project) home.selection.set({ server: project.server, directory: project.directory })
    }),
  )
  const projectPending = () => /^\/server\/[^/]+\/session\/[^/]+$/.test(location.pathname) && !routeProject()
  const records = createMemo(() => {
    const value = state.search.trim().toLowerCase()
    return (value ? sessions.data.searchRecords() : sessions.data.records()).filter((record) =>
      `${record.session.title} ${record.projectName}`.toLowerCase().includes(value),
    )
  })
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
    if (settings.general.newLayoutDesigns()) return command.trigger("tab.new")
    openTask(conn, project.worktree)
  }

  return (
    <>
      <button
        ref={(element) => (refs.toggle = element)}
        class="cm3-navigation-toggle"
        type="button"
        aria-label={language.t("quietCompanion.openNavigation")}
        aria-expanded={state.navigation}
        onClick={() => {
          setState("navigation", true)
          queueMicrotask(() => refs.nav?.querySelector<HTMLButtonElement>("button")?.focus())
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
        data-open={state.navigation}
        aria-label={language.t("sidebar.nav.projectsAndSessions")}
        onKeyDown={(event) => {
          if (event.key === "Escape") {
            event.preventDefault()
            event.stopPropagation()
            closeNavigation()
            return
          }
          if (event.key !== "Tab" || !state.navigation || !refs.toggle?.offsetParent) return
          const controls = Array.from(
            event.currentTarget.querySelectorAll<HTMLElement>("button:not([disabled]), input, select"),
          )
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
          {language.t("quietCompanion.title")}
          <button
            class="cm3-navigation-close"
            type="button"
            aria-label={language.t("quietCompanion.closeNavigation")}
            onClick={closeNavigation}
          >
            <Cm3Icon name="x" />
          </button>
        </div>
        <button
          class="cm3-sidebar-action"
          type="button"
          onClick={create}
          disabled={!home.server.focused() || projectPending()}
        >
          <Cm3Icon name="note-pencil" />
          {language.t("quietCompanion.newTask")}
        </button>
        <label class="cm3-sidebar-search">
          <Cm3Icon name="magnifying-glass" />
          <input
            type="search"
            value={state.search}
            onInput={(event) => setState("search", event.currentTarget.value)}
            placeholder={language.t("quietCompanion.search")}
            aria-label={language.t("quietCompanion.searchThreads")}
          />
        </label>
        <div class="cm3-sidebar-scroll">
          <Show when={settings.general.newLayoutDesigns()}>
            <p class="cm3-sidebar-section">{language.t("quietCompanion.openTabs")}</p>
            <div
              class="cm3-sidebar-tabs"
              ref={(element) => {
                layout.tabStrip.setMount(element)
                onCleanup(() => layout.tabStrip.setMount(undefined))
              }}
            />
            <button class="cm3-sidebar-action" type="button" onClick={() => command.trigger("tab.reopenClosed")}>
              <Cm3Icon name="chats" />
              {language.t("command.tab.reopenClosed")}
            </button>
          </Show>
          <p class="cm3-sidebar-section">{language.t("sidebar.project.recentSessions")}</p>
          <Show when={!sessions.data.loading()} fallback={<p role="status">{language.t("quietCompanion.loading")}</p>}>
            <For each={records()}>
              {(record) => (
                <button
                  class="cm3-sidebar-task"
                  type="button"
                  data-active={location.pathname.endsWith(`/session/${record.session.id}`)}
                  onClick={() => {
                    closeNavigation()
                    if (settings.general.newLayoutDesigns()) return sessions.session.open(record.session)
                    const conn = home.server.focused()
                    if (!conn) return
                    server.setActive(ServerConnection.key(conn))
                    navigate(legacySessionHref(record.session.directory, record.session.id))
                  }}
                >
                  <Cm3Icon name="chats" />
                  <span>{record.session.title}</span>
                </button>
              )}
            </For>
            <Show when={sessions.data.error()}>
              <p role="alert">{language.t("common.requestFailed")}</p>
              <button type="button" onClick={() => void sessions.data.retry()}>
                {language.t("browser.action.reload")}
              </button>
            </Show>
            <Show when={!records().length && !sessions.data.error()}>
              <p role="status">{language.t("quietCompanion.noThreads")}</p>
            </Show>
          </Show>
          <p class="cm3-sidebar-section">{language.t("quietCompanion.projects")}</p>
          <For each={home.server.list()}>
            {(conn) => (
              <div>
                <button
                  class="cm3-sidebar-project"
                  type="button"
                  data-active={home.selection.value().server === ServerConnection.key(conn)}
                  onClick={() => home.selection.focusServer(conn)}
                >
                  {serverName(conn)}
                </button>
                <For each={home.project.forServer(conn)}>
                  {(project) => (
                    <button
                      class="cm3-sidebar-project"
                      type="button"
                      data-active={
                        home.selection.value().server === ServerConnection.key(conn) &&
                        home.selection.value().directory === project.worktree
                      }
                      title={project.worktree}
                      onClick={() => {
                        home.project.select(conn, project.worktree)
                        closeNavigation()
                      }}
                    >
                      <Cm3Icon name="folder" />
                      <span>{displayName(project)}</span>
                    </button>
                  )}
                </For>
              </div>
            )}
          </For>
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
        </div>
        <div class="cm3-sidebar-footer">
          <QuietCompanionControls />
          <WppAuthControl />
          <button type="button" onClick={openSettings}>
            <Cm3Icon name="gear" />
            {language.t("quietCompanion.settings")}
          </button>
        </div>
      </aside>
    </>
  )
}
