import { CMLoading } from "@/components/cm-loading"
import { For, Match, Show, Switch, createEffect, createMemo, onCleanup, on, type JSX } from "solid-js"
import { createStore } from "solid-js/store"
import { Portal } from "solid-js/web"
import { createMediaQuery } from "@solid-primitives/media"
import { DragDropProvider as DndKitProvider, PointerSensor } from "@dnd-kit/solid"
import { isSortable } from "@dnd-kit/solid/sortable"
import { Accessibility, AutoScroller, Feedback, PointerActivationConstraints } from "@dnd-kit/dom"
import { RestrictToHorizontalAxis } from "@dnd-kit/abstract/modifiers"
import { RestrictToElement } from "@dnd-kit/dom/modifiers"
import {
  DragDropProvider,
  DragDropSensors,
  DragOverlay,
  SortableProvider,
  closestCenter,
  type DragEvent,
} from "@thisbeyond/solid-dnd"
import { Tabs } from "@opencode-ai/ui/tabs"
import { IconButton } from "@opencode-ai/ui/icon-button"
import { Icon } from "@opencode-ai/ui/icon"
import { TooltipKeybind } from "@opencode-ai/ui/tooltip"
import { ResizeHandle } from "@opencode-ai/ui/resize-handle"
import { Mark } from "@opencode-ai/ui/logo"
import { IconButtonV2 } from "@opencode-ai/ui/v2/icon-button-v2"
import { KeybindV2 } from "@opencode-ai/ui/v2/keybind-v2"
import { TooltipV2 } from "@opencode-ai/ui/v2/tooltip-v2"
import type { SnapshotFileDiff, VcsFileDiff } from "@opencode-ai/sdk/v2"
import type { FileDiffInfo } from "@opencode-ai/client/promise"
import { ConstrainDragYAxis, getDraggableId } from "@/utils/solid-dnd"

import FileTree from "@/components/file-tree"
import { BrowserTabMenu } from "@/components/browser-panel/browser-tools"
import { reconcileBrowserSessionTabs } from "@/context/layout-tabs"
import type { BrowserShortcut, BrowserTabs } from "@/browser-panel"
import { showToast } from "@/utils/toast"
import { BrowserPanel } from "@/components/browser-panel/browser-panel"
import { normalizeFileTreeV2Path } from "@/components/file-tree-v2-model"
import { SessionContextUsage } from "@/components/session-context-usage"

const reviewTabID = "session-side-panel-review-tab"
const reviewTabPanelID = "session-side-panel-review-tabpanel"
const fileBrowserTabPanelID = "session-side-panel-file-browser-tabpanel"
import { SessionContextTab, SortableTab, SortableTabV2, FileVisual } from "@/components/session"
import { OpenInAppV2 } from "@/components/session/open-in-app-v2"
import { useCommand } from "@/context/command"
import { useFile, type SelectedLineRange } from "@/context/file"
import { useLanguage } from "@/context/language"
import { useLayout } from "@/context/layout"
import { usePlatform } from "@/context/platform"
import { useSDK } from "@/context/sdk"
import { useSettings } from "@/context/settings"
import { createFileTabListSync } from "@/pages/session/file-tab-scroll"
import { FileTabContent } from "@/pages/session/file-tabs"
import {
  SESSION_OPEN_FILE_TAB,
  createOpenSessionFileTab,
  createSessionTabs,
  getTabReorderIndex,
  shouldShowFileTree,
  type Sizing,
} from "@/pages/session/helpers"
import { setSessionHandoff } from "@/pages/session/handoff"
import { useSessionLayout } from "@/pages/session/session-layout"
import { SessionFileBrowserTab, type SessionFileBrowserState } from "@/pages/session/v2/session-file-browser-tab"

type ReviewDiff = FileDiffInfo | SnapshotFileDiff | VcsFileDiff
type RenderDiff = FileDiffInfo | (SnapshotFileDiff & { file: string }) | VcsFileDiff
const FILE_TREE_WIDTH_MIN = 240

function renderDiff(value: ReviewDiff): value is RenderDiff {
  return typeof value.file === "string"
}

export function SessionSidePanel(props: {
  canReview: () => boolean
  diffs: () => ReviewDiff[]
  diffsReady: () => boolean
  empty: () => string
  hasReview: () => boolean
  reviewHasFocusableContent: () => boolean
  reviewCount: () => number
  reviewPanel: () => JSX.Element
  reviewSidebarToggle?: (disabled: boolean) => JSX.Element
  fileBrowserState?: SessionFileBrowserState
  activeDiff?: string
  focusReviewDiff: (path: string) => void
  reviewSnap: boolean
  size: Sizing
  stacked?: boolean
  tabsMount?: HTMLDivElement
}) {
  const layout = useLayout()
  const settings = useSettings()
  const file = useFile()
  const language = useLanguage()
  const command = useCommand()
  const platform = usePlatform()
  const sdk = useSDK()
  const { sessionKey, tabs, view, params } = useSessionLayout()
  const projectDirectory = createMemo(() => sdk().directory)

  const isDesktop = createMediaQuery("(min-width: 768px)")
  const shown = settings.visibility.fileTree

  const reviewOpen = createMemo(() => isDesktop() && view().reviewPanel.opened())
  const fileOpen = createMemo(
    () =>
      isDesktop() &&
      shouldShowFileTree({
        visible: shown(),
        opened: layout.fileTree.opened(),
      }),
  )
  const fileTreeWidth = createMemo(() => Math.max(FILE_TREE_WIDTH_MIN, layout.fileTree.width()))
  const reviewTab = createMemo(() => isDesktop())
  const treeWidth = createMemo(() => (fileOpen() ? `${fileTreeWidth()}px` : "0px"))

  const diffs = createMemo(() => props.diffs().filter(renderDiff))
  const diffFiles = createMemo(() => diffs().map((d) => d.file))
  const kinds = createMemo(() => {
    const merge = (a: "add" | "del" | "mix" | undefined, b: "add" | "del" | "mix") => {
      if (!a) return b
      if (a === b) return a
      return "mix" as const
    }

    const out = new Map<string, "add" | "del" | "mix">()
    for (const diff of diffs()) {
      const file = normalizeFileTreeV2Path(diff.file)
      const kind = diff.status === "added" ? "add" : diff.status === "deleted" ? "del" : "mix"

      out.set(file, kind)

      const parts = file.split("/")
      for (const [idx] of parts.slice(0, -1).entries()) {
        const dir = parts.slice(0, idx + 1).join("/")
        if (!dir) continue
        out.set(dir, merge(out.get(dir), kind))
      }
    }
    return out
  })

  const empty = (msg: string) => (
    <div class="h-full flex flex-col">
      <div class="h-6 shrink-0" aria-hidden />
      <div class="flex-1 pb-64 flex items-center justify-center text-center">
        <div class="text-12-regular text-text-weak">{msg}</div>
      </div>
    </div>
  )

  const nofiles = createMemo(() => {
    const state = file.tree.state("")
    if (!state?.loaded) return false
    return file.tree.children("").length === 0
  })

  const normalizeTab = (tab: string) => {
    if (!tab.startsWith("file://")) return tab
    return file.tab(tab)
  }

  const openReviewPanel = () => {
    if (!view().reviewPanel.opened()) view().reviewPanel.open()
  }

  const openTab = createOpenSessionFileTab({
    normalizeTab,
    openTab: tabs().open,
    pathFromTab: file.pathFromTab,
    loadFile: file.load,
    openReviewPanel,
    setActive: tabs().setActive,
  })

  const tabState = createSessionTabs({
    tabs,
    pathFromTab: file.pathFromTab,
    normalizeTab,
    review: reviewTab,
    hasReview: props.canReview,
    fileBrowser: () => !!props.fileBrowserState,
  })
  const contextOpen = tabState.contextOpen
  const browserOpen = createMemo(() => !!platform.browserPanel && reviewOpen() && tabState.browserOpen())
  const open = createMemo(() => reviewOpen() || fileOpen() || browserOpen())
  const panelWidth = createMemo(() => {
    if (!open()) return "0px"
    if (reviewOpen() || browserOpen()) return "auto"
    return `${fileTreeWidth()}px`
  })
  const openFileOpen = tabState.openFileOpen
  const panelTabs = tabState.panelTabs
  const openedTabs = tabState.openedTabs
  const activeTab = tabState.activeTab
  const activeFileTab = tabState.activeFileTab

  const fileTreeTab = () => layout.fileTree.tab()

  const setFileTreeTabValue = (value: string) => {
    if (value !== "changes" && value !== "all") return
    layout.fileTree.setTab(value)
  }

  let fileFilter: HTMLInputElement | undefined
  let tabList: HTMLDivElement | undefined
  const temporaryTab = tabs().preview
  const previewTab = (value: string) => {
    const next = normalizeTab(value)
    tabs().previewTab(next)
    const path = file.pathFromTab(next)
    if (path) void file.load(path)
    openReviewPanel()
    queueMicrotask(() => tabs().setActive(next))
  }
  const openFileBrowser = () => {
    previewTab(SESSION_OPEN_FILE_TAB)
    queueMicrotask(() => fileFilter?.focus())
  }
  const browserFailure = () => showToast({ variant: "error", title: language.t("browser.toast.failed") })
  const activateTab = (value: string) => {
    const next = normalizeTab(value)
    const path = file.pathFromTab(next)
    if (path) void file.load(path)
    openReviewPanel()
    if (next.startsWith("browser:") && platform.browserPanel && params.id) {
      const sessionID = params.id
      void platform.browserPanel
        .command(sessionID, { op: "select", tabID: next.slice(8) })
        .then(() => {
          if (params.id === sessionID) tabs().setActive(next)
        })
        .catch(browserFailure)
      return
    }
    tabs().setActive(next)
  }
  const browserTab = createMemo(() => {
    if (!props.fileBrowserState) return undefined
    const active = activeTab()
    if (active === SESSION_OPEN_FILE_TAB) return SESSION_OPEN_FILE_TAB
    if (active && file.pathFromTab(active)) return active
    return activeFileTab()
  })
  // Keep the file-browser shell mounted while any file tab exists. Kobalte briefly
  // selects Review while the tab For replaces a preview trigger, which would
  // otherwise dispose the sidebar and reset scroll.
  const fileBrowserMounted = createMemo(() => {
    if (!props.fileBrowserState) return false
    return openedTabs().length > 0 || openFileOpen() || !!browserTab()
  })
  const fileBrowserVisible = createMemo(() => {
    const active = activeTab()
    return (
      active !== "review" &&
      active !== "context" &&
      active !== "browser" &&
      !active.startsWith("browser:") &&
      !active.startsWith("new-tab:") &&
      active !== "empty"
    )
  })
  const closeTabKeybind = createMemo(() => command.keybindParts("tab.close"))
  const [native, setNative] = createStore<BrowserTabs>({ sessionID: params.id ?? "", tabs: [] })
  const newTab = () => {
    const tab = `new-tab:${crypto.randomUUID()}`
    const key = sessionKey()
    openReviewPanel()
    void tabs().open(tab)
    // Kobalte can select Review before the new trigger registers, as with preview tabs.
    queueMicrotask(() => {
      if (sessionKey() === key && tabs().all().includes(tab)) tabs().setActive(tab)
    })
  }
  const acceptBrowser = (next: BrowserTabs) => {
    if (next.sessionID !== params.id) return
    if (native.sessionID === next.sessionID && (next.revision ?? 0) < (native.revision ?? 0)) return
    const previous = native.activeID
    setNative(next)
    const reconciled = reconcileBrowserSessionTabs(
      { all: tabs().all(), active: tabs().active() },
      next.tabs.map((tab) => tab.id),
      next.activeID,
      previous,
    )
    tabs().setAll(reconciled.all)
    tabs().setActive(reconciled.active)
  }
  createEffect(
    on(
      () => params.id,
      (sessionID) => {
        if (!platform.browserPanel || !sessionID) return
        setNative({ sessionID, tabs: [], activeID: undefined, revision: undefined })
        const unsubscribe = platform.browserPanel.subscribe(acceptBrowser)
        onCleanup(unsubscribe)
        void platform.browserPanel.command(sessionID, { op: "state" }).then(acceptBrowser).catch(browserFailure)
      },
    ),
  )
  createEffect(() => {
    if (!platform.browserPanel || !params.id || tabs().active() !== "browser") return
    const sessionID = params.id
    void platform.browserPanel
      .command(sessionID, { op: "state" })
      .then(async (next) => {
        if (params.id !== sessionID) return
        acceptBrowser(next.tabs.length ? next : await platform.browserPanel!.command(sessionID, { op: "new" }))
      })
      .catch(browserFailure)
  })
  const closePanelTab = (tab: string) => {
    if (!tab.startsWith("browser:")) return tabs().close(tab)
    if (!platform.browserPanel || !params.id) return
    void platform.browserPanel
      .command(params.id, { op: "close", tabID: tab.slice(8) })
      .then(acceptBrowser)
      .catch(browserFailure)
  }
  const panelShortcut = (value: BrowserShortcut) => {
    if (value === "new") return newTab()
    if (value === "close") return closePanelTab(activeTab())
    const all = [...(props.canReview() ? ["review"] : []), ...(contextOpen() ? ["context"] : []), ...panelTabs()]
    const index = all.indexOf(activeTab())
    const next = all[(index + (value === "next" ? 1 : -1) + all.length) % all.length]
    if (next) activateTab(next)
  }
  const specialTabTrigger = (tab: string) => {
    const item = () => native.tabs.find((item) => `browser:${item.id}` === tab)
    return (
      <Tabs.Trigger
        value={tab}
        onMiddleClick={() => closePanelTab(tab)}
        closeButton={
          <div class="flex items-center">
            <Show when={item()}>
              {(item) => (
                <BrowserTabMenu
                  tab={item()}
                  tabs={native.tabs}
                  activeID={native.activeID}
                  command={(value) =>
                    platform.browserPanel!.command(params.id!, value).then(acceptBrowser).catch(browserFailure)
                  }
                />
              )}
            </Show>
            <Show when={!item()?.pinned}>
              <IconButton
                icon="close-small"
                variant="ghost"
                class="h-5 w-5"
                aria-label={language.t("common.closeTab")}
                onClick={() => closePanelTab(tab)}
              />
            </Show>
          </div>
        }
      >
        <div class="flex items-center gap-2 min-w-0" aria-busy={item()?.loading}>
          <Icon name={tab.startsWith("browser:") ? "globe" : "plus-small"} size="small" />
          <span class="truncate max-w-48">
            {tab.startsWith("browser:")
              ? item()?.title || language.t("session.tab.browser")
              : language.t("browser.tabs.new")}
          </span>
          <Show when={item()?.loading}>
            <Show
              when={import.meta.env.VITE_CM_BRAND}
              fallback={<span class="size-2 rounded-full bg-text-weak animate-pulse" />}
            >
              <CMLoading class="size-3.5" />
            </Show>
          </Show>
          <Show when={item()?.agentAccess}>
            <span
              class="size-2 rounded-full bg-text-interactive-base"
              role="img"
              aria-label={language.t("browser.site.agentOn")}
            />
          </Show>
        </div>
      </Tabs.Trigger>
    )
  }
  const browserTabContent = () => (
    <>
      <Show when={browserOpen() && activeTab().startsWith("browser:")}>
        <div role="tabpanel" class="flex flex-col h-full overflow-hidden contain-strict">
          <BrowserPanel sessionKey={sessionKey()} sessionID={params.id!} onTabShortcut={panelShortcut} />
        </div>
      </Show>
      <Show when={activeTab().startsWith("new-tab:")}>
        <div role="tabpanel" class="flex-1 flex flex-col items-center justify-center gap-3">
          <div class="text-14-medium">{language.t("browser.tabs.new")}</div>
          <Show when={platform.browserPanel}>
            <button
              class="text-text-interactive-base"
              onClick={() => {
                const tab = activeTab()
                const sessionID = params.id!
                void platform
                  .browserPanel!.command(sessionID, { op: "new" })
                  .then((next) => {
                    if (params.id !== sessionID) return
                    acceptBrowser(next)
                    const browserTab = `browser:${next.activeID}`
                    tabs().setAll(
                      tabs()
                        .all()
                        .filter((item) => item !== browserTab)
                        .map((item) => (item === tab ? browserTab : item)),
                    )
                    tabs().setActive(browserTab)
                  })
                  .catch(browserFailure)
              }}
            >
              {language.t("session.tab.browser")}
            </button>
          </Show>
          <Show when={props.canReview()}>
            <button
              class="text-text-interactive-base"
              onClick={() => {
                tabs().close(activeTab())
                tabs().setActive("review")
              }}
            >
              {language.t("session.tab.review")}
            </button>
          </Show>
          <button
            class="text-text-interactive-base"
            onClick={() => {
              tabs().close(activeTab())
              openFileBrowser()
            }}
          >
            {language.t("command.file.open")}
          </button>
          <button
            class="text-text-interactive-base"
            onClick={() => {
              tabs().close(activeTab())
              void tabs().open("context")
            }}
          >
            {language.t("session.tab.context")}
          </button>
        </div>
      </Show>
    </>
  )
  const [store, setStore] = createStore({
    activeDraggable: undefined as string | undefined,
  })

  const handleDragStart = (event: unknown) => {
    const id = getDraggableId(event)
    if (!id) return
    setStore("activeDraggable", id)
  }

  const handleDragOver = (event: DragEvent) => {
    const { draggable, droppable } = event
    if (!draggable || !droppable) return

    const currentTabs = tabs().all()
    const toIndex = getTabReorderIndex(currentTabs, draggable.id.toString(), droppable.id.toString())
    if (toIndex === undefined) return
    tabs().move(draggable.id.toString(), toIndex)
  }

  const handleDragEnd = () => {
    setStore("activeDraggable", undefined)
  }

  createEffect(() => {
    if (!file.ready()) return

    setSessionHandoff(sessionKey(), {
      files: tabs()
        .all()
        .reduce<Record<string, SelectedLineRange | null>>((acc, tab) => {
          const path = file.pathFromTab(tab)
          if (!path) return acc

          const selected = file.selectedLines(path)
          acc[path] =
            selected && typeof selected === "object" && "start" in selected && "end" in selected
              ? (selected as SelectedLineRange)
              : null

          return acc
        }, {}),
    })
  })

  return (
    <Show when={isDesktop() && !(settings.general.newLayoutDesigns() && !params.id)}>
      <aside
        id="review-panel"
        data-cm3-region="side-panel"
        aria-label={language.t("session.panel.reviewAndFiles")}
        aria-hidden={!open()}
        inert={!open()}
        class="relative min-w-0 flex overflow-hidden"
        classList={{
          "bg-v2-background-bg-base": settings.general.newLayoutDesigns(),
          "bg-background-base": !settings.general.newLayoutDesigns(),
          "h-full shrink-0": !props.stacked,
          "h-full min-h-0": props.stacked,
          "pointer-events-none": !open(),
          "transition-[width] duration-[240ms] ease-[cubic-bezier(0.22,1,0.36,1)] will-change-[width] motion-reduce:transition-none":
            !props.size.active() && !props.reviewSnap,
          "rounded-[10px] shadow-[var(--v2-elevation-raised)] overflow-hidden": settings.general.newLayoutDesigns(),
          "flex-1": reviewOpen() || browserOpen(),
        }}
        style={{ width: panelWidth() }}
      >
        <Show when={open()}>
          <div
            class="size-full flex"
            classList={{
              "border-l border-border-weaker-base": !settings.general.newLayoutDesigns(),
            }}
          >
            <Show when={reviewOpen() || browserOpen()}>
              <div
                class="relative min-w-0 h-full flex-1 overflow-hidden"
                classList={{
                  "bg-v2-background-bg-base": settings.general.newLayoutDesigns(),
                  "bg-background-base": !settings.general.newLayoutDesigns(),
                }}
              >
                <div
                  class="size-full min-w-0 h-full"
                  classList={{
                    "bg-v2-background-bg-base": settings.general.newLayoutDesigns(),
                    "bg-background-base": !settings.general.newLayoutDesigns(),
                  }}
                >
                  <Show
                    when={props.fileBrowserState}
                    fallback={
                      <DragDropProvider
                        onDragStart={handleDragStart}
                        onDragEnd={handleDragEnd}
                        onDragOver={handleDragOver}
                        collisionDetector={closestCenter}
                      >
                        <DragDropSensors />
                        <ConstrainDragYAxis />
                        <Tabs value={activeTab()} onChange={activateTab}>
                          <SessionSidePanelTabs mount={props.tabsMount}>
                            <div class="sticky top-0 shrink-0 flex">
                              <Tabs.List
                                ref={(el: HTMLDivElement) => {
                                  const stop = createFileTabListSync({ el, contextOpen })
                                  onCleanup(stop)
                                }}
                              >
                                <Show when={reviewTab() && props.canReview()}>
                                  <Tabs.Trigger
                                    value="review"
                                    id={reviewTabID}
                                    aria-controls={activeTab() === "review" ? reviewTabPanelID : undefined}
                                  >
                                    <div class="flex items-center gap-1.5">
                                      <div>{language.t("session.tab.review")}</div>
                                      <Show when={props.hasReview()}>
                                        <div>{props.reviewCount()}</div>
                                      </Show>
                                    </div>
                                  </Tabs.Trigger>
                                </Show>
                                <Show when={contextOpen()}>
                                  <Tabs.Trigger
                                    value="context"
                                    closeButton={
                                      <TooltipKeybind
                                        title={language.t("common.closeTab")}
                                        keybind={command.keybind("tab.close")}
                                        placement="bottom"
                                        gutter={10}
                                      >
                                        <IconButton
                                          icon="close-small"
                                          variant="ghost"
                                          class="h-5 w-5"
                                          onClick={() => tabs().close("context")}
                                          aria-label={language.t("common.closeTab")}
                                        />
                                      </TooltipKeybind>
                                    }
                                    hideCloseButton
                                    onMiddleClick={() => tabs().close("context")}
                                  >
                                    <div class="flex items-center gap-2">
                                      <SessionContextUsage variant="indicator" />
                                      <div>{language.t("session.tab.context")}</div>
                                    </div>
                                  </Tabs.Trigger>
                                </Show>
                                <For
                                  each={panelTabs().filter(
                                    (tab) => tab.startsWith("browser:") || tab.startsWith("new-tab:"),
                                  )}
                                >
                                  {specialTabTrigger}
                                </For>
                                <SortableProvider ids={openedTabs()}>
                                  <For
                                    each={panelTabs().filter(
                                      (tab) => !tab.startsWith("browser:") && !tab.startsWith("new-tab:"),
                                    )}
                                  >
                                    {(tab) => (
                                      <Show
                                        when={tab === SESSION_OPEN_FILE_TAB}
                                        fallback={
                                          <SortableTab
                                            tab={tab}
                                            temporary={temporaryTab() === tab}
                                            onTabClose={tabs().close}
                                            onTabDoubleClick={temporaryTab() === tab ? openTab : undefined}
                                          />
                                        }
                                      >
                                        <Tabs.Trigger
                                          value={SESSION_OPEN_FILE_TAB}
                                          closeButton={
                                            <TooltipKeybind
                                              title={language.t("common.closeTab")}
                                              keybind={command.keybind("tab.close")}
                                              placement="bottom"
                                              gutter={10}
                                            >
                                              <IconButton
                                                icon="close-small"
                                                variant="ghost"
                                                class="h-5 w-5"
                                                onClick={() => tabs().close(SESSION_OPEN_FILE_TAB)}
                                                aria-label={language.t("common.closeTab")}
                                              />
                                            </TooltipKeybind>
                                          }
                                          hideCloseButton
                                          onMiddleClick={() => tabs().close(SESSION_OPEN_FILE_TAB)}
                                        >
                                          <div class="flex items-center gap-1.5 italic">
                                            <Icon name="open-file" size="small" />
                                            <span>{language.t("command.file.open")}</span>
                                          </div>
                                        </Tabs.Trigger>
                                      </Show>
                                    )}
                                  </For>
                                </SortableProvider>
                                <div
                                  class="h-full shrink-0 sticky right-0 z-10 flex items-center justify-center pr-3"
                                  classList={{
                                    "bg-v2-background-bg-base": settings.general.newLayoutDesigns(),
                                    "bg-background-stronger": !settings.general.newLayoutDesigns(),
                                  }}
                                >
                                  <TooltipKeybind
                                    title={language.t("browser.tabs.new")}
                                    keybind={command.keybind("tab.new")}
                                    class="flex items-center"
                                  >
                                    <IconButton
                                      icon="plus-small"
                                      variant="ghost"
                                      iconSize="large"
                                      class="!rounded-md"
                                      onClick={newTab}
                                      aria-label={language.t("browser.tabs.new")}
                                    />
                                  </TooltipKeybind>
                                </div>
                              </Tabs.List>
                            </div>
                          </SessionSidePanelTabs>
                          <Show when={reviewTab() && props.canReview() && activeTab() === "review"}>
                            <div
                              id={reviewTabPanelID}
                              role="tabpanel"
                              aria-labelledby={reviewTabID}
                              tabIndex={props.reviewHasFocusableContent() ? undefined : 0}
                              data-slot="tabs-content"
                              class="flex flex-col h-full overflow-hidden contain-strict"
                            >
                              {props.reviewPanel()}
                            </div>
                          </Show>

                          <Show when={activeTab() === "empty"}>
                            <Tabs.Content value="empty" class="flex flex-col h-full overflow-hidden contain-strict">
                              <div class="relative pt-2 flex-1 min-h-0 overflow-hidden">
                                <div class="h-full px-6 pb-42 -mt-4 flex flex-col items-center justify-center text-center gap-6">
                                  <Mark class="w-14 opacity-10" />
                                  <div class="text-14-regular text-text-weak max-w-56">
                                    {language.t("session.files.selectToOpen")}
                                  </div>
                                </div>
                              </div>
                            </Tabs.Content>
                          </Show>

                          <Show when={activeTab() === "context"}>
                            <Tabs.Content value="context" class="flex flex-col h-full overflow-hidden contain-strict">
                              <div class="relative pt-2 flex-1 min-h-0 overflow-hidden">
                                <SessionContextTab />
                              </div>
                            </Tabs.Content>
                          </Show>

                          {browserTabContent()}

                          <Show when={activeFileTab()} keyed>
                            {(tab) => <FileTabContent tab={tab} />}
                          </Show>
                        </Tabs>
                        <DragOverlay>
                          <Show when={store.activeDraggable} keyed>
                            {(tab) => {
                              const path = file.pathFromTab(tab)
                              return (
                                <div data-component="tabs-drag-preview">
                                  <Show when={path}>
                                    {(p) => <FileVisual active path={p()} temporary={temporaryTab() === tab} />}
                                  </Show>
                                </div>
                              )
                            }}
                          </Show>
                        </DragOverlay>
                      </DragDropProvider>
                    }
                  >
                    <DndKitProvider
                      sensors={[
                        PointerSensor.configure({
                          activationConstraints: [new PointerActivationConstraints.Distance({ value: 4 })],
                          preventActivation: (event) =>
                            event.target instanceof Element &&
                            (!!event.target.closest('[data-slot="tabs-trigger-close-button"]') ||
                              !!event.target.closest(".session-review-v2-open-in-app-slot")),
                        }),
                      ]}
                      modifiers={[
                        RestrictToHorizontalAxis,
                        RestrictToElement.configure({ element: () => tabList ?? null }),
                      ]}
                      plugins={(defaults) => [
                        ...defaults.filter((plugin) => plugin !== Accessibility),
                        AutoScroller.configure({ acceleration: 8, threshold: { x: 0.05, y: 0 } }),
                        Feedback.configure({ dropAnimation: null }),
                      ]}
                      onDragEnd={(event) => {
                        const source = event.operation.source
                        if (event.canceled || !isSortable(source) || source.initialIndex === source.index) return
                        tabs().move(source.id.toString(), source.index)
                      }}
                    >
                      <Tabs value={activeTab()} onChange={activateTab}>
                        <SessionSidePanelTabs mount={props.tabsMount}>
                          <div class="session-review-v2-tabs-bar sticky top-0 shrink-0 flex items-center">
                            <Tabs.List
                              ref={(el: HTMLDivElement) => {
                                tabList = el
                                const stop = createFileTabListSync({ el, contextOpen })
                                onCleanup(stop)
                              }}
                            >
                              <Show when={props.reviewSidebarToggle}>
                                {(toggle) => (
                                  <div class="session-review-v2-sidebar-toggle-slot h-full shrink-0 sticky left-0 z-10 flex items-center justify-center bg-v2-background-bg-base">
                                    {toggle()(activeTab() === SESSION_OPEN_FILE_TAB)}
                                  </div>
                                )}
                              </Show>
                              <Show when={reviewTab() && props.canReview()}>
                                <Tabs.Trigger
                                  value="review"
                                  id={reviewTabID}
                                  aria-controls={activeTab() === "review" ? reviewTabPanelID : undefined}
                                >
                                  {props.hasReview()
                                    ? language.t("session.review.filesChanged", { count: props.reviewCount() })
                                    : language.t("session.tab.review")}
                                </Tabs.Trigger>
                              </Show>
                              <Show when={contextOpen()}>
                                <Tabs.Trigger
                                  value="context"
                                  closeButton={
                                    <TooltipV2
                                      value={
                                        <>
                                          {language.t("common.closeTab")}
                                          <Show when={closeTabKeybind().length > 0}>
                                            <KeybindV2 keys={closeTabKeybind()} variant="neutral" />
                                          </Show>
                                        </>
                                      }
                                      placement="bottom"
                                      gutter={10}
                                    >
                                      <IconButton
                                        icon="close-small"
                                        variant="ghost"
                                        class="h-5 w-5"
                                        onClick={() => tabs().close("context")}
                                        aria-label={language.t("common.closeTab")}
                                      />
                                    </TooltipV2>
                                  }
                                  hideCloseButton
                                  onMiddleClick={() => tabs().close("context")}
                                >
                                  <div class="flex items-center gap-2">
                                    <SessionContextUsage variant="indicator" />
                                    <div>{language.t("session.tab.context")}</div>
                                  </div>
                                </Tabs.Trigger>
                              </Show>
                              <For
                                each={panelTabs().filter(
                                  (tab) => tab.startsWith("browser:") || tab.startsWith("new-tab:"),
                                )}
                              >
                                {specialTabTrigger}
                              </For>
                              <For
                                each={panelTabs().filter(
                                  (tab) => !tab.startsWith("browser:") && !tab.startsWith("new-tab:"),
                                )}
                              >
                                {(tab) => (
                                  <Show
                                    when={tab === SESSION_OPEN_FILE_TAB}
                                    fallback={
                                      <SortableTabV2
                                        tab={tab}
                                        index={() => tabs().all().indexOf(tab)}
                                        temporary={temporaryTab() === tab}
                                        onTabClose={tabs().close}
                                        onTabDoubleClick={temporaryTab() === tab ? openTab : undefined}
                                      />
                                    }
                                  >
                                    <Tabs.Trigger
                                      value={SESSION_OPEN_FILE_TAB}
                                      closeButton={
                                        <TooltipV2
                                          value={
                                            <>
                                              {language.t("common.closeTab")}
                                              <Show when={closeTabKeybind().length > 0}>
                                                <KeybindV2 keys={closeTabKeybind()} variant="neutral" />
                                              </Show>
                                            </>
                                          }
                                          placement="bottom"
                                          gutter={10}
                                        >
                                          <IconButton
                                            icon="close-small"
                                            variant="ghost"
                                            class="h-5 w-5"
                                            onClick={() => tabs().close(SESSION_OPEN_FILE_TAB)}
                                            aria-label={language.t("common.closeTab")}
                                          />
                                        </TooltipV2>
                                      }
                                      hideCloseButton
                                      onMiddleClick={() => tabs().close(SESSION_OPEN_FILE_TAB)}
                                    >
                                      <div class="flex items-center gap-1.5 italic">
                                        <Icon name="open-file" size="small" />
                                        <span>{language.t("command.file.open")}</span>
                                      </div>
                                    </Tabs.Trigger>
                                  </Show>
                                )}
                              </For>
                              <div
                                class="h-full shrink-0 sticky right-0 z-10 flex items-center justify-center"
                                classList={{
                                  "bg-v2-background-bg-base": settings.general.newLayoutDesigns(),
                                  "bg-background-stronger": !settings.general.newLayoutDesigns(),
                                }}
                              >
                                <TooltipV2
                                  value={<>{language.t("browser.tabs.new")}</>}
                                  placement="bottom"
                                  class="flex items-center"
                                >
                                  <IconButtonV2
                                    icon={<Icon name="plus-small" />}
                                    variant="ghost-muted"
                                    size="large"
                                    onClick={newTab}
                                    aria-label={language.t("browser.tabs.new")}
                                  />
                                </TooltipV2>
                              </div>
                            </Tabs.List>
                            <div
                              class="session-review-v2-open-in-app-slot shrink-0 flex items-center pr-3"
                              onPointerDown={(event) => event.stopPropagation()}
                              onClick={(event) => event.stopPropagation()}
                            >
                              <OpenInAppV2 directory={projectDirectory} />
                            </div>
                          </div>
                        </SessionSidePanelTabs>

                        <Show when={reviewTab() && props.canReview() && activeTab() === "review"}>
                          <div
                            id={reviewTabPanelID}
                            role="tabpanel"
                            aria-labelledby={reviewTabID}
                            tabIndex={props.reviewHasFocusableContent() ? undefined : 0}
                            data-slot="tabs-content"
                            class="flex flex-col h-full overflow-hidden contain-strict"
                          >
                            {props.reviewPanel()}
                          </div>
                        </Show>

                        <Show when={activeTab() === "empty"}>
                          <Tabs.Content value="empty" class="flex flex-col h-full overflow-hidden contain-strict">
                            <div class="relative pt-2 flex-1 min-h-0 overflow-hidden">
                              <div class="h-full px-6 pb-42 -mt-4 flex flex-col items-center justify-center text-center gap-6">
                                <Mark class="w-14 opacity-10" />
                                <div class="text-14-regular text-text-weak max-w-56">
                                  {language.t("session.files.selectToOpen")}
                                </div>
                              </div>
                            </div>
                          </Tabs.Content>
                        </Show>

                        <Show when={activeTab() === "context"}>
                          <Tabs.Content value="context" class="flex flex-col h-full overflow-hidden contain-strict">
                            <div class="relative pt-2 flex-1 min-h-0 overflow-hidden">
                              <SessionContextTab />
                            </div>
                          </Tabs.Content>
                        </Show>

                        {browserTabContent()}

                        <Show when={fileBrowserMounted()}>
                          <div
                            id={fileBrowserTabPanelID}
                            role="tabpanel"
                            data-slot="tabs-content"
                            class="h-full min-h-0 overflow-hidden"
                            classList={{ hidden: !fileBrowserVisible() }}
                            inert={!fileBrowserVisible() || undefined}
                          >
                            <SessionFileBrowserTab
                              tab={browserTab() ?? activeFileTab() ?? SESSION_OPEN_FILE_TAB}
                              placeholder={
                                (browserTab() ?? activeFileTab() ?? SESSION_OPEN_FILE_TAB) === SESSION_OPEN_FILE_TAB
                              }
                              active={file.pathFromTab(browserTab() ?? activeFileTab() ?? "")}
                              kinds={kinds()}
                              state={props.fileBrowserState!}
                              onSelect={(path) => previewTab(file.tab(path))}
                              onSelectPermanent={(path) => openTab(file.tab(path))}
                              filterRef={(element) => (fileFilter = element)}
                            />
                          </div>
                        </Show>
                      </Tabs>
                    </DndKitProvider>
                  </Show>
                </div>
              </div>
            </Show>

            <Show when={fileOpen()}>
              <div
                id="file-tree-panel"
                class="relative min-w-0 h-full shrink-0 overflow-hidden"
                classList={{
                  "transition-[width] duration-200 ease-[cubic-bezier(0.22,1,0.36,1)] will-change-[width] motion-reduce:transition-none":
                    !props.size.active(),
                }}
                style={{ width: treeWidth() }}
              >
                <div
                  class="h-full flex flex-col overflow-hidden group/filetree"
                  classList={{ "border-l border-border-weaker-base": reviewOpen() || browserOpen() }}
                >
                  <Tabs
                    variant="pill"
                    value={fileTreeTab()}
                    onChange={setFileTreeTabValue}
                    class="h-full"
                    data-scope="filetree"
                  >
                    <Tabs.List>
                      <Tabs.Trigger value="changes" class="flex-1" classes={{ button: "w-full" }}>
                        <Show
                          when={settings.general.newLayoutDesigns()}
                          fallback={
                            <>
                              {props.reviewCount()}{" "}
                              {language.t(
                                props.reviewCount() === 1 ? "session.review.change.one" : "session.review.change.other",
                              )}
                            </>
                          }
                        >
                          {language.t("session.review.filesChanged", { count: props.reviewCount() })}
                        </Show>
                      </Tabs.Trigger>
                      <Tabs.Trigger value="all" class="flex-1" classes={{ button: "w-full" }}>
                        {language.t("session.files.all")}
                      </Tabs.Trigger>
                    </Tabs.List>
                    <Show when={fileTreeTab() === "changes"}>
                      <Tabs.Content value="changes" class="bg-background-stronger px-3 py-0">
                        <Switch>
                          <Match when={props.hasReview() || !props.diffsReady()}>
                            <Show
                              when={props.diffsReady()}
                              fallback={
                                <div class="px-2 py-2 text-12-regular text-text-weak">
                                  <CMLoading class="size-4 inline-block align-middle mr-2" />
                                  {language.t("common.loading")}
                                  {language.t("common.loading.ellipsis")}
                                </div>
                              }
                            >
                              <FileTree
                                path=""
                                class="pt-3"
                                allowed={diffFiles()}
                                kinds={kinds()}
                                draggable={false}
                                active={props.activeDiff}
                                onFileClick={(node) => props.focusReviewDiff(node.path)}
                              />
                            </Show>
                          </Match>
                        </Switch>
                      </Tabs.Content>
                    </Show>
                    <Show when={fileTreeTab() === "all"}>
                      <Tabs.Content value="all" class="bg-background-stronger px-3 py-0">
                        <Switch>
                          <Match when={nofiles()}>{empty(language.t("session.files.empty"))}</Match>
                          <Match when={true}>
                            <FileTree
                              path=""
                              class="pt-3"
                              modified={diffFiles()}
                              kinds={kinds()}
                              onFileClick={(node) => openTab(file.tab(node.path))}
                            />
                          </Match>
                        </Switch>
                      </Tabs.Content>
                    </Show>
                  </Tabs>
                </div>
                <Show when={fileOpen()}>
                  <div onPointerDown={() => props.size.start()}>
                    <ResizeHandle
                      direction="horizontal"
                      edge="start"
                      size={fileTreeWidth()}
                      min={FILE_TREE_WIDTH_MIN}
                      max={480}
                      onResize={(width) => {
                        props.size.touch()
                        layout.fileTree.resize(width)
                      }}
                    />
                  </div>
                </Show>
              </div>
            </Show>
          </div>
        </Show>
      </aside>
    </Show>
  )
}

function SessionSidePanelTabs(props: { mount?: HTMLDivElement; children: JSX.Element }) {
  const [local, setLocal] = createStore({ mount: undefined as HTMLDivElement | undefined })
  return (
    <>
      <div ref={(mount) => setLocal("mount", mount)} class="shrink-0" />
      {/* Portal keeps the triggers under the original Tabs/DnD owners while only moving their DOM. */}
      <Portal
        mount={props.mount ?? local.mount}
        ref={(container) => {
          container.dataset.component = "tabs"
          container.dataset.variant = "normal"
          container.dataset.orientation = "horizontal"
          container.className = "session-side-panel-tabs"
        }}
      >
        {props.children}
      </Portal>
    </>
  )
}
