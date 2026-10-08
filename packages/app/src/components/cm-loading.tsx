import spin from "../assets/cm-loading/spin.svg?no-inline"
import bounce from "../assets/cm-loading/bounce.svg?no-inline"
import chompRebuild from "../assets/cm-loading/chomp-rebuild.svg?no-inline"
import pixelRebuild from "../assets/cm-loading/pixel-rebuild.svg?no-inline"
import assemble from "../assets/cm-loading/assemble.svg?no-inline"
import flip3D from "../assets/cm-loading/flip-3d.svg?no-inline"
import still from "../assets/cm-loading/still.svg?no-inline"
import type { LoadingAnimationSet } from "@opencode-ai/ui/loading"
import { Spinner } from "@opencode-ai/ui/spinner"
import { Show, type ComponentProps } from "solid-js"

export const cmLoading = {
  animations: [
    { id: "spin", src: spin },
    { id: "bounce", src: bounce },
    { id: "chomp-rebuild", src: chompRebuild },
    { id: "pixel-rebuild", src: pixelRebuild },
    { id: "assemble", src: assemble },
    { id: "flip-3d", src: flip3D },
  ],
  still,
} satisfies LoadingAnimationSet

export function CMLoading(props: ComponentProps<typeof Spinner>) {
  return (
    <Show when={import.meta.env.VITE_CM_BRAND}>
      <Spinner {...props} />
    </Show>
  )
}
