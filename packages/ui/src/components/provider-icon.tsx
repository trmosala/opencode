import type { Component, JSX } from "solid-js"
import { splitProps } from "solid-js"
import { paths } from "./phosphor"

export type ProviderIconProps = JSX.SVGElementTags["svg"] & {
  id: string
}

export const ProviderIcon: Component<ProviderIconProps> = (props) => {
  const [local, rest] = splitProps(props, ["id", "class", "classList"])
  return (
    <svg
      {...rest}
      data-component="provider-icon"
      data-provider={local.id}
      viewBox="0 0 256 256"
      fill="currentColor"
      aria-hidden={rest["aria-hidden"] ?? "true"}
      classList={{ ...local.classList, [local.class ?? ""]: !!local.class }}
    >
      <path d={paths.plugs} />
    </svg>
  )
}
