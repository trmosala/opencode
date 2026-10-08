import { paths } from "@opencode-ai/ui/phosphor"
import { Collapsible } from "@kobalte/core/collapsible"
import { type ComponentProps, type JSX, Show, createMemo, splitProps } from "solid-js"
import "./tool-error-card-v2.css"

function BanIcon() {
  return (
    <svg
      data-slot="tool-error-card-ban"
      width="16"
      height="16"
      viewBox="0 0 256 256"
      fill="currentColor"
      xmlns="http://www.w3.org/2000/svg"
      aria-hidden="true"
    >
      <path d={paths.prohibit} />
    </svg>
  )
}

function LoaderIcon() {
  return (
    <svg
      data-slot="tool-error-card-loader"
      width="16"
      height="16"
      viewBox="0 0 256 256"
      fill="currentColor"
      xmlns="http://www.w3.org/2000/svg"
      aria-hidden="true"
    >
      <path d={paths.spinner} />
    </svg>
  )
}

function ChevronIcon() {
  return (
    <svg
      data-slot="tool-error-card-chevron"
      width="14"
      height="14"
      viewBox="0 0 256 256"
      fill="currentColor"
      xmlns="http://www.w3.org/2000/svg"
      aria-hidden="true"
    >
      <path d={paths["caret-right"]} />
    </svg>
  )
}

export interface ToolErrorCardV2Props extends Omit<ComponentProps<"div">, "children" | "title"> {
  title: JSX.Element | string
  subtitle: JSX.Element | string
  suffix?: JSX.Element | string
  loading?: boolean
  open?: boolean
  defaultOpen?: boolean
  onOpenChange?: (open: boolean) => void
  /** When set, subtitle renders as a link (clicks do not toggle expand). */
  subtitleHref?: string
}

export function ToolErrorCardV2(props: ToolErrorCardV2Props) {
  const [local, rest] = splitProps(props, [
    "title",
    "subtitle",
    "suffix",
    "loading",
    "open",
    "defaultOpen",
    "onOpenChange",
    "subtitleHref",
    "class",
    "classList",
  ])

  const hasSuffix = createMemo(() => {
    const s = local.suffix
    if (s == null) return false
    if (typeof s === "string") return s.length > 0
    return true
  })

  return (
    <Collapsible
      {...rest}
      data-component="tool-error-card"
      open={local.open}
      defaultOpen={local.defaultOpen}
      onOpenChange={local.onOpenChange}
      disabled={!hasSuffix()}
      aria-busy={local.loading ? true : undefined}
      classList={{
        ...local.classList,
        [local.class ?? ""]: !!local.class,
      }}
    >
      <Collapsible.Trigger as="div" role="button" data-slot="tool-error-card-trigger">
        <span data-slot="tool-error-card-icon-wrap">
          <Show when={local.loading} fallback={<BanIcon />}>
            <LoaderIcon />
          </Show>
        </span>
        <div data-slot="tool-error-card-main">
          <div data-slot="tool-error-card-labels">
            <span data-slot="tool-error-card-title">{local.title}</span>
            <span data-slot="tool-error-card-sep" aria-hidden="true">
              ·
            </span>
            <Show
              when={local.subtitleHref}
              fallback={<span data-slot="tool-error-card-subtitle">{local.subtitle}</span>}
            >
              <a
                data-slot="tool-error-card-subtitle"
                href={local.subtitleHref!}
                onClick={(e) => e.stopPropagation()}
                onPointerDown={(e) => e.stopPropagation()}
              >
                {local.subtitle}
              </a>
            </Show>
            <Show when={hasSuffix()}>
              <span data-slot="tool-error-card-chevron-wrap">
                <ChevronIcon />
              </span>
            </Show>
          </div>
        </div>
      </Collapsible.Trigger>
      <Show when={hasSuffix()}>
        <Collapsible.Content data-slot="tool-error-card-content">
          <div data-slot="tool-error-card-suffix">{local.suffix}</div>
        </Collapsible.Content>
      </Show>
    </Collapsible>
  )
}
