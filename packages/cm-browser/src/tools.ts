import { tool, type ToolContext, type ToolDefinition } from "@opencode-ai/plugin"
import type { BrowserPort } from "./port"
import {
  hostOf,
  parseAccessContext,
  parseTabRequest,
  type TabRequest,
  screenshotBytes,
  screenshotDimensions,
  MAX_SNAPSHOT_BYTES,
  type BrowserState,
  type Modifier,
  type Request,
  type WriteRequest,
} from "./protocol"

async function run(port: BrowserPort, context: ToolContext, request: Request) {
  context.abort.throwIfAborted()
  const response = await port.send(context.sessionID, request, context.abort)
  context.abort.throwIfAborted()
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
            `interactive elements:${state.truncated ? " (snapshot truncated)" : ""}`,
            ...state.elements.flatMap((element) => [
              `[${element.ref}] <${element.tag}>${element.role ? ` role=${element.role}` : ""} ${element.label || element.text || "(no label)"}${(["checked", "selected", "expanded", "disabled"] as const).map((key) => (element[key] === undefined ? "" : ` ${key}=${element[key]}`)).join("")}`,
              ...(element.options
                ? [
                    `options for [${element.ref}]${element.optionsTruncated ? " (truncated)" : ""}:`,
                    ...element.options.map(
                      (option) =>
                        `[${option.ref}] ${option.label || "(no label)"} selected=${option.selected} disabled=${option.disabled}`,
                    ),
                  ]
                : []),
            ]),
          ].join("\n"),
  metadata: { tabID: state.tabID, url: state.url },
})

async function ask(context: ToolContext, input: Parameters<ToolContext["ask"]>[0]) {
  context.abort.throwIfAborted()
  await context.ask(input)
  context.abort.throwIfAborted()
}

async function askRead(context: ToolContext) {
  await ask(context, { permission: "browser_read_state", patterns: ["*"], always: ["*"], metadata: {} })
}

async function askWrite(port: BrowserPort, context: ToolContext, permission: string, request: WriteRequest) {
  if (request.op !== "navigate") await askRead(context)
  const prepared = await run(port, context, { op: "prepare_write", request })
  const binding = parseAccessContext(prepared.context)
  if (!binding || binding.tabID !== request.tabID) throw new Error("Browser approval context is unavailable.")
  const url = request.op === "navigate" ? request.url : binding.origin
  const host = hostOf(url)
  if (!host) throw new Error(`Browser URL is not HTTP(S): ${url}`)
  await ask(context, { permission, patterns: [host], always: [host], metadata: request })
  return { ...request, context: binding }
}

const tabState = tool.schema
  .object({
    tabID: tool.schema.literal(""),
    url: tool.schema.literal(""),
    title: tool.schema.literal(""),
    visibleText: tool.schema.literal(""),
    elements: tool.schema.array(tool.schema.never()).max(0),
  })
  .strict()

const opaqueID = tool.schema.string().regex(/^[A-Za-z0-9_-]{1,128}$/)

async function runTab(port: BrowserPort, context: ToolContext, op: TabRequest["op"], args: Record<string, unknown>) {
  context.abort.throwIfAborted()
  const request = parseTabRequest({ ...args, op })
  if ("op" in args || !request) throw new Error("Invalid browser tab request.")
  const prepared = tabState
    .extend({ tabToken: opaqueID })
    .safeParse(await run(port, context, { op: "prepare_tab", request }))
  if (!prepared.success) throw new Error("Invalid browser tab preparation result.")
  const token = prepared.data.tabToken
  await ask(context, { permission: `browser_${op}`, patterns: ["*"], always: ["*"], metadata: request })
  const completed = tabState
    .extend({ tabResult: tool.schema.object({ op: tool.schema.literal(op), tabID: opaqueID }).strict() })
    .safeParse(await run(port, context, { ...request, token }))
  if (!completed.success || (request.op !== "create_tab" && completed.data.tabResult.tabID !== request.tabID))
    throw new Error("Invalid browser tab lifecycle result.")
  return `${completed.data.tabResult.op} ${completed.data.tabResult.tabID}`
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
    browser_create_tab: tool({
      description:
        "Create one blank private tab in this task after named lifecycle approval. No URL or page access grant. Returns only the operation and opaque tab ID; no automatic retry.",
      args: {},
      execute: (args, context) => runTab(port, context, "create_tab", args),
    }),
    browser_select_tab: tool({
      description:
        "Select an explicit tab in this task after named lifecycle approval. Does not grant page access or expose private page metadata. Returns only the operation and opaque tab ID; no automatic retry.",
      args: { tabID },
      execute: (args, context) => runTab(port, context, "select_tab", args),
    }),
    browser_close_tab: tool({
      description:
        "Close an explicit tab in this task after named lifecycle approval, respecting unsaved-page confirmation. Does not grant page access or expose private page metadata. Returns only the operation and opaque tab ID; no automatic retry.",
      args: { tabID },
      execute: (args, context) => runTab(port, context, "close_tab", args),
    }),
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
        await ask(context, { permission: "browser_search_history", patterns: ["*"], always: ["*"], metadata: args })
        return result(await run(port, context, { op: "search_history", ...args, limit: args.limit ?? 10 }))
      },
    }),
    browser_open_history: tool({
      description:
        "Open a ref returned by browser_search_history in a new private tab. Main asks for native confirmation. This does not grant agent page access. Deleted, expired and other-task refs are rejected.",
      args: { ref: tool.schema.string().min(1).max(128) },
      async execute(args, context) {
        await ask(context, { permission: "browser_open_history", patterns: ["*"], always: ["*"], metadata: args })
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
    browser_screenshot: tool({
      description:
        "Share one viewport JPEG from an opted-in task tab. Requires separate screenshot approval and native per-capture consent, even when tool permission allows. All visible pixels, including passwords, editable values, canvas and cross-origin frames, are disclosed without redaction. No full-page capture, resizing or retry. Returns an image attachment, not DOM refs.",
      args: { tabID },
      async execute(args, context) {
        const request = { op: "screenshot", tabID: args.tabID } as const
        const state = await run(port, context, await askWrite(port, context, "browser_screenshot", request))
        const image = state?.screenshot
        if (
          !image ||
          !screenshotDimensions(image.width, image.height) ||
          !screenshotBytes(image.data) ||
          state.tabID !== args.tabID ||
          typeof state.url !== "string" ||
          !hostOf(state.url) ||
          state.title !== "" ||
          state.visibleText !== "" ||
          !Array.isArray(state.elements) ||
          state.elements.length ||
          Buffer.byteLength(JSON.stringify({ ok: true, result: state })) > MAX_SNAPSHOT_BYTES
        )
          throw new Error("Invalid browser screenshot result.")
        return {
          output: `Screenshot ${image.width}x${image.height}; tab ${state.tabID}; source ${state.url}`,
          attachments: [{ type: "file" as const, mime: "image/jpeg", url: `data:image/jpeg;base64,${image.data}` }],
        }
      },
    }),
    browser_scroll: tool({
      description:
        "Send one bounded Chromium wheel event at the viewport center, or over a current interactive ref. Native hit testing, scroll chaining and site wheel handlers apply; movement is not guaranteed. Nested containers need a visible interactive ref inside them; empty/noninteractive containers are not directly targetable. Returns a fresh snapshot.",
      args: {
        tabID,
        ref: tool.schema.string().min(1).max(256).optional(),
        deltaX: tool.schema.number().int().min(-2000).max(2000),
        deltaY: tool.schema.number().int().min(-2000).max(2000),
        timeoutMs: tool.schema.number().int().min(1).max(15000).optional(),
      },
      async execute(args, context) {
        if (!args.deltaX && !args.deltaY) throw new Error("At least one scroll delta must be nonzero.")
        const request = { op: "scroll", ...args } as const
        return result(await run(port, context, await askWrite(port, context, "browser_scroll", request)))
      },
    }),
    browser_wait_for_element: tool({
      description:
        "Observe this tab's current top-frame document until a supported selector has positive viewport intersection and passes Chromium opacity/visibility checks, then return a fresh bounded snapshot. Only one ASCII compound selector, at most 512 characters: optional tag [A-Za-z][A-Za-z0-9-]* followed by zero or more #id or .class tokens whose names match [A-Za-z_][A-Za-z0-9_-]*; at least one token required (e.g. button#save.primary). No whitespace, attributes, pseudos, escapes, combinators, universal selectors or lists. Unsupported selectors return bad_request. This is not an occlusion/clickability check. Navigation interrupts this wait. No iframe/shadow DOM search; no ref is promised unless the match is included among snapshot interactive elements.",
      args: {
        tabID,
        selector: tool.schema.string().min(1).max(512),
        timeoutMs: tool.schema.number().int().min(1).max(15000),
      },
      async execute(args, context) {
        await askRead(context)
        return result(await run(port, context, { op: "wait_for_element", ...args }))
      },
    }),
    browser_wait_for_navigation: tool({
      description:
        "Observe an explicit tab until its exact URL equals url and main-frame loading is finished, then return a fresh snapshot. Level-triggered: an already-loaded URL succeeds immediately; this does not prove a fresh same-URL reload. Never starts or stops navigation.",
      args: {
        tabID,
        url: tool.schema.string().url().max(2048),
        timeoutMs: tool.schema.number().int().min(1).max(15000),
      },
      async execute(args, context) {
        await askRead(context)
        return result(await run(port, context, { op: "wait_for_navigation", ...args }))
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
    browser_drag: tool({
      description:
        "Complete one bounded Chromium pointer gesture between distinct interactive refs from the same tab and snapshot. Both endpoints must remain valid through initial hover; four fixed pressed moves require the original destination to stay visible, enabled, unobscured and at the same center. Success means the gesture completed, not that a drop was accepted. Only existing snapshot-addressable controls: plain noninteractive drop divs are not discovered. No coordinates, duration/steps, universal HTML5 DnD, OS-file or native dragging. Failure while pressed sends no cleanup release or retry; without acknowledged release the tab is quarantined until closed and replaced. Site effects already dispatched cannot be recalled.",
      args: {
        tabID,
        sourceRef: tool.schema.string().min(1).max(256),
        targetRef: tool.schema.string().min(1).max(256),
      },
      async execute(args, context) {
        const request = { op: "drag", tabID: args.tabID, sourceRef: args.sourceRef, targetRef: args.targetRef } as const
        return result(await run(port, context, await askWrite(port, context, "browser_drag", request)))
      },
    }),
    browser_hover: tool({
      description:
        "Move the pointer over a current snapshot ref in an opted-in tab without pressing buttons, then return a fresh snapshot. Hover handlers can act, so write approval is required. Cross-tab and stale refs are rejected.",
      args: { tabID, ref: tool.schema.string().min(1).max(256) },
      async execute(args, context) {
        const request = { op: "hover", tabID: args.tabID, ref: args.ref } as const
        return result(await run(port, context, await askWrite(port, context, "browser_hover", request)))
      },
    }),
    browser_click: tool({
      description:
        "Click a snapshot ref in an opted-in tab: left (default), double or right. Double revalidates the original node after the first click; failure does not undo that click. Right runs DOM contextmenu handlers but suppresses all app-native menus on that tab until native settlement, including simultaneous manual menus; cancellation may reply before suppression ends; native menus are not snapshot-readable and must not be driven with blind keys. Cross-tab and stale refs are rejected. File inputs open a user-only file picker, subject to site upload rules. Wait for the user to choose files, then read state again; you cannot supply local file paths. Downloads may require separate native approval.",
      args: {
        tabID,
        ref: tool.schema.string().min(1).max(256).describe("Opaque element ref from this tab's snapshot"),
        mode: tool.schema.enum(["left", "double", "right"]).optional(),
      },
      async execute(args, context) {
        const request = {
          op: "click",
          tabID: args.tabID,
          ref: args.ref,
          ...(args.mode ? { mode: args.mode } : {}),
        } as const
        return result(await run(port, context, await askWrite(port, context, "browser_click", request)))
      },
    }),
    browser_select_option: tool({
      description:
        "Choose an opaque optionRef owned by a native single-select ref in the same tab snapshot. Disabled selects/options/groups and multiple selects are refused. Uses the native selected setter, not keyboard input; bubbling input/change events have isTrusted=false and fire only on selection change. Site handlers may submit, navigate or mutate; dispatched effects cannot be recalled, and failures never automatically retry selection. Returns a fresh snapshot without option values.",
      args: {
        tabID,
        ref: tool.schema.string().min(1).max(256),
        optionRef: tool.schema.string().min(1).max(256),
      },
      async execute(args, context) {
        const request = { op: "select_option", tabID: args.tabID, ref: args.ref, optionRef: args.optionRef } as const
        return result(await run(port, context, await askWrite(port, context, "browser_select_option", request)))
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
