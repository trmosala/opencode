import { onMount, Show, type ComponentProps, splitProps } from "solid-js"
import { Loading, useLoadingAnimations } from "../../components/loading"

import { icons } from "../../components/phosphor"

const spriteID = "opencode-v2-icon-sprite"
const symbol = (name: keyof typeof icons) => `opencode-v2-icon-${name}`
let spriteInserted = false

function ensureSprite() {
  if (spriteInserted) return
  if (typeof document === "undefined") return
  if (document.getElementById(spriteID)) {
    spriteInserted = true
    return
  }

  const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg")
  svg.id = spriteID
  svg.setAttribute("aria-hidden", "true")
  svg.setAttribute("width", "0")
  svg.setAttribute("height", "0")
  svg.style.position = "absolute"
  svg.style.overflow = "hidden"
  svg.innerHTML = Object.entries(icons)
    .map(
      ([name, icon]) =>
        `<symbol id="${symbol(name as keyof typeof icons)}" viewBox="0 0 256 256"><path d="${icon}" fill="currentColor"${name === "sidebar-right" || name.startsWith("layout-right") ? ' transform="translate(256 0) scale(-1 1)"' : ""}/></symbol>`,
    )
    .join("")
  document.body.insertBefore(svg, document.body.firstChild)
  spriteInserted = true
}

export interface IconProps extends ComponentProps<"svg"> {
  name: keyof typeof icons | (string & {})
  size?: "small" | "normal" | "large"
}

export function Icon(props: IconProps) {
  const loading = useLoadingAnimations()
  const [split, rest] = splitProps(props, ["name", "size"])
  const iconName = () => (icons[split.name as keyof typeof icons] ? (split.name as keyof typeof icons) : "plus")
  const pixelSize = split.size === "small" ? 14 : split.size === "large" ? 20 : 16
  onMount(ensureSprite)

  return (
    <Show
      when={split.name === "spinner" && loading}
      fallback={
        <svg
          {...rest}
          data-slot="icon-svg"
          data-active={split.name.endsWith("-active") || split.name === "star-filled" ? true : undefined}
          width={pixelSize}
          height={pixelSize}
          viewBox="0 0 256 256"
          fill="none"
          xmlns="http://www.w3.org/2000/svg"
          aria-hidden={rest["aria-hidden"] ?? "true"}
        >
          <use href={`#${symbol(iconName())}`} />
        </svg>
      }
    >
      <Loading {...rest} data-component="icon-loading" data-slot="icon-svg" width={pixelSize} height={pixelSize} />
    </Show>
  )
}
