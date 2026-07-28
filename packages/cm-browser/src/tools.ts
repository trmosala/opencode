import { tool, type ToolContext, type ToolDefinition } from "@opencode-ai/plugin"
import type { BrowserPort } from "./port"
import { hostOf, type BrowserState, type Modifier, type Request, type Response } from "./protocol"

const states = new Map<string, BrowserState>()

const unwrap = (response: Response<BrowserState>) => {
  if (!response.ok) throw new Error(`${response.error} (${response.code})`)
  return response.result
}

const run = async (port: BrowserPort, context: ToolContext, request: Request) => {
  const state = unwrap(await port.send(context.sessionID, request))
  states.set(context.sessionID, state)
  return state
}

const describe = (state: BrowserState) =>
  [
    `url: ${state.url}`,
    `title: ${state.title}`,
    "",
    "visible text:",
    state.visibleText || "(none)",
    "",
    "interactive elements:",
    ...state.elements.map((element) => {
      const role = element.role ? ` role=${element.role}` : ""
      return `[${element.ref}] <${element.tag}>${role} ${element.label || element.text || "(no label)"}`
    }),
  ].join("\n")

const result = (state: BrowserState) => ({
  title: state.title || state.url,
  output: describe(state),
  metadata: { url: state.url },
})

async function askRead(context: ToolContext) {
  await context.ask({ permission: "browser_read_state", patterns: ["*"], always: ["*"], metadata: {} })
}

async function askWrite(
  port: BrowserPort,
  context: ToolContext,
  permission: string,
  request: Exclude<Request, { op: "read_state" }>,
) {
  const url =
    request.op === "navigate"
      ? request.url
      : (states.get(context.sessionID) ?? (await run(port, context, { op: "read_state" }))).url
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

export function browserTools(port: BrowserPort): Record<string, ToolDefinition> {
  return {
    browser_read_state: tool({
      description:
        "Read the current CookieMonster browser page. Returns its URL, title, bounded visible text, and opaque element refs for browser_click and browser_fill.",
      args: {},
      async execute(_args, context) {
        await askRead(context)
        return result(await run(port, context, { op: "read_state" }))
      },
    }),

    browser_navigate: tool({
      description:
        "Navigate CookieMonster's browser panel to an allowlisted HTTP(S) URL and return the new page state.",
      args: { url: tool.schema.string().url().describe("HTTP(S) destination") },
      async execute(args, context) {
        const request = { op: "navigate", url: args.url } as const
        await askWrite(port, context, "browser_navigate", request)
        return result(await run(port, context, request))
      },
    }),

    browser_click: tool({
      description:
        "Click an element using an opaque ref from a browser state snapshot. Stale refs are rejected. Returns the updated page state.",
      args: { ref: tool.schema.string().describe("Opaque element ref, for example s4:e12") },
      async execute(args, context) {
        const request = { op: "click", ref: args.ref } as const
        await askWrite(port, context, "browser_click", request)
        return result(await run(port, context, request))
      },
    }),

    browser_fill: tool({
      description:
        "Focus an element by snapshot ref, clear it with Ctrl+A and Backspace, then type with trusted key events. Returns the updated page state.",
      args: {
        ref: tool.schema.string().describe("Opaque element ref from browser_read_state"),
        text: tool.schema.string().describe("Replacement text"),
      },
      async execute(args, context) {
        const request = { op: "fill", ref: args.ref, text: args.text } as const
        await askWrite(port, context, "browser_fill", request)
        return result(await run(port, context, request))
      },
    }),

    browser_press_key: tool({
      description:
        "Press one key in CookieMonster's browser panel with optional Ctrl, Alt, Shift, or Meta modifiers. Returns the updated page state.",
      args: {
        key: tool.schema.string().min(1).describe("Key name, for example Enter, Tab, Escape, or a"),
        ctrl: tool.schema.boolean().optional(),
        alt: tool.schema.boolean().optional(),
        shift: tool.schema.boolean().optional(),
        meta: tool.schema.boolean().optional(),
      },
      async execute(args, context) {
        const request = { op: "press_key", key: args.key, modifiers: modifiers(args) } as const
        await askWrite(port, context, "browser_press_key", request)
        return result(await run(port, context, request))
      },
    }),
  }
}
