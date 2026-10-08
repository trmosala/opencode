import { type ComponentProps } from "solid-js"
import { Loading } from "./loading"

export function Spinner(props: {
  class?: string
  classList?: ComponentProps<"div">["classList"]
  style?: ComponentProps<"div">["style"]
}) {
  return (
    <Loading
      {...props}
      width={18}
      height={18}
      data-component="spinner"
      classList={{ ...props.classList, [props.class ?? ""]: !!props.class }}
      aria-hidden="true"
    />
  )
}
