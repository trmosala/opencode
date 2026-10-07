import { paths, type IconName } from "./cm3-icons/paths"

export function Cm3Icon(props: { name: IconName; size?: number }) {
  return (
    <svg
      data-component="cm3-icon"
      data-cm3-icon={props.name}
      xmlns="http://www.w3.org/2000/svg"
      viewBox="0 0 256 256"
      width={props.size ?? 16}
      height={props.size ?? 16}
      fill="currentColor"
      aria-hidden="true"
      ref={(element) => element.setAttribute("focusable", "false")}
    >
      <path d={paths[props.name]} />
    </svg>
  )
}
