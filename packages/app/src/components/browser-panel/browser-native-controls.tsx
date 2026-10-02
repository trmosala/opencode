import { Button } from "@opencode-ai/ui/button"
import { IconButton } from "@opencode-ai/ui/icon-button"
import { Icon } from "@opencode-ai/ui/icon"
import { DropdownMenu } from "@opencode-ai/ui/dropdown-menu"
import { ButtonV2 } from "@opencode-ai/ui/v2/button-v2"
import { IconButtonV2 } from "@opencode-ai/ui/v2/icon-button-v2"
import { MenuV2 } from "@opencode-ai/ui/v2/menu-v2"
import { Keybind } from "@opencode-ai/ui/keybind"
import { Show, splitProps, type ComponentProps } from "solid-js"
import { Dynamic } from "solid-js/web"
import { useSettings } from "@/context/settings"

export function BrowserButton(props: ComponentProps<typeof Button>) {
  const settings = useSettings()
  const [local, rest] = splitProps(props, ["variant"])
  return (
    <Show when={settings.general.newLayoutDesigns()} fallback={<Button {...props} />}>
      <ButtonV2
        {...rest}
        data-browser-button
        variant={local.variant === "primary" ? "contrast" : local.variant === "ghost" ? "ghost" : "neutral"}
      />
    </Show>
  )
}

export function BrowserIconButton(props: ComponentProps<typeof IconButton>) {
  const settings = useSettings()
  const [local, rest] = splitProps(props, ["icon", "iconSize", "variant"])
  return (
    <Show when={settings.general.newLayoutDesigns()} fallback={<IconButton {...props} />}>
      <IconButtonV2
        {...rest}
        icon={<Icon name={local.icon} size={local.iconSize ?? "normal"} />}
        variant={local.variant === "primary" ? "contrast" : local.variant === "ghost" ? "ghost-muted" : "neutral"}
        state={
          props["aria-pressed"] === true ||
          props["aria-pressed"] === "true" ||
          props["aria-expanded"] === true ||
          props["aria-expanded"] === "true"
            ? "pressed"
            : "rest"
        }
      />
    </Show>
  )
}

function BrowserDropdownMenuRoot(props: ComponentProps<typeof DropdownMenu>) {
  return <DropdownMenu {...props} />
}

function BrowserDropdownMenuContent(props: ComponentProps<typeof DropdownMenu.Content>) {
  const settings = useSettings()
  return (
    <Dynamic
      component={settings.general.newLayoutDesigns() ? MenuV2.Content : DropdownMenu.Content}
      {...props}
      dir="ltr"
      classList={{ ...props.classList, "browser-native-menu": true }}
    />
  )
}

function BrowserDropdownMenuItem(props: ComponentProps<typeof DropdownMenu.Item> & { shortcut?: string }) {
  const settings = useSettings()
  const [local, rest] = splitProps(props, ["shortcut", "children"])
  return (
    <Show
      when={settings.general.newLayoutDesigns()}
      fallback={
        <DropdownMenu.Item {...rest}>
          {local.children}
          <Show when={local.shortcut}>
            <DropdownMenu.ItemDescription dir="ltr">
              <Keybind>{local.shortcut}</Keybind>
            </DropdownMenu.ItemDescription>
          </Show>
        </DropdownMenu.Item>
      }
    >
      <MenuV2.Item {...rest} shortcut={local.shortcut && <span dir="ltr">{local.shortcut}</span>}>
        {local.children}
      </MenuV2.Item>
    </Show>
  )
}

function BrowserDropdownMenuGroupLabel(props: ComponentProps<typeof DropdownMenu.GroupLabel>) {
  const settings = useSettings()
  return (
    <Dynamic component={settings.general.newLayoutDesigns() ? MenuV2.GroupLabel : DropdownMenu.GroupLabel} {...props} />
  )
}

function BrowserDropdownMenuSeparator(props: ComponentProps<typeof DropdownMenu.Separator>) {
  const settings = useSettings()
  return (
    <Dynamic component={settings.general.newLayoutDesigns() ? MenuV2.Separator : DropdownMenu.Separator} {...props} />
  )
}

export const BrowserDropdownMenu = Object.assign(BrowserDropdownMenuRoot, {
  Trigger: DropdownMenu.Trigger,
  Portal: DropdownMenu.Portal,
  Content: BrowserDropdownMenuContent,
  Item: BrowserDropdownMenuItem,
  ItemLabel: DropdownMenu.ItemLabel,
  Group: DropdownMenu.Group,
  GroupLabel: BrowserDropdownMenuGroupLabel,
  Separator: BrowserDropdownMenuSeparator,
})
