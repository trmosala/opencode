import type { Component, ComponentProps } from "solid-js"
import { splitProps } from "solid-js"
import type { IconName } from "./app-icons/types"
import { paths } from "./phosphor"

export type AppIconProps = ComponentProps<"svg"> & {
  id: IconName
  alt?: string
}

export const AppIcon: Component<AppIconProps> = (props) => {
  const [local, rest] = splitProps(props, ["id", "class", "classList", "alt"])
  return (
    <svg
      {...rest}
      data-component="app-icon"
      width={rest.width ?? 16}
      height={rest.height ?? 16}
      viewBox="0 0 256 256"
      fill="currentColor"
      role={local.alt ? "img" : undefined}
      aria-label={local.alt || rest["aria-label"]}
      aria-hidden={rest["aria-hidden"] ?? (local.alt ? undefined : "true")}
      classList={{ ...local.classList, [local.class ?? ""]: !!local.class }}
    >
      <path
        d={
          local.id === "finder" || local.id === "file-explorer"
            ? paths.folder
            : ["terminal", "iterm2", "ghostty", "warp", "powershell"].includes(local.id)
              ? paths["terminal-window"]
              : paths.desktop
        }
      />
    </svg>
  )
}
