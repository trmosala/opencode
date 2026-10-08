import { paths } from "../../components/phosphor"
import { splitProps, type ComponentProps } from "solid-js"
import "./loader-v2.css"

export function LoaderV2(props: ComponentProps<"svg">) {
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
      data-component="loader-v2"
      aria-hidden={rest["aria-hidden"] ?? "true"}
    >
      <path d={paths["spinner"]} />
    </svg>
  )
}
