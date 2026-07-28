import { Show, type JSX } from "solid-js"
import { WordmarkV2 } from "@opencode-ai/ui/v2/wordmark-v2"
import { NEW_SESSION_CONTENT_WIDTH } from "@/pages/session/new-session-layout"
import ogilvyOneLogo from "@/assets/ogilvy-one.svg"

export function NewSessionDesignView(props: { children: JSX.Element }) {
  return (
    <div data-component="session-new-design" class="relative size-full overflow-hidden bg-v2-background-bg-deep ">
      <div class="absolute inset-x-0 top-[25.375%] flex justify-center px-6">
        <div class={NEW_SESSION_CONTENT_WIDTH}>
          <Show
            when={import.meta.env.VITE_CM_BRAND}
            fallback={<WordmarkV2 class="h-auto w-full text-v2-background-bg-inverse" />}
          >
            <div
              role="img"
              aria-label="Ogilvy One"
              class="h-[110px] w-full bg-v2-background-bg-inverse"
              style={{
                "-webkit-mask": `url("${ogilvyOneLogo}") center / contain no-repeat`,
                mask: `url("${ogilvyOneLogo}") center / contain no-repeat`,
              }}
            />
          </Show>
          <div class="mt-8">{props.children}</div>
        </div>
      </div>
    </div>
  )
}
