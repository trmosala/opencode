import { tool, type ToolContext, type ToolDefinition } from "@opencode-ai/plugin"
import type { BrowserPort } from "./port"
import {
  hostOf,
  parseAccessContext,
  type BrowserState,
  type Modifier,
  type Request,
  type WriteRequest,
} from "./protocol"

async function run(port: BrowserPort, context: ToolContext, request: Request) {
  const response = await port.send(context.sessionID, request)
  if (!response.ok) throw new Error(`${response.error} (${response.code})`)
  return response.result
}

const result = (state: BrowserState) => ({
  title: state.title || state.url || "Browser tabs",
  output: state.history
    ? JSON.stringify(state.history)
    : state.opened
      ? `Opened private tab ${state.tabID}: ${state.url}. Agent access is off; the user must enable it before page tools can read or control it.`
      : state.tabs
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

async function askWrite(port: BrowserPort, context: ToolContext, permission: string, request: WriteRequest) {
  if (request.op !== "navigate") await askRead(context)
  const prepared = await run(port, context, { op: "prepare_write", request })
  const binding = parseAccessContext(prepared.context)
  if (!binding || binding.tabID !== request.tabID) throw new Error("Browser approval context is unavailable.")
  const url = request.op === "navigate" ? request.url : binding.origin
  const host = hostOf(url)
  if (!host) throw new Error(`Browser URL is not HTTP(S): ${url}`)
  await context.ask({ permission, patterns: [host], always: [host], metadata: request })
  return { ...request, context: binding }
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
    browser_search_history: tool({
      description:
        "Search the local browser visit history by title/URL and optional inclusive Unix millisecond dates. Returns at most 20 visits with short-lived refs. Main-process Never/Ask/Allow policy applies independently of page access. Deleted history is unavailable.",
      args: {
        query: tool.schema.string().max(256),
        from: tool.schema.number().int().nonnegative().optional(),
        to: tool.schema.number().int().nonnegative().optional(),
        limit: tool.schema.number().int().min(1).max(20).optional(),
      },
      async execute(args, context) {
        await context.ask({ permission: "browser_search_history", patterns: ["*"], always: ["*"], metadata: args })
        return result(await run(port, context, { op: "search_history", ...args, limit: args.limit ?? 10 }))
      },
    }),
    browser_open_history: tool({
      description:
        "Open a ref returned by browser_search_history in a new private tab. Main asks for native confirmation. This does not grant agent page access. Deleted, expired and other-task refs are rejected.",
      args: { ref: tool.schema.string().min(1).max(128) },
      async execute(args, context) {
        await context.ask({ permission: "browser_open_history", patterns: ["*"], always: ["*"], metadata: args })
        return result(await run(port, context, { op: "open_history", ref: args.ref }))
      },
    }),
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
        return result(await run(port, context, await askWrite(port, context, "browser_navigate", request)))
      },
    }),
    browser_click: tool({
      description:
        "Click a snapshot ref in an opted-in tab. Cross-tab and stale refs are rejected. File inputs open a user-only file picker, subject to site upload rules. Wait for the user to choose files, then read state again; you cannot supply local file paths. Downloads may require separate native approval.",
      args: { tabID, ref: tool.schema.string().max(256).describe("Opaque element ref from this tab's snapshot") },
      async execute(args, context) {
        const request = { op: "click", tabID: args.tabID, ref: args.ref } as const
        return result(await run(port, context, await askWrite(port, context, "browser_click", request)))
      },
    }),
    browser_fill: tool({
      description: "Focus an element in an opted-in tab, select and clear its text, then type with trusted input.",
      args: { tabID, ref: tool.schema.string().max(256), text: tool.schema.string().max(10000) },
      async execute(args, context) {
        const request = { op: "fill", tabID: args.tabID, ref: args.ref, text: args.text } as const
        return result(await run(port, context, await askWrite(port, context, "browser_fill", request)))
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
        return result(await run(port, context, await askWrite(port, context, "browser_press_key", request)))
      },
    }),
  }
}
