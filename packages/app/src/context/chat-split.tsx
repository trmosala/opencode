import { createContext, createEffect, onCleanup, useContext, type Accessor } from "solid-js"
import { createStore } from "solid-js/store"
import { createSimpleContext } from "@opencode-ai/ui/context"
import { Persist, persisted } from "@/utils/persist"

export const ChatPaneContext = createContext<Accessor<boolean>>()
export const useChatPaneActive = () => useContext(ChatPaneContext)

export const { use: useChatSplit, provider: ChatSplitProvider } = createSimpleContext({
  name: "ChatSplit",
  gate: false,
  init: () => {
    const [store, setStore] = persisted(Persist.window("chat-split"), createStore({ href: "", fraction: 0.5 }))
    const [state, setState] = createStore({
      active: "primary" as "primary" | "secondary",
      drag: "",
      available: false,
      over: false,
    })
    const close = () => {
      setState("active", "primary")
      setStore("href", "")
    }
    createEffect(() => {
      if (!store.href) setState("active", "primary")
    })
    const endDrag = () => setState({ drag: "", over: false })
    const cancel = (event: KeyboardEvent) => {
      if (event.key === "Escape") endDrag()
    }
    document.addEventListener("keydown", cancel)
    onCleanup(() => document.removeEventListener("keydown", cancel))
    return {
      store,
      path: () => store.href.split("#")[0],
      state,
      close,
      focus: (pane: "primary" | "secondary") => setState("active", pane),
      open: (href: string) => {
        setStore("href", href)
        setState("active", "secondary")
      },
      navigate: (href: string) => setStore("href", href),
      resize: (fraction: number) => setStore("fraction", Math.max(0.25, Math.min(0.75, fraction))),
      startDrag: (href: string) => setState({ drag: href, over: false }),
      setAvailable: (available: boolean) => setState("available", available),
      hover: (over: boolean) => setState("over", over),
      endDrag,
    }
  },
})
