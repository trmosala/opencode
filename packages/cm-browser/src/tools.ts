import { tool, type ToolContext, type ToolDefinition } from "@opencode-ai/plugin"
import type { BrowserPort } from "./port"
import { hostOf, type BrowserState, type Modifier, type Request } from "./protocol"

async function run(port: BrowserPort, context: ToolContext, request: Request) {
  const response = await port.send(context.sessionID, request)
  if (!response.ok) throw new Error(`${response.error} (${response.code})`)
  return response.result
}

const result = (state: BrowserState) => ({
  title: state.title || state.url || "Browser tabs",
  output: state.tabs
    ? state.tabs.map((tab) => `${tab.tabID} ${tab.url}`).join("\n") ||
      "No opted-in tabs. Enable agent access in the browser panel."
    : [
        `tabID: ${state.tabID}`,
        `url: ${state.url}`,
        `title: ${state.title}`,
        "",
        "visible text:",
        state.visibleText || "(none)",
        "",
        "interactive elements:",
        ...state.elements.map(
          (element) =>
            `[${element.ref}] <${element.tag}>${element.role ? ` role=${element.role}` : ""} ${element.label || element.text || "(no label)"}`,
        ),
      ].join("\n"),
  metadata: { tabID: state.tabID, url: state.url },
})

async function askRead(context: ToolContext) {
  await context.ask({ permission: "browser_read_state", patterns: ["*"], always: ["*"], metadata: {} })
}

async function askWrite(
  port: BrowserPort,
  context: ToolContext,
  permission: string,
  request: Exclude<Request, { op: "read_state" | "list_tabs" }>,
) {
  if (request.op !== "navigate") await askRead(context)
  const url =
    request.op === "navigate" ? request.url : (await run(port, context, { op: "read_state", tabID: request.tabID })).url
  const host = hostOf(url)
  if (!host) throw new Error(`Browser URL is not HTTP(S): ${url}`)
  await context.ask({ permission, patterns: [host], always: [host], metadata: request })
}

const modifiers = (args: { ctrl?: boolean; alt?: boolean; shift?: boolean; meta?: boolean }) =>
  [
    args.ctrl ? "Ctrl" : undefined,
    args.alt ? "Alt" : undefined,
    args.shift ? "Shift" : undefined,
    args.meta ? "Meta" : undefined,
  ].filter((value): value is Modifier => Boolean(value))

const tabID = tool.schema.string().min(1).max(128).describe("Explicit tab ID from browser_read_state's tab inventory")

export function browserTools(port: BrowserPort): Record<string, ToolDefinition> {
  return {
    browser_read_state: tool({
      description:
        "Without tabID, list only tabs the user opted into agent access. With tabID, read that tab's bounded visible text and opaque element refs. Private tabs are never exposed.",
      args: { tabID: tabID.optional() },
      async execute(args, context) {
        await askRead(context)
        return result(
          await run(port, context, args.tabID ? { op: "read_state", tabID: args.tabID } : { op: "list_tabs" }),
        )
      },
    }),
    browser_navigate: tool({
      description: "Navigate an explicitly opted-in browser tab to an allowlisted HTTP(S) URL.",
      args: { tabID, url: tool.schema.string().url().max(2048).describe("HTTP(S) destination") },
      async execute(args, context) {
        const request = { op: "navigate", tabID: args.tabID, url: args.url } as const
        await askWrite(port, context, "browser_navigate", request)
        return result(await run(port, context, request))
      },
    }),
    browser_click: tool({
      description: "Click a snapshot ref in an opted-in tab. Cross-tab and stale refs are rejected.",
      args: { tabID, ref: tool.schema.string().max(256).describe("Opaque element ref from this tab's snapshot") },
      async execute(args, context) {
        const request = { op: "click", tabID: args.tabID, ref: args.ref } as const
        await askWrite(port, context, "browser_click", request)
        return result(await run(port, context, request))
      },
    }),
    browser_fill: tool({
      description: "Focus an element in an opted-in tab, select and clear its text, then type with trusted input.",
      args: { tabID, ref: tool.schema.string().max(256), text: tool.schema.string().max(10000) },
      async execute(args, context) {
        const request = { op: "fill", tabID: args.tabID, ref: args.ref, text: args.text } as const
        await askWrite(port, context, "browser_fill", request)
        return result(await run(port, context, request))
      },
    }),
    browser_press_key: tool({
      description: "Press a key in an explicitly opted-in browser tab with optional modifiers.",
      args: {
        tabID,
        key: tool.schema.string().min(1).max(32),
        ctrl: tool.schema.boolean().optional(),
        alt: tool.schema.boolean().optional(),
        shift: tool.schema.boolean().optional(),
        meta: tool.schema.boolean().optional(),
      },
      async execute(args, context) {
        const request = { op: "press_key", tabID: args.tabID, key: args.key, modifiers: modifiers(args) } as const
        await askWrite(port, context, "browser_press_key", request)
        return result(await run(port, context, request))
      },
    }),
  }
}
