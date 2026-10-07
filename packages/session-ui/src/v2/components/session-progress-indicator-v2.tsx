import { paths } from "@opencode-ai/ui/phosphor"
import { splitProps, type ComponentProps } from "solid-js"
import "./session-progress-indicator-v2.css"

export function SessionProgressIndicatorV2(props: ComponentProps<"svg">) {
  const [local, rest] = splitProps(props, ["class", "classList", "width", "height"])
  return (
    <svg
      {...rest}
      class={local.class}
      classList={local.classList}
      width={local.width ?? 16}
      height={local.height ?? 16}
      viewBox="0 0 256 256"
      fill="currentColor"
      xmlns="http://www.w3.org/2000/svg"
      data-component="session-progress-indicator-v2"
      aria-hidden={rest["aria-hidden"] ?? "true"}
    >
      <path d={paths.spinner} />
    </svg>
  )
}
