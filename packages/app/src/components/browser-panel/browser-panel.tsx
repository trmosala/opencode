import { Button } from "@opencode-ai/ui/button"
import { Icon } from "@opencode-ai/ui/icon"
import { IconButton } from "@opencode-ai/ui/icon-button"
import { Tooltip } from "@opencode-ai/ui/tooltip"
import { createEffect, createMemo, createSignal, onCleanup, Show } from "solid-js"
import { createStore } from "solid-js/store"
import { useLanguage } from "@/context/language"
import { usePrompt } from "@/context/prompt"
import { Persist, persisted } from "@/utils/persist"
import { showToast } from "@/utils/toast"
import {
  formatBrowserElementContext,
  formatBrowserSelectionContext,
  formatBrowserUrlContext,
  normalizeBrowserUrl,
} from "./browser-context"
import {
  type WebviewElement,
  addImage,
  appendText,
  captureScreenshot,
  navigate,
  pickElement,
  readSelectionText,
} from "./browser-actions"

type BrowserStore = {
  url: string
}

declare module "solid-js" {
  namespace JSX {
    interface IntrinsicElements {
      webview: JSX.HTMLAttributes<HTMLElement> & {
        src?: string
        allowpopups?: boolean
        webpreferences?: string
      }
    }
  }
}

export function BrowserPanel(props: { sessionKey: string }) {
  const language = useLanguage()
  const prompt = usePrompt()
  const [store, setStore] = persisted(
    Persist.global(`browser-panel:${props.sessionKey}`),
    createStore<BrowserStore>({ url: "http://localhost:5173/" }),
  )
  const [input, setInput] = createSignal(store.url)
  const [state, setState] = createStore({
    title: "",
    url: store.url,
    loading: false,
    canGoBack: false,
    canGoForward: false,
    selecting: false,
  })

  let webview: WebviewElement | undefined

  const page = createMemo(() => ({
    title: state.title,
    url: state.url,
  }))

  createEffect(() => {
    setInput(store.url)
    setState("url", store.url)
  })

  const toastInvalidUrl = () => {
    showToast({
      variant: "error",
      title: language.t("browser.toast.invalidUrl.title"),
      description: language.t("browser.toast.invalidUrl.description"),
    })
  }

  const syncState = () => {
    if (!webview) return
    const nextUrl = webview.getURL?.() || webview.src || state.url
    const nextTitle = webview.getTitle?.() || ""
    setState({
      url: nextUrl,
      title: nextTitle,
      canGoBack: webview.canGoBack?.() ?? false,
      canGoForward: webview.canGoForward?.() ?? false,
    })
    setInput(nextUrl)
    setStore("url", nextUrl)
  }

  const go = () => {
    const url = normalizeBrowserUrl(input())
    if (!url) {
      toastInvalidUrl()
      return
    }
    setStore("url", url)
    setState("url", url)
    if (webview) webview.src = url
  }

  const addUrl = () => {
    appendText(prompt, formatBrowserUrlContext(page()))
  }

  const addSelection = async () => {
    if (!webview?.executeJavaScript || state.selecting) return

    const selection = await readSelectionText(webview)
    const text = formatBrowserSelectionContext(page(), selection)
    if (text) {
      appendText(prompt, text)
      return
    }

    setState("selecting", true)
    showToast({
      title: language.t("browser.toast.selectionMode.title"),
      description: language.t("browser.toast.selectionMode.description"),
    })
    const picked = await pickElement(webview)
    setState("selecting", false)
    const elementText = formatBrowserElementContext(page(), picked)
    if (!elementText) {
      showToast({
        title: language.t("browser.toast.emptySelection.title"),
        description: language.t("browser.toast.emptySelection.description"),
      })
      return
    }
    appendText(prompt, elementText)
  }

  const addScreenshot = async () => {
    const part = await captureScreenshot(webview)
    if (!part) {
      showToast({
        variant: "error",
        title: language.t("browser.toast.screenshotFailed.title"),
      })
      return
    }
    addImage(prompt, part)
  }

  const wire = (el: HTMLElement) => {
    const view = el as WebviewElement
    webview = view
    const start = () => setState("loading", true)
    const guard = (event: Event) => {
      const url = (event as Event & { url?: string }).url
      if (!url) return
      if (normalizeBrowserUrl(url)) return
      event.preventDefault()
      toastInvalidUrl()
    }
    const stop = () => {
      setState("loading", false)
      syncState()
    }
    view.addEventListener("did-start-loading", start)
    view.addEventListener("will-navigate", guard)
    view.addEventListener("did-stop-loading", stop)
    view.addEventListener("did-navigate", syncState)
    view.addEventListener("did-navigate-in-page", syncState)
    view.addEventListener("page-title-updated", syncState)
    onCleanup(() => {
      view.removeEventListener("did-start-loading", start)
      view.removeEventListener("will-navigate", guard)
      view.removeEventListener("did-stop-loading", stop)
      view.removeEventListener("did-navigate", syncState)
      view.removeEventListener("did-navigate-in-page", syncState)
      view.removeEventListener("page-title-updated", syncState)
      webview = undefined
    })
  }

  return (
    <div class="size-full flex flex-col overflow-hidden bg-background-base">
      <form
        class="shrink-0 flex items-center gap-1 border-b border-border-weaker-base bg-background-stronger px-2 py-2"
        onSubmit={(event) => {
          event.preventDefault()
          go()
        }}
      >
        <Tooltip value={language.t("browser.action.back")}>
          <IconButton
            type="button"
            icon="arrow-left"
            variant="ghost"
            class="h-7 w-7"
            disabled={!state.canGoBack}
            onClick={() => navigate(webview, "back")}
            aria-label={language.t("browser.action.back")}
          />
        </Tooltip>
        <Tooltip value={language.t("browser.action.forward")}>
          <IconButton
            type="button"
            icon="arrow-right"
            variant="ghost"
            class="h-7 w-7"
            disabled={!state.canGoForward}
            onClick={() => navigate(webview, "forward")}
            aria-label={language.t("browser.action.forward")}
          />
        </Tooltip>
        <Tooltip value={state.loading ? language.t("browser.action.stop") : language.t("browser.action.reload")}>
          <IconButton
            type="button"
            icon={state.loading ? "stop" : "reset"}
            variant="ghost"
            class="h-7 w-7"
            onClick={() => navigate(webview, state.loading ? "stop" : "reload")}
            aria-label={state.loading ? language.t("browser.action.stop") : language.t("browser.action.reload")}
          />
        </Tooltip>
        <input
          class="min-w-0 flex-1 h-7 rounded-md border border-border-weak-base bg-background-base px-2 text-12-regular text-text-base outline-none focus:border-border-strong"
          value={input()}
          onInput={(event) => setInput(event.currentTarget.value)}
          aria-label={language.t("browser.address.label")}
        />
        <Button type="submit" size="small" variant="secondary">
          {language.t("common.open")}
        </Button>
      </form>

      <div class="shrink-0 flex items-center gap-1 border-b border-border-weaker-base bg-background-base px-2 py-1.5">
        <Button type="button" size="small" variant="ghost" onClick={addUrl}>
          <Icon name="link" size="small" />
          {language.t("browser.action.addUrl")}
        </Button>
        <Button
          type="button"
          size="small"
          variant={state.selecting ? "secondary" : "ghost"}
          onClick={() => void addSelection()}
        >
          <Icon name="comment" size="small" />
          {language.t("browser.action.addSelection")}
        </Button>
        <Button type="button" size="small" variant="ghost" onClick={() => void addScreenshot()}>
          <Icon name="photo" size="small" />
          {language.t("browser.action.addScreenshot")}
        </Button>
        <Show when={state.title}>
          <div class="ml-auto min-w-0 truncate text-12-regular text-text-weak">{state.title}</div>
        </Show>
      </div>

      <webview
        ref={wire}
        src={store.url}
        class="min-h-0 flex-1 bg-white"
        allowpopups={false}
        webpreferences="contextIsolation=yes,nodeIntegration=no,sandbox=yes"
      />
    </div>
  )
}
