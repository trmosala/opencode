import {
  createEffect,
  onCleanup,
  onMount,
  Show,
  Suspense,
  ErrorBoundary,
  type Component,
  type ParentProps,
} from "solid-js"
import { createStore } from "solid-js/store"
import { useLocation } from "@solidjs/router"
import { createResizeObserver } from "@solid-primitives/resize-observer"
import { ResizeHandle } from "@opencode-ai/ui/resize-handle"
import { ChatPaneContext, useChatSplit } from "@/context/chat-split"
import { useLanguage } from "@/context/language"
import "./split-workspace.css"

export function SplitWorkspace(props: ParentProps<{ secondary: Component }>) {
  const split = useChatSplit()
  const language = useLanguage()
  const location = useLocation()
  const [size, setSize] = createStore({ width: 0 })
  let root!: HTMLDivElement
  createResizeObserver(
    () => root,
    (rect) => setSize("width", rect.width),
  )
  const wide = () => size.width >= 720
  const visible = () => !!split.store.href && wide()
  const fraction = () => Math.max(360 / size.width, Math.min(1 - 360 / size.width, split.store.fraction))
  const primary = () => !visible() || split.state.active === "primary"
  createEffect(() => {
    split.setAvailable(wide())
    if (split.path() === `${location.pathname}${location.search}`) split.close()
    if (!wide()) split.focus("primary")
  })
  const hover = (event: { clientX: number; clientY: number }) => {
    if (!split.state.drag || !wide()) return
    const rect = root.getBoundingClientRect()
    split.hover(
      event.clientX > rect.left + rect.width * 0.65 &&
        event.clientX < rect.right &&
        event.clientY >= rect.top &&
        event.clientY <= rect.bottom,
    )
  }
  document.addEventListener("pointermove", hover)
  onCleanup(() => document.removeEventListener("pointermove", hover))

  onMount(() => {
    const dragOver = (event: DragEvent) => {
      if (!split.state.drag) return
      event.preventDefault()
      event.stopPropagation()
      hover(event)
    }
    const drop = (event: DragEvent) => {
      if (!split.state.drag) return
      event.preventDefault()
      event.stopPropagation()
      hover(event)
      if (split.state.over) split.open(split.state.drag)
      split.endDrag()
    }
    root.addEventListener("dragenter", dragOver, true)
    root.addEventListener("dragover", dragOver, true)
    root.addEventListener("drop", drop, true)
    onCleanup(() => {
      root.removeEventListener("dragenter", dragOver, true)
      root.removeEventListener("dragover", dragOver, true)
      root.removeEventListener("drop", drop, true)
    })
  })

  return (
    <div ref={root} class="cm-chat-workspace cm3-live-route" data-split={visible()}>
      <main
        class="cm-chat-pane"
        data-chat-pane="primary"
        data-focused={primary()}
        style={{ width: visible() ? `${fraction() * 100}%` : "100%" }}
        onPointerDown={() => split.focus("primary")}
        onFocusIn={() => split.focus("primary")}
      >
        <Show when={visible()}>
          <div class="cm-chat-split-toolbar">
            <span>{language.t("chat.split.first")}</span>
          </div>
        </Show>
        <ChatPaneContext.Provider value={primary}>{props.children}</ChatPaneContext.Provider>
      </main>
      <Show when={visible()}>
        <ResizeHandle
          class="cm-chat-divider"
          direction="horizontal"
          size={size.width * fraction()}
          min={360}
          max={size.width - 360}
          onResize={(width) => split.resize(width / size.width)}
          role="separator"
          tabIndex={0}
          aria-label={language.t("chat.split.resize")}
          aria-orientation="vertical"
          aria-valuemin={25}
          aria-valuemax={75}
          aria-valuenow={Math.round(fraction() * 100)}
          onKeyDown={(event) => {
            if (event.key !== "ArrowLeft" && event.key !== "ArrowRight") return
            event.preventDefault()
            split.resize(
              Math.max(
                360 / size.width,
                Math.min(1 - 360 / size.width, fraction() + (event.key === "ArrowRight" ? 0.05 : -0.05)),
              ),
            )
          }}
        />
        <section
          class="cm-chat-pane cm-chat-secondary"
          data-chat-pane="secondary"
          data-focused={split.state.active === "secondary"}
          aria-label={language.t("chat.split.second")}
          onPointerDown={() => split.focus("secondary")}
          onFocusIn={() => split.focus("secondary")}
          onClick={(event) => {
            if (
              event.defaultPrevented ||
              event.button !== 0 ||
              event.metaKey ||
              event.ctrlKey ||
              event.shiftKey ||
              event.altKey
            )
              return
            const link = event.target.closest("a")
            if (!link || link.target || link.hasAttribute("download") || link.rel.includes("external")) return
            const url = new URL(link.href)
            if (url.origin !== window.location.origin || !/^\/(server\/|new-session)/.test(url.pathname)) return
            event.preventDefault()
            split.navigate(`${url.pathname}${url.search}${url.hash}`)
          }}
        >
          <div class="cm-chat-split-toolbar">
            <span>{language.t("chat.split.second")}</span>
            <button type="button" onClick={split.close}>
              {language.t("chat.split.close")}
            </button>
          </div>
          <ChatPaneContext.Provider value={() => split.state.active === "secondary"}>
            <ErrorBoundary
              fallback={
                <p role="alert" class="p-4">
                  {language.t("common.requestFailed")}
                </p>
              }
            >
              <Suspense
                fallback={
                  <p role="status" class="p-4">
                    {language.t("common.loading")}
                  </p>
                }
              >
                <props.secondary />
              </Suspense>
            </ErrorBoundary>
          </ChatPaneContext.Provider>
        </section>
      </Show>
      <Show when={split.state.drag && wide()}>
        <div class="cm-chat-drop" data-over={split.state.over} aria-hidden="true">
          {language.t("chat.split.drop")}
        </div>
      </Show>
    </div>
  )
}
