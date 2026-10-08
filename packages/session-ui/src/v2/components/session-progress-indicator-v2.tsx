import { Loading } from "@opencode-ai/ui/loading"
import { splitProps, type ComponentProps } from "solid-js"
import "./session-progress-indicator-v2.css"

export function SessionProgressIndicatorV2(props: ComponentProps<"svg">) {
  const [local, rest] = splitProps(props, ["class", "classList", "width", "height"])
  return (
    <Loading
      {...rest}
      class={local.class}
      classList={local.classList}
      width={local.width ?? 16}
      height={local.height ?? 16}
      data-component="session-progress-indicator-v2"
      aria-hidden={rest["aria-hidden"] ?? "true"}
    />
  )
}
