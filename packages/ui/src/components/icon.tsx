import { onMount, splitProps, type ComponentProps } from "solid-js"

import { icons } from "./phosphor"

const spriteID = "opencode-icon-sprite"
const symbol = (name: keyof typeof icons) => `opencode-icon-${name}`
let spriteInserted = false

function ensureSprite() {
  if (spriteInserted) return
  if (typeof document === "undefined") return
  if (document.getElementById(spriteID)) {
    spriteInserted = true
    return
  }
  const body = document.body as HTMLElement | null
  if (!body) return

  const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg")
  svg.id = spriteID
  svg.setAttribute("aria-hidden", "true")
  svg.setAttribute("width", "0")
  svg.setAttribute("height", "0")
  svg.style.position = "absolute"
  svg.style.overflow = "hidden"
  svg.innerHTML = Object.entries(icons)
    .map(([name, path]) => {
      const key = name as keyof typeof icons
      return `<symbol id="${symbol(key)}" viewBox="0 0 256 256"><path d="${path}" fill="currentColor"${name === "sidebar-right" || name.startsWith("layout-right") ? ' transform="translate(256 0) scale(-1 1)"' : ""}/></symbol>`
    })
    .join("")
  body.insertBefore(svg, body.firstChild)
  spriteInserted = true
}

export interface IconProps extends ComponentProps<"svg"> {
  name: keyof typeof icons
  size?: "small" | "normal" | "medium" | "large"
}

export function Icon(props: IconProps) {
  const [local, others] = splitProps(props, ["name", "size", "class", "classList"])
  onMount(ensureSprite)

  return (
    <div
      data-component="icon"
      data-size={local.size || "normal"}
      data-directional={
        local.name === "arrow-left" ||
        local.name === "arrow-right" ||
        local.name === "chevron-left" ||
        local.name === "chevron-right"
          ? true
          : undefined
      }
    >
      <svg
        data-slot="icon-svg"
        data-active={local.name.endsWith("-active") || local.name === "star-filled" ? true : undefined}
        classList={{
          ...local.classList,
          [local.class ?? ""]: !!local.class,
        }}
        fill="none"
        viewBox="0 0 256 256"
        aria-hidden="true"
        {...others}
      >
        <use href={`#${symbol(local.name)}`} />
      </svg>
    </div>
  )
}
