import { createContext, createUniqueId, Show, useContext, type ComponentProps, type ParentProps } from "solid-js"
import { paths } from "./phosphor"
import "./loading.css"

export type LoadingAnimationSet = {
  animations: readonly { id: string; src: string }[]
  still: string
}

const LoadingContext = createContext<LoadingAnimationSet>()

export function useLoadingAnimations() {
  return useContext(LoadingContext)
}

export function LoadingAnimationProvider(props: ParentProps<{ value?: LoadingAnimationSet }>) {
  return <LoadingContext.Provider value={props.value}>{props.children}</LoadingContext.Provider>
}

export function Loading(props: ComponentProps<"svg"> & { "data-component"?: string }) {
  const loading = useLoadingAnimations()
  // Pick once per mount. Reactive status/colour updates must not restart the animation.
  const animation = loading?.animations[Math.floor(Math.random() * loading.animations.length)]
  const filter = `loading-colour-${createUniqueId()}`

  return (
    <svg
      {...props}
      width={props.width ?? 16}
      height={props.height ?? 16}
      viewBox="0 0 256 256"
      fill="currentColor"
      data-component={props["data-component"] ?? "loading"}
      data-loading-animation={animation?.id}
      aria-hidden={props["aria-hidden"] ?? "true"}
    >
      <Show when={animation} fallback={<path d={paths.spinner} />}>
        <defs>
          <filter id={filter} x="0" y="0" width="100%" height="100%" color-interpolation-filters="sRGB">
            {/* SVG images isolate their animation styles/IDs; tint their alpha with the host's theme token. */}
            <feFlood flood-color="currentColor" result="colour" />
            <feComposite in="colour" in2="SourceAlpha" operator="in" />
          </filter>
        </defs>
        <g filter={`url(#${filter})`}>
          <image data-slot="loading-motion" href={animation?.src} width="256" height="256" />
          <image data-slot="loading-still" href={loading?.still} width="256" height="256" />
        </g>
      </Show>
    </svg>
  )
}
