import { type ComponentProps } from "solid-js"
import { paths } from "./phosphor"

export function Spinner(props: {
  class?: string
  classList?: ComponentProps<"div">["classList"]
  style?: ComponentProps<"div">["style"]
}) {
  return (
    <svg
      {...props}
      viewBox="0 0 256 256"
      data-component="spinner"
      classList={{ ...props.classList, [props.class ?? ""]: !!props.class }}
      fill="currentColor"
      aria-hidden="true"
    >
      <path d={paths.spinner} />
    </svg>
  )
}
