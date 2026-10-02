import { randomUUID } from "node:crypto"
import type { WebContents } from "electron"
import {
  success,
  type BrowserState,
  type FrameAction,
  type FrameContext,
  type FrameRequest,
  type FrameSelectContext,
  type Modifier,
} from "@cookiemonster/cm-browser/protocol"
import { browserAgentEnabled, browserRegistration, type BrowserRegistration } from "./registry"
import { markBrowserInputDown, markBrowserInputReleased, suppressBrowserContextMenu } from "./driver"
import { dragSnapshotScript, parseSnapshot, snapshotScript, selectOptionScript, type PageSnapshot } from "./snapshot"
import { browserConditionScript } from "./condition-probe"
import { nativeFrameIdentity, sameNativeFrame, type NativeFrameIdentity } from "./frame-identity"

type Frame = { id: string; parentId?: string; loaderId: string; url: string; securityOrigin: string }
type FrameTree = { frame: Frame; childFrames?: FrameTree[] }
type Tree = { frameTree: FrameTree }
type Session = ReturnType<NonNullable<BrowserRegistration["frameSessions"]>["capture"]>
type Entry = {
  frame: Frame
  top: Frame
  root: Session
  child: Session
  owner?: string
  ownerSession?: Session
  ownerBackendNodeId?: number
  owners?: {
    owner: string
    session: Session
    childSession: Session
    childWorld: number
    rootWorld: number
    backendNodeId: number
    parent: Frame
    child: Frame
  }[]
  check: () => void
  parentFrameRef?: string
  world?: number
  approval?: string
  snapshots?: Map<string, PageSnapshot>
  selection?: FrameSelectContext
  input?: { approval: string; action: FrameAction }
}
const refs = new WeakMap<BrowserRegistration, Map<string, Entry>>()
const origin = (frame: Frame) => {
  try {
    const url = new URL(frame.url)
    return (
      !!frame.id &&
      !!frame.loaderId &&
      ["http:", "https:"].includes(url.protocol) &&
      !url.username &&
      !url.password &&
      frame.securityOrigin === url.origin &&
      frame.securityOrigin.length <= 2048
    )
  } catch {
    return false
  }
}
const same = (a: Frame | undefined, b: Frame) =>
  a &&
  a.id === b.id &&
  a.parentId === b.parentId &&
  a.loaderId === b.loaderId &&
  a.url === b.url &&
  a.securityOrigin === b.securityOrigin
const frameOrigin = (frame: Frame) => frame.securityOrigin || "null"

const frameRefParts = (ref: string) => {
  const match = /^([^:]+):([a-zA-Z0-9-]{1,64})$/.exec(ref)
  return match && match[1].startsWith("frame.") ? { id: match[1], token: match[2] } : undefined
}

async function currentFrameElement(entry: Entry, check: () => void, ref: string, fill = false, focused = false) {
  const parts = frameRefParts(ref)
  const page = parts && entry.snapshots?.get(parts.id)
  const expected = page?.elements.find((element) => element.token === parts?.token)
  if (!parts || !page || !expected || page.url !== entry.frame.url || !entry.world) return
  const result = await send(entry, entry.child, check, "Runtime.evaluate", {
    contextId: entry.world,
    expression: snapshotScript(parts.id, {
      generation: page.generation,
      token: parts.token,
      ...(fill ? { fill: true } : {}),
      ...(focused ? { focused: true } : {}),
    }),
    returnByValue: true,
  })
  const current = parseSnapshot(result)
  const actual = current?.elements[0]
  if (current?.generation !== page.generation || actual?.token !== expected.token || actual.disabled) return
  return { id: parts.id, page, element: actual }
}

async function framePoint(entry: Entry, check: () => void, x: number, y: number) {
  if (!entry.owners?.length) throw new Error("Unsupported browser frame owner")
  let point = { x, y }
  let coordinateSession: string | undefined
  const hitTestedSessions = new Set<string>()
  for (const owner of entry.owners) {
    const model = (await send(entry, owner.session, check, "DOM.getBoxModel", {
      backendNodeId: owner.backendNodeId,
    })) as { model?: { content?: number[] } }
    const quad = model.model?.content
    if (!quad || quad.length !== 8 || quad.some((value) => !Number.isFinite(value)))
      throw new Error("Unsupported browser frame geometry")
    // Affine transforms (including rotation and scale) map the viewport into the owner's content quad.
    if (Math.abs(quad[0] + quad[4] - quad[2] - quad[6]) > 1 || Math.abs(quad[1] + quad[5] - quad[3] - quad[7]) > 1)
      throw new Error("Unsupported perspective frame transform")
    if (coordinateSession !== owner.session.sessionID) {
      const viewport = (await send(entry, owner.childSession, check, "Runtime.evaluate", {
        contextId: owner.childWorld,
        expression: "({width:innerWidth,height:innerHeight})",
        returnByValue: true,
      })) as { result?: { value?: { width?: number; height?: number } } }
      const width = viewport.result?.value?.width
      const height = viewport.result?.value?.height
      if (!Number.isFinite(width) || !Number.isFinite(height) || width! <= 0 || height! <= 0)
        throw new Error("Unsupported browser frame viewport")
      const u = point.x / width!
      const v = point.y / height!
      if (u < 0 || u > 1 || v < 0 || v > 1) throw new Error("Browser frame point is outside its viewport")
      point = {
        x: quad[0] + u * (quad[2] - quad[0]) + v * (quad[6] - quad[0]),
        y: quad[1] + u * (quad[3] - quad[1]) + v * (quad[7] - quad[1]),
      }
      coordinateSession = owner.session.sessionID
    }
    if (!hitTestedSessions.has(owner.session.sessionID)) {
      const scroll = (await send(entry, owner.session, check, "Runtime.evaluate", {
        contextId: owner.rootWorld,
        expression: "({x:scrollX,y:scrollY})",
        returnByValue: true,
      })) as { result?: { value?: { x?: number; y?: number } } }
      const scrollX = scroll.result?.value?.x
      const scrollY = scroll.result?.value?.y
      if (!Number.isFinite(scrollX) || !Number.isFinite(scrollY))
        throw new Error("Browser frame scroll position unavailable")
      const hit = (await send(entry, owner.session, check, "DOM.getNodeForLocation", {
        x: Math.round(point.x + scrollX!),
        y: Math.round(point.y + scrollY!),
        includeUserAgentShadowDOM: true,
      })) as { frameId?: string; backendNodeId?: number }
      if (hit.backendNodeId !== owner.backendNodeId && hit.frameId !== owner.child.id && hit.frameId !== entry.frame.id)
        throw new Error("Browser frame owner is obscured")
      hitTestedSessions.add(owner.session.sessionID)
    }
  }
  return { x: Math.round(point.x), y: Math.round(point.y) }
}

async function nativeInput(
  tab: BrowserRegistration,
  check: () => void,
  markDispatched: (() => void) | undefined,
  event: Parameters<WebContents["sendInputEvent"]>[0],
) {
  check()
  markDispatched?.()
  if (event.type === "keyDown" || event.type === "mouseDown") markBrowserInputDown(tab.contents)
  const contents = tab.contents as WebContents
  const mouseTypes = {
    mouseMove: "mouseMoved",
    mouseDown: "mousePressed",
    mouseUp: "mouseReleased",
    mouseWheel: "mouseWheel",
  }
  const keyNames: Record<string, { key: string; code: string; keyCode: number }> = {
    Return: { key: "Enter", code: "Enter", keyCode: 13 },
    Tab: { key: "Tab", code: "Tab", keyCode: 9 },
    Escape: { key: "Escape", code: "Escape", keyCode: 27 },
    Backspace: { key: "Backspace", code: "Backspace", keyCode: 8 },
    Delete: { key: "Delete", code: "Delete", keyCode: 46 },
    Up: { key: "ArrowUp", code: "ArrowUp", keyCode: 38 },
    Down: { key: "ArrowDown", code: "ArrowDown", keyCode: 40 },
    Left: { key: "ArrowLeft", code: "ArrowLeft", keyCode: 37 },
    Right: { key: "ArrowRight", code: "ArrowRight", keyCode: 39 },
    PageUp: { key: "PageUp", code: "PageUp", keyCode: 33 },
    PageDown: { key: "PageDown", code: "PageDown", keyCode: 34 },
    Home: { key: "Home", code: "Home", keyCode: 36 },
    End: { key: "End", code: "End", keyCode: 35 },
    Space: { key: " ", code: "Space", keyCode: 32 },
  }
  const modifiers = (event as { modifiers?: readonly string[] }).modifiers ?? []
  const modifierFlags = modifiers.reduce(
    (flags, modifier) => flags | ({ alt: 1, control: 2, ctrl: 2, meta: 4, shift: 8 }[modifier] ?? 0),
    0,
  )
  if (
    event.type === "mouseMove" ||
    event.type === "mouseDown" ||
    event.type === "mouseUp" ||
    event.type === "mouseWheel"
  ) {
    const mouse = event as {
      type: "mouseMove" | "mouseDown" | "mouseUp" | "mouseWheel"
      x: number
      y: number
      button?: "left" | "right"
      clickCount?: number
      deltaX?: number
      deltaY?: number
    }
    const type = mouseTypes[mouse.type]
    await contents.debugger.sendCommand("Input.dispatchMouseEvent", {
      type,
      x: mouse.x,
      y: mouse.y,
      button: mouse.button ?? "none",
      buttons:
        mouse.type === "mouseDown" || mouse.type === "mouseMove"
          ? mouse.button === "right"
            ? 2
            : mouse.type === "mouseDown" || mouse.button === "left"
              ? 1
              : 0
          : 0,
      modifiers: modifierFlags,
      ...(mouse.clickCount === undefined ? {} : { clickCount: mouse.clickCount }),
      ...(mouse.type !== "mouseWheel" ? {} : { deltaX: mouse.deltaX, deltaY: mouse.deltaY }),
    })
  } else {
    const keyboard = event as { type: "keyDown" | "keyUp" | "char"; keyCode: string }
    const key =
      keyNames[keyboard.keyCode] ??
      (Array.from(keyboard.keyCode).length === 1
        ? {
            key: keyboard.keyCode,
            code: /^[a-z]$/i.test(keyboard.keyCode) ? `Key${keyboard.keyCode.toUpperCase()}` : "",
            keyCode: keyboard.keyCode.toUpperCase().codePointAt(0) ?? 0,
          }
        : undefined)
    if (!key) throw new Error("Unsupported browser key")
    await contents.debugger.sendCommand("Input.dispatchKeyEvent", {
      type: keyboard.type,
      key: key.key,
      code: key.code,
      windowsVirtualKeyCode: key.keyCode,
      modifiers: modifierFlags,
      ...(keyboard.type === "char" ? { text: keyboard.keyCode } : {}),
    })
  }
  if (event.type === "keyUp" || event.type === "mouseUp") markBrowserInputReleased(tab.contents)
  check()
}

async function frameHasFocus(tab: BrowserRegistration, entry: Entry, check: () => void, focusedRef?: string) {
  const contents = tab.contents as WebContents
  const focusedFrame = contents.focusedFrame
  if (!focusedFrame || focusedFrame.detached || focusedFrame.url !== entry.frame.url)
    throw new Error("Browser native frame focus changed")
  const identity = nativeFrameIdentity(focusedFrame)
  const response = (await send(entry, entry.child, check, "Runtime.evaluate", {
    contextId: entry.world,
    expression:
      "(() => { let active = document.activeElement; for (let i = 0; active?.shadowRoot && i < 64; i++) active = active.shadowRoot.activeElement; return document.hasFocus() && !(active instanceof HTMLIFrameElement); })()",
    returnByValue: true,
  })) as { result?: { value?: unknown }; exceptionDetails?: unknown }
  if (response.exceptionDetails || response.result?.value !== true) {
    if (!focusedRef || !(await currentFrameElement(entry, check, focusedRef, true, true)))
      throw new Error("Browser frame focus changed")
    const focused = (await send(entry, entry.child, check, "Runtime.evaluate", {
      contextId: entry.world,
      expression: "document.hasFocus()",
      returnByValue: true,
    })) as { result?: { value?: unknown }; exceptionDetails?: unknown }
    if (focused.exceptionDetails || focused.result?.value !== true) throw new Error("Browser frame focus changed")
  }
  const current = contents.focusedFrame
  if (!current || current.detached || !sameNativeFrame(identity, nativeFrameIdentity(current)))
    throw new Error("Browser native frame focus changed")
  return identity
}

async function frameKeys(
  tab: BrowserRegistration,
  entry: Entry,
  check: () => void,
  markDispatched: (() => void) | undefined,
  key: string,
  modifiers: readonly Modifier[] = [],
  focusedRef?: string,
) {
  const names: Record<string, string> = {
    enter: "Return",
    tab: "Tab",
    escape: "Escape",
    backspace: "Backspace",
    delete: "Delete",
    arrowup: "Up",
    arrowdown: "Down",
    arrowleft: "Left",
    arrowright: "Right",
    pageup: "PageUp",
    pagedown: "PageDown",
    home: "Home",
    end: "End",
    " ": "Space",
  }
  const normalized = key === " " ? " " : key.trim().toLowerCase()
  const code = names[normalized] ?? (Array.from(key).length === 1 ? key.toUpperCase() : undefined)
  if (!code) throw new Error("Unsupported browser key")
  const contents = tab.contents as WebContents
  let focusedFrame: NativeFrameIdentity | undefined
  const modifierKeys: Record<Modifier, "alt" | "control" | "meta" | "shift"> = {
    Alt: "alt",
    Ctrl: "control",
    Meta: "meta",
    Shift: "shift",
  }
  const flags = { modifiers: modifiers.map((modifier) => modifierKeys[modifier]) }
  const validateFocus = async () => {
    const current = await frameHasFocus(tab, entry, check, focusedRef)
    if (focusedFrame && !sameNativeFrame(current, focusedFrame)) throw new Error("Browser native frame focus changed")
    focusedFrame = current
  }
  await validateFocus()
  await nativeInput(tab, check, markDispatched, { type: "keyDown", keyCode: code, ...flags })
  const current = contents.focusedFrame
  if (!current || current.detached || !focusedFrame || !sameNativeFrame(nativeFrameIdentity(current), focusedFrame))
    throw new Error("Browser native frame focus changed")
  if (Array.from(key).length === 1 && !modifiers.length) {
    await validateFocus()
    await nativeInput(tab, check, markDispatched, { type: "char", keyCode: key, ...flags })
    const current = contents.focusedFrame
    if (!current || current.detached || !focusedFrame || !sameNativeFrame(nativeFrameIdentity(current), focusedFrame))
      throw new Error("Browser native frame focus changed")
  }
  await validateFocus()
  await nativeInput(tab, check, markDispatched, { type: "keyUp", keyCode: code, ...flags })
  entry.check()
}

const ownerFunction = (pin: boolean) => `function() {
  const node = this, doc = document, root = document.documentElement;
  if (!(node instanceof HTMLIFrameElement) || node.getRootNode({composed:true}) !== doc || !node.isConnected ||
      !node.checkVisibility({checkOpacity:true,checkVisibilityCSS:true})) return false;
  const chain = [];
  for (let el = node; el; el = el.assignedSlot || el.parentElement || (el.getRootNode() instanceof ShadowRoot ? el.getRootNode().host : null)) {
    if (chain.length >= 64) return false;
    chain.push(el);
    if (el instanceof Element && el.hasAttribute("inert")) return false;
  }
  const state = globalThis.__cmFrameOwners ||= new WeakMap();
  const stored = state.get(node);
  if (${pin}) state.set(node, { doc, root, chain });
  else if (!stored || stored.doc !== doc || stored.root !== root ||
    chain.length !== stored.chain.length || chain.some((el,i) => el !== stored.chain[i])) return false;
  const r = node.getBoundingClientRect();
  return r.width > 0 && r.height > 0;
}`

async function send(
  entry: Entry,
  session: Session,
  check: () => void,
  method: string,
  params: Record<string, unknown> = {},
) {
  check()
  entry.check()
  const result = await session.send(method, params)
  entry.check()
  check()
  return result
}

async function validate(entry: Entry, check: () => void, requireOwner = false) {
  const top = (await send(entry, entry.root, check, "Page.getFrameTree")) as Tree
  const tree = entry.child.sessionID ? ((await send(entry, entry.child, check, "Page.getFrameTree")) as Tree) : top
  const frame = findFrame(tree.frameTree, entry.frame.id)
  if (!same(top.frameTree.frame, entry.top) || !same(frame, entry.frame))
    throw new Error("Browser frame document changed")
  if (!requireOwner) return
  if (!entry.owners?.length) throw new Error("Unsupported browser frame owner")
  for (const owner of entry.owners) {
    const current = (await send(entry, owner.session, check, "DOM.getFrameOwner", {
      frameId: owner.child.id,
    })) as { backendNodeId?: number }
    if (current.backendNodeId !== owner.backendNodeId) throw new Error("Browser frame owner changed")
    const result = (await send(entry, owner.session, check, "Runtime.callFunctionOn", {
      objectId: owner.owner,
      functionDeclaration: ownerFunction(false),
      returnByValue: true,
    })) as { result?: { value?: unknown }; exceptionDetails?: unknown }
    if (result.exceptionDetails || result.result?.value !== true) throw new Error("Unsupported browser frame owner")
  }
}

function findFrame(node: { frame: Frame; childFrames?: { frame: Frame }[] }, id: string): Frame | undefined {
  if (node.frame.id === id) return node.frame
  for (const child of node.childFrames ?? []) {
    const found = findFrame(child, id)
    if (found) return found
  }
}

const MAX_EMBEDDED_DOCUMENTS = 32
const MAX_EMBEDDED_TEXT = 4_000
const MAX_EMBEDDED_ELEMENTS = 24
const MAX_EMBEDDED_BYTES = 28_000

export async function discoverDocuments(
  tab: BrowserRegistration,
  check: () => void,
  allowed: (url: string) => boolean,
  maxBytes = MAX_EMBEDDED_BYTES,
) {
  const sessions = tab.frameSessions
  check()
  if (!sessions) return undefined
  if (sessions.overflowed())
    return {
      frames: [],
      documents: [
        {
          frameRef: randomUUID(),
          origin: "",
          url: "",
          title: "",
          status: "truncated" as const,
          reason: "native_frame_session_limit",
        },
      ],
      check,
    }
  const root = sessions.capture()
  const rootTree = (await root.tree()) as Tree
  const top = rootTree.frameTree.frame
  check()
  if (!origin(top) || top.url !== tab.contents.getURL()) throw new Error("Unsupported top frame")
  const source = {
    revision: tab.revision,
    access: tab.accessRevision ?? 0,
    owner: tab.ownerID,
    task: tab.sessionID,
    contents: tab.contents,
  }
  const sourceCheck = () => {
    root.check()
    if (
      tab.frameSessions !== sessions ||
      browserRegistration(source.task, tab.id) !== tab ||
      tab.contents !== source.contents ||
      tab.ownerID !== source.owner ||
      tab.revision !== source.revision ||
      (tab.accessRevision ?? 0) !== source.access ||
      !tab.agentAccess ||
      !browserAgentEnabled() ||
      tab.contents.getURL() !== top.url ||
      !allowed(top.url)
    )
      throw new Error("Browser frame access changed")
  }
  sourceCheck()
  for (const sessionID of new Set(["", ...sessions.list().map((context) => context.sessionID)])) {
    sourceCheck()
    check()
    const session = sessions.capture(sessionID)
    await session.send("Runtime.releaseObjectGroup", { objectGroup: "cm-browser-frame-owners" })
    sourceCheck()
    check()
  }
  const entries = new Map<string, Entry>()
  refs.set(tab, entries)
  const contexts = sessions
    .list()
    .filter((context) => context.frameId !== top.id)
    .slice(0, 128)
  const trees = new Map<string, Tree>([["", rootTree]])
  for (const sessionID of new Set(contexts.map((context) => context.sessionID).filter(Boolean))) {
    sourceCheck()
    check()
    const session = sessions.capture(sessionID)
    trees.set(sessionID, (await session.tree()) as Tree)
    sourceCheck()
    check()
  }
  const frameMap = new Map<string, Frame>()
  for (const tree of trees.values()) collectFrames(tree.frameTree, frameMap)
  const contextMap = new Map(contexts.map((context) => [context.frameId, context]))
  const allNativeFrames = [...frameMap.values()].filter((frame) => frame.id !== top.id)
  const nativeFrames = allNativeFrames.slice(0, MAX_EMBEDDED_DOCUMENTS)
  const refsByFrame = new Map(nativeFrames.map((frame) => [frame.id, randomUUID()]))
  let textBudget = MAX_EMBEDDED_TEXT
  let elementBudget = MAX_EMBEDDED_ELEMENTS
  const documents: NonNullable<BrowserState["documents"]>[number][] = []
  const frames: NonNullable<BrowserState["frames"]>[number][] = []
  for (const frame of nativeFrames) {
    sourceCheck()
    check()
    const frameRef = refsByFrame.get(frame.id)!
    const parentFrameRef = frame.parentId ? refsByFrame.get(frame.parentId) : undefined
    const context = contextMap.get(frame.id)
    const frameURL = safeFrameURL(frame.url)
    if (!context || !frame.loaderId || !frameURL) {
      documents.push({
        frameRef,
        ...(parentFrameRef ? { parentFrameRef } : {}),
        origin: safeOrigin(frame.securityOrigin),
        url: frameURL ?? "",
        title: "",
        status: !frame.loaderId || !frameURL ? "unsupported" : "failed",
        reason: !frame.loaderId || !frameURL ? "unsupported_frame_identity" : "native_document_context_unavailable",
      })
      continue
    }
    const child = sessions.capture(context.sessionID)
    const frameCheck = () => {
      sourceCheck()
      child.check()
      sessions.context(frame.id).check()
      const tree = trees.get(context.sessionID)
      if (!tree || !findFrame(tree.frameTree, frame.id)) throw new Error("Browser frame document changed")
    }
    const entry: Entry = { frame, top, root, child, check: frameCheck, ...(parentFrameRef ? { parentFrameRef } : {}) }
    entries.set(frameRef, entry)
    try {
      frameCheck()
      const world = (await send(entry, child, check, "Page.createIsolatedWorld", {
        frameId: frame.id,
        worldName: "cm-browser-frame-read",
      })) as { executionContextId: number }
      if (!Number.isInteger(world.executionContextId)) throw new Error("isolated_context_unavailable")
      entry.world = world.executionContextId
      entry.approval = randomUUID()
      const id = `frame.${randomUUID()}`
      const response = await send(entry, child, check, "Runtime.evaluate", {
        contextId: entry.world,
        expression: `(() => { globalThis.__cmFrameDocument = {document, root:document.documentElement, approval:${JSON.stringify(entry.approval)}}; return ${snapshotScript(id)}; })()`,
        returnByValue: true,
        timeout: 5_000,
      })
      const page = parseSnapshot(response)
      if (!page) throw new Error("native_read_failed")
      await validate(entry, check)
      const maxElements = Math.min(page.elements.length, elementBudget)
      const text = page.visibleText.slice(0, textBudget)
      const truncated = page.truncated || maxElements < page.elements.length || text.length < page.visibleText.length
      elementBudget -= maxElements
      textBudget -= text.length
      const snapshots = (entry.snapshots ??= new Map())
      snapshots.set(id, { ...page, elements: page.elements.slice(0, maxElements), visibleText: text, truncated })
      frames.push({ frameRef, origin: safeOrigin(frame.securityOrigin) })
      documents.push({
        frameRef,
        ...(parentFrameRef ? { parentFrameRef } : {}),
        origin: safeOrigin(frame.securityOrigin),
        url: frameURL,
        title: page.title,
        status: truncated ? "truncated" : "read",
        ...(truncated ? { reason: "bounded_document_snapshot" } : {}),
        omissions: [
          "closed_shadow_dom",
          "canvas_and_nonsemantic_rendered_content; use screenshot for visual observation",
        ],
        visibleText: text,
        elements: page.elements.slice(0, maxElements).map(({ token, rect: _rect, options, ...element }) => ({
          ...element,
          label: element.label.slice(0, 96),
          text: element.text.slice(0, 96),
          ref: `${id}:${token}`,
          ...(options
            ? {
                options: options.slice(0, 8).map(({ token, ...option }) => ({
                  ...option,
                  label: option.label.slice(0, 96),
                  ref: `${id}:${token}`,
                })),
                ...(options.length > 8 ? { optionsTruncated: true } : {}),
              }
            : {}),
        })),
      })
    } catch (error) {
      sourceCheck()
      check()
      documents.push({
        frameRef,
        ...(parentFrameRef ? { parentFrameRef } : {}),
        origin: safeOrigin(frame.securityOrigin),
        url: frameURL,
        title: "",
        status: "failed",
        reason:
          error instanceof Error && error.message === "isolated_context_unavailable"
            ? "isolated_context_unavailable"
            : "native_read_failed",
      })
    }
  }
  const ownerWorlds = new Map<string, number>()
  const sessionRootWorlds = new Map<string, number>()
  for (const entry of entries.values()) {
    const owners: NonNullable<Entry["owners"]> = []
    let childFrame = entry.frame
    for (let depth = 0; childFrame.parentId && depth < 32; depth++) {
      sourceCheck()
      check()
      const parentFrame = frameMap.get(childFrame.parentId)
      if (!parentFrame) break
      const childSessionID = contextMap.get(childFrame.id)?.sessionID ?? ""
      const childSession = sessions.capture(childSessionID)
      const childWorld =
        childFrame.id === entry.frame.id ? entry.world : ownerWorlds.get(`${childSessionID}:${childFrame.id}`)
      if (!childWorld) break
      const parentSessionID = contextMap.get(parentFrame.id)?.sessionID ?? ""
      const parentSession = sessions.capture(parentSessionID)
      let rootWorld = sessionRootWorlds.get(parentSessionID)
      if (!rootWorld) {
        const parentTree = (await parentSession.tree()) as Tree
        const world = (await send(entry, parentSession, check, "Page.createIsolatedWorld", {
          frameId: parentTree.frameTree.frame.id,
          worldName: "cm-browser-frame-root",
        })) as { executionContextId?: number }
        if (!Number.isInteger(world.executionContextId) || world.executionContextId === undefined) break
        rootWorld = world.executionContextId
        sessionRootWorlds.set(parentSessionID, rootWorld)
      }
      const key = `${parentSessionID}:${parentFrame.id}`
      let ownerWorld = ownerWorlds.get(key)
      if (!ownerWorld) {
        const world = (await send(entry, parentSession, check, "Page.createIsolatedWorld", {
          frameId: parentFrame.id,
          worldName: "cm-browser-frame-owner",
        })) as { executionContextId?: number }
        if (!Number.isInteger(world.executionContextId) || world.executionContextId === undefined) break
        ownerWorld = world.executionContextId
        ownerWorlds.set(key, ownerWorld)
      }
      const owner = (await send(entry, parentSession, check, "DOM.getFrameOwner", {
        frameId: childFrame.id,
      })) as { backendNodeId?: number }
      if (!Number.isInteger(owner.backendNodeId) || owner.backendNodeId === undefined) break
      const resolved = (await send(entry, parentSession, check, "DOM.resolveNode", {
        backendNodeId: owner.backendNodeId,
        executionContextId: ownerWorld,
        objectGroup: "cm-browser-frame-owners",
      })) as { object?: { objectId?: string } }
      if (!resolved.object?.objectId) break
      const pinned = (await send(entry, parentSession, check, "Runtime.callFunctionOn", {
        objectId: resolved.object.objectId,
        functionDeclaration: ownerFunction(true),
        returnByValue: true,
      })) as { result?: { value?: unknown }; exceptionDetails?: unknown }
      if (pinned.exceptionDetails || pinned.result?.value !== true) break
      owners.push({
        owner: resolved.object.objectId,
        session: parentSession,
        childSession,
        childWorld,
        rootWorld,
        backendNodeId: owner.backendNodeId,
        parent: parentFrame,
        child: childFrame,
      })
      childFrame = parentFrame
      if (childFrame.id === top.id) break
    }
    entry.owners = owners
    if (owners.length && owners[0].child.id === entry.frame.id) {
      entry.owner = owners[0].owner
      entry.ownerSession = owners[0].session
      entry.ownerBackendNodeId = owners[0].backendNodeId
    }
  }
  sourceCheck()
  check()
  if (allNativeFrames.length > MAX_EMBEDDED_DOCUMENTS)
    documents.push({
      frameRef: randomUUID(),
      origin: "",
      url: "",
      title: "",
      status: "truncated",
      reason: "document_count_limit",
    })
  const delivery = () => {
    sourceCheck()
    for (const entry of entries.values()) entry.check()
  }
  delivery()
  check()
  return {
    ...boundEmbeddedDocuments(documents, frames, maxBytes),
    check: delivery,
  }
}

export async function discoverFrames(tab: BrowserRegistration, check: () => void, allowed: (url: string) => boolean) {
  const discovered = await discoverDocuments(tab, check, allowed)
  return discovered && { frames: discovered.frames, check: discovered.check }
}

function collectFrames(node: FrameTree, result: Map<string, Frame>) {
  result.set(node.frame.id, node.frame)
  for (const child of node.childFrames ?? []) collectFrames(child, result)
}

function safeFrameURL(value: string) {
  if (value.length > 4096 || /[\u0000-\u001f\u007f]/.test(value)) return
  try {
    const url = new URL(value)
    if (["http:", "https:"].includes(url.protocol)) return `${url.origin}${url.pathname}`.slice(0, 512)
    if (["about:", "data:", "blob:", "file:"].includes(url.protocol))
      return url.protocol === "about:" ? value.slice(0, 256) : `${url.protocol}`
  } catch {}
}

function safeOrigin(value: string) {
  return value ? value.slice(0, 128) : "null"
}

export function boundEmbeddedDocuments(
  documents: NonNullable<BrowserState["documents"]>,
  frames: NonNullable<BrowserState["frames"]>,
  maxBytes: number,
) {
  const bounded = documents.map((document) => ({ ...document }))
  const size = () => Buffer.byteLength(JSON.stringify({ documents: bounded, frames }))
  while (size() > maxBytes) {
    const index = bounded.findLastIndex((document) =>
      Boolean(document.elements?.length || document.visibleText?.length),
    )
    if (index < 0) break
    const document = bounded[index]
    const elements = document.elements?.length ? document.elements.slice(0, -1) : document.elements
    const visibleText =
      !document.elements?.length && document.visibleText
        ? document.visibleText.slice(0, Math.floor(document.visibleText.length / 2))
        : document.visibleText
    bounded[index] = {
      ...document,
      status: "truncated",
      reason: "aggregate_transport_limit",
      ...(elements ? { elements } : {}),
      ...(visibleText !== undefined ? { visibleText } : {}),
    }
  }
  if (size() > maxBytes && bounded.length) {
    return {
      documents: bounded.map((document) => ({
        frameRef: document.frameRef,
        ...(document.parentFrameRef ? { parentFrameRef: document.parentFrameRef } : {}),
        origin: document.origin.slice(0, 64),
        url: document.url.slice(0, 64),
        title: "",
        status: ["excluded", "unsupported", "failed"].includes(document.status)
          ? document.status
          : ("truncated" as const),
        reason: ["excluded", "unsupported", "failed"].includes(document.status)
          ? document.reason
          : "document_inventory_transport_limit",
      })),
      frames: [],
    }
  }
  return { documents: bounded, frames }
}

// Native chooser IDs only. This owns separate worlds/object groups and never refreshes agent refs.
export async function bindFrameUpload(
  tab: BrowserRegistration,
  contents: WebContents,
  frameId: string,
  sessionID: string,
  backendNodeId: number,
  mode: string,
  check: (receiver?: string) => void,
) {
  const sessions = tab.frameSessions!
  const root = sessions.capture()
  const child = sessions.capture(sessionID)
  const group = `cm-upload-${randomUUID()}`
  let receiver: string | undefined
  const checked = () => {
    check(receiver)
    if (tab.frameSessions !== sessions) throw new Error("Browser frame session changed")
    root.check()
    child.check()
  }
  const command = async (session: Session, method: string, params: Record<string, unknown> = {}) => {
    checked()
    const result = await session.send(method, params)
    checked()
    return result
  }
  const dispose = async () => {
    // Release only this chooser's handles, even after revocation; never deliver files during cleanup.
    await Promise.all(
      [root, ...(sessionID ? [child] : [])].map(async (session) => {
        try {
          await contents.debugger.sendCommand(
            "Runtime.releaseObjectGroup",
            { objectGroup: group },
            session.sessionID || undefined,
          )
        } catch {}
      }),
    )
  }
  try {
    const top = ((await command(root, "Page.getFrameTree")) as Tree).frameTree.frame
    const tree = (await command(child, "Page.getFrameTree")) as Tree
    const frame = sessionID
      ? tree.frameTree.frame
      : tree.frameTree.childFrames?.find((row) => row.frame.id === frameId)?.frame
    if (
      !origin(top) ||
      top.url !== tab.contents.getURL() ||
      !frame ||
      frame.id !== frameId ||
      frame.parentId !== top.id ||
      !origin(frame)
    )
      throw new Error("Unsupported upload frame")
    receiver = frame.url
    checked()
    const parentWorld = (await command(root, "Page.createIsolatedWorld", {
      frameId: top.id,
      worldName: "cm-browser-upload-owner",
    })) as { executionContextId: number }
    const owner = (await command(root, "DOM.getFrameOwner", { frameId })) as { backendNodeId: number }
    const parent = (await command(root, "DOM.resolveNode", {
      backendNodeId: owner.backendNodeId,
      executionContextId: parentWorld.executionContextId,
      objectGroup: group,
    })) as { object?: { objectId?: string } }
    if (!parent.object?.objectId) throw new Error("Missing upload owner")
    const entry: Entry = { top, frame, root, child, owner: parent.object.objectId, check: checked }
    const visible = (await command(root, "Runtime.callFunctionOn", {
      objectId: entry.owner,
      functionDeclaration: ownerFunction(true),
      returnByValue: true,
    })) as { result?: { value?: unknown }; exceptionDetails?: unknown }
    if (visible.exceptionDetails || visible.result?.value !== true) throw new Error("Unsupported upload owner")
    const world = (await command(child, "Page.createIsolatedWorld", {
      frameId,
      worldName: "cm-browser-upload-input",
    })) as { executionContextId: number }
    if (!Number.isInteger(world.executionContextId)) throw new Error("Missing upload context")
    const input = (await command(child, "DOM.resolveNode", {
      backendNodeId,
      executionContextId: world.executionContextId,
      objectGroup: group,
    })) as { object?: { objectId?: string } }
    if (!input.object?.objectId) throw new Error("Missing upload input")
    const inputCheck = async (pin: boolean) => {
      const result = (await command(child, "Runtime.callFunctionOn", {
        objectId: input.object!.objectId,
        functionDeclaration: `function() {
          const el = this;
          if (!(el instanceof HTMLInputElement) || el.type !== "file" || el.ownerDocument !== document ||
              !el.isConnected || el.getRootNode() !== document || el.webkitdirectory || el.hasAttribute("directory") ||
              el.multiple !== ${mode === "selectMultiple"} || el.matches(":disabled") ||
              !el.checkVisibility({checkOpacity:true,checkVisibilityCSS:true})) return false;
          const chain = [];
          for (let node = el; node; node = node.parentNode) {
            if (chain.length >= 64 || (node instanceof Element && node.hasAttribute("inert"))) return false;
            chain.push(node);
          }
          const saved = globalThis.__cmUploadInputs ||= new WeakMap();
          if (${pin}) saved.set(el, {document, root:document.documentElement, chain});
          const old = saved.get(el), r = el.getBoundingClientRect();
          return !!old && old.document === document && old.root === document.documentElement &&
            old.chain.length === chain.length && chain.every((node,i) => node === old.chain[i]) &&
            r.width > 0 && r.height > 0 && r.left >= 0 && r.top >= 0 && r.right <= innerWidth &&
            r.bottom <= innerHeight && document.elementFromPoint(r.left+r.width/2,r.top+r.height/2) === el;
        }`,
        returnByValue: true,
      })) as { result?: { value?: unknown }; exceptionDetails?: unknown }
      if (result.exceptionDetails || result.result?.value !== true) throw new Error("Upload input changed")
    }
    await inputCheck(true)
    const validateInput = async () => {
      await validate(entry, checked)
      await inputCheck(false)
      checked()
    }
    await validateInput()
    return {
      topOrigin: top.securityOrigin,
      origin: frame.securityOrigin,
      dispose,
      validate: validateInput,
      async deliver(files: string[]) {
        await validateInput()
        await command(child, "DOM.setFileInputFiles", { objectId: input.object!.objectId, files })
        await validateInput()
      },
    }
  } catch (error) {
    await dispose()
    throw error
  }
}

export async function executeFrame(
  tab: BrowserRegistration,
  request: FrameRequest,
  authority: () => void,
  deadline: number,
  allowed: (url: string) => boolean,
  markDispatched?: () => void,
  markObservation?: () => void,
) {
  const { frameRef } = request
  const binding = request.op === "read_state" || request.op === "wait_for_element" ? request.frameContext : undefined
  const selector = request.op === "read_state" || request.op === "wait_for_element" ? request.selector : undefined
  const entry = refs.get(tab)?.get(frameRef)
  if (!entry) throw new Error("Unsupported or stale browser frame")
  const check = () => {
    authority()
    if (!allowed(entry.top.securityOrigin)) throw new Error("Browser top-level host blocked")
  }
  entry.check()
  check()
  if (request.op === "prepare_frame_input") {
    await validate(entry, check, true)
    const action = request.action
    if (action.op === "press_key") await frameHasFocus(tab, entry, check)
    if (action.op === "click" || action.op === "hover" || action.op === "fill") {
      if (!(await currentFrameElement(entry, check, action.ref, action.op === "fill")))
        throw new Error("Unsupported or stale browser frame reference")
    }
    if (action.op === "scroll" && action.ref && !(await currentFrameElement(entry, check, action.ref)))
      throw new Error("Unsupported or stale browser frame reference")
    if (action.op === "drag") {
      const source = frameRefParts(action.sourceRef)
      const target = frameRefParts(action.targetRef)
      if (!source || !target || source.id !== target.id)
        throw new Error("Unsupported or stale browser frame drag references")
      const stored = entry.snapshots?.get(source.id)
      const first = stored?.elements.find((element) => element.token === source.token)
      const second = stored?.elements.find((element) => element.token === target.token)
      if (!stored || !first || !second || first.token === second.token || stored.url !== entry.frame.url)
        throw new Error("Unsupported or stale browser frame drag references")
      const response = (await send(entry, entry.child, check, "Runtime.evaluate", {
        contextId: entry.world,
        expression: dragSnapshotScript(source.id, { generation: stored.generation, token: first.token }, second.token),
        returnByValue: true,
      })) as unknown
      const current = parseSnapshot(response)
      if (
        current?.generation !== stored.generation ||
        current.elements.length !== 2 ||
        current.elements.some((item) => item.disabled)
      )
        throw new Error("Unsupported or stale browser frame drag references")
    }
    if (action.op === "select_option") {
      const [id, token] = action.ref.split(":")
      const [optionID, optionToken] = action.optionRef.split(":")
      const page = entry.snapshots?.get(id)
      const select = page?.elements.find((element) => element.token === token && element.tag === "select")
      if (
        !page ||
        page.url !== entry.frame.url ||
        optionID !== id ||
        !select ||
        select.disabled ||
        !select.options?.some((option) => option.token === optionToken && !option.disabled)
      )
        throw new Error("Unsupported or stale frame selection")
    }
    const approval = randomUUID()
    entry.input = { approval, action }
    const frameContext: FrameContext = {
      frameRef,
      approval,
      topOrigin: entry.top.securityOrigin,
      origin: frameOrigin(entry.frame),
    }
    return {
      check: () => {
        check()
        entry.check()
      },
      response: success<BrowserState>({
        tabID: tab.id,
        frameRef,
        url: entry.top.securityOrigin,
        title: "",
        visibleText: "",
        elements: [],
        frameContext,
      }),
    }
  }
  if (request.op === "frame_input") {
    const pending = entry.input
    if (
      !pending ||
      pending.approval !== request.frameContext.approval ||
      request.frameContext.frameRef !== frameRef ||
      request.frameContext.topOrigin !== entry.top.securityOrigin ||
      request.frameContext.origin !== frameOrigin(entry.frame) ||
      JSON.stringify(pending.action) !== JSON.stringify(request.action)
    )
      throw new Error("Browser frame input approval changed")
    // A prepared action is single-use, even if any later native identity check fails.
    entry.input = undefined
    const action = request.action
    await validate(entry, check, true)
    const settle = async () => {
      await new Promise<void>((resolve) => setTimeout(resolve, Math.min(100, Math.max(0, deadline - Date.now()))))
      check()
      entry.check()
    }
    const observe = async () => {
      markObservation?.()
      await settle()
      const id = `frame.${randomUUID()}`
      const response = await send(entry, entry.child, check, "Runtime.evaluate", {
        contextId: entry.world,
        expression: snapshotScript(id),
        returnByValue: true,
        timeout: Math.max(1, deadline - Date.now()),
      })
      const page = parseSnapshot(response)
      if (!page || page.url !== entry.frame.url) throw new Error("Browser frame observation unavailable")
      await validate(entry, check, true)
      const snapshots = (entry.snapshots ??= new Map())
      snapshots.set(id, page)
      while (snapshots.size > 10) snapshots.delete(snapshots.keys().next().value!)
      return success<BrowserState>({
        tabID: tab.id,
        frameRef,
        url: page.url,
        title: page.title,
        visibleText: page.visibleText,
        truncated: page.truncated,
        elements: page.elements.map(({ token, rect: _rect, options, ...element }) => ({
          ...element,
          ref: `${id}:${token}`,
          ...(options
            ? {
                options: options.map(({ token: optionToken, ...option }) => ({
                  ...option,
                  ref: `${id}:${optionToken}`,
                })),
              }
            : {}),
        })),
      })
    }
    const inputEvent = (event: Parameters<WebContents["sendInputEvent"]>[0]) =>
      nativeInput(tab, check, markDispatched, event)
    if (action.op === "press_key") {
      await frameKeys(tab, entry, check, markDispatched, action.key, action.modifiers)
      return {
        check: () => {
          check()
          entry.check()
        },
        response: await observe(),
      }
    }
    if (action.op === "select_option") {
      const [id, token] = action.ref.split(":")
      const [optionID, optionToken] = action.optionRef.split(":")
      const page = entry.snapshots?.get(id)
      const select = page?.elements.find((element) => element.token === token && element.tag === "select")
      if (
        !entry.world ||
        !page ||
        optionID !== id ||
        !select ||
        select.disabled ||
        !select.options?.some((option) => option.token === optionToken && !option.disabled)
      )
        throw new Error("Unsupported or stale frame selection")
      markDispatched?.()
      const response = (await send(entry, entry.child, check, "Runtime.evaluate", {
        contextId: entry.world,
        expression: selectOptionScript(id, { generation: page.generation, token }, optionToken, deadline),
        returnByValue: true,
        timeout: Math.max(1, deadline - Date.now()),
      })) as { result?: { value?: unknown }; exceptionDetails?: unknown }
      if (response.exceptionDetails || response.result?.value !== true)
        throw new Error("Browser frame selection unavailable")
      return {
        check: () => {
          check()
          entry.check()
        },
        response: await observe(),
      }
    }
    if (action.op === "scroll") {
      const element = action.ref ? await currentFrameElement(entry, check, action.ref) : undefined
      if (action.ref && !element) throw new Error("Unsupported or stale browser frame reference")
      const metrics = (await send(entry, entry.child, check, "Runtime.evaluate", {
        contextId: entry.world,
        expression: "({width:innerWidth,height:innerHeight})",
        returnByValue: true,
      })) as { result?: { value?: { width?: number; height?: number } } }
      const width = metrics.result?.value?.width
      const height = metrics.result?.value?.height
      if (!Number.isFinite(width) || !Number.isFinite(height) || width! <= 0 || height! <= 0)
        throw new Error("Unsupported browser frame viewport")
      const x = element ? element.element.rect.x + element.element.rect.width / 2 : width! / 2
      const y = element ? element.element.rect.y + element.element.rect.height / 2 : height! / 2
      const point = await framePoint(entry, check, x, y)
      await inputEvent({ type: "mouseWheel", ...point, deltaX: action.deltaX, deltaY: action.deltaY })
      return {
        check: () => {
          check()
          entry.check()
        },
        response: await observe(),
      }
    }
    if (action.op === "click" || action.op === "hover" || action.op === "fill") {
      const releaseContextMenu =
        action.op === "click" && action.mode === "right" ? suppressBrowserContextMenu(tab.contents) : undefined
      try {
        const initial = await currentFrameElement(entry, check, action.ref, action.op === "fill")
        if (!initial) throw new Error("Unsupported or stale browser frame reference")
        const initialPoint = await framePoint(
          entry,
          check,
          initial.element.rect.x + initial.element.rect.width / 2,
          initial.element.rect.y + initial.element.rect.height / 2,
        )
        await inputEvent({ type: "mouseMove", ...initialPoint })
        if (action.op === "hover")
          return {
            check: () => {
              check()
              entry.check()
            },
            response: await observe(),
          }
        const current = await currentFrameElement(entry, check, action.ref, action.op === "fill")
        if (
          !current ||
          current.element.rect.x + current.element.rect.width / 2 !==
            initial.element.rect.x + initial.element.rect.width / 2 ||
          current.element.rect.y + current.element.rect.height / 2 !==
            initial.element.rect.y + initial.element.rect.height / 2
        )
          throw new Error("Browser frame target changed after hover")
        const click = async (point: { x: number; y: number }, button: "left" | "right", clickCount: number) => {
          check()
          await inputEvent({ type: "mouseDown", ...point, button, clickCount })
          await inputEvent({ type: "mouseUp", ...point, button, clickCount })
        }
        const point = await framePoint(
          entry,
          check,
          current.element.rect.x + current.element.rect.width / 2,
          current.element.rect.y + current.element.rect.height / 2,
        )
        await click(point, action.op === "click" && action.mode === "right" ? "right" : "left", 1)
        if (action.op === "click" && action.mode === "double") {
          const second = await currentFrameElement(entry, check, action.ref)
          if (
            !second ||
            second.element.rect.x + second.element.rect.width / 2 !==
              current.element.rect.x + current.element.rect.width / 2 ||
            second.element.rect.y + second.element.rect.height / 2 !==
              current.element.rect.y + current.element.rect.height / 2
          )
            throw new Error("Browser frame target changed after click")
          await click(point, "left", 2)
        }
        if (action.op === "fill") {
          if (!(await currentFrameElement(entry, check, action.ref, true, true)))
            throw new Error("Browser frame input did not receive focus")
          const selectAll = process.platform === "darwin" ? "Meta" : "Ctrl"
          await frameKeys(tab, entry, check, markDispatched, "a", [selectAll], action.ref)
          await frameKeys(tab, entry, check, markDispatched, "Backspace", [], action.ref)
          if (action.text) {
            const focusedFrame = await frameHasFocus(tab, entry, check, action.ref)
            if (!(await currentFrameElement(entry, check, action.ref, true, true)))
              throw new Error("Browser frame input focus changed")
            check()
            markDispatched?.()
            await send(entry, entry.root, check, "Input.insertText", { text: action.text })
            check()
            entry.check()
            const currentFocusedFrame = (tab.contents as WebContents).focusedFrame
            if (
              !currentFocusedFrame ||
              currentFocusedFrame.detached ||
              !sameNativeFrame(nativeFrameIdentity(currentFocusedFrame), focusedFrame) ||
              !(await currentFrameElement(entry, check, action.ref, true, true))
            )
              throw new Error("Browser native frame focus changed")
          }
        }
        return {
          check: () => {
            check()
            entry.check()
          },
          response: await observe(),
        }
      } finally {
        releaseContextMenu?.()
      }
    }
    if (action.op === "drag") {
      const source = await currentFrameElement(entry, check, action.sourceRef)
      const target = await currentFrameElement(entry, check, action.targetRef)
      if (!source || !target) throw new Error("Unsupported or stale browser frame drag references")
      const center = (element: typeof source.element) => ({
        x: element.rect.x + element.rect.width / 2,
        y: element.rect.y + element.rect.height / 2,
      })
      const sameCenter = (left: ReturnType<typeof center>, right: ReturnType<typeof center>) =>
        Math.abs(left.x - right.x) <= 1 && Math.abs(left.y - right.y) <= 1
      const samePoint = (left: { x: number; y: number }, right: { x: number; y: number }) =>
        Math.abs(left.x - right.x) <= 1 && Math.abs(left.y - right.y) <= 1
      const mapCenter = (element: typeof source.element) => {
        const point = center(element)
        return framePoint(entry, check, point.x, point.y)
      }
      const sourceCenter = center(source.element)
      const targetCenter = center(target.element)
      const start = await framePoint(entry, check, sourceCenter.x, sourceCenter.y)
      const end = await framePoint(entry, check, targetCenter.x, targetCenter.y)
      await inputEvent({ type: "mouseMove", ...start })
      const hoveredSource = await currentFrameElement(entry, check, action.sourceRef)
      const hoveredTarget = await currentFrameElement(entry, check, action.targetRef)
      if (
        !hoveredSource ||
        !hoveredTarget ||
        !sameCenter(center(hoveredSource.element), sourceCenter) ||
        !sameCenter(center(hoveredTarget.element), targetCenter) ||
        !samePoint(await mapCenter(hoveredSource.element), start) ||
        !samePoint(await mapCenter(hoveredTarget.element), end)
      )
        throw new Error("Browser frame drag target changed before press")
      await inputEvent({ type: "mouseDown", ...start, button: "left", clickCount: 1 })
      for (const fraction of [0.25, 0.5, 0.75, 1]) {
        const currentTarget = await currentFrameElement(entry, check, action.targetRef)
        if (
          !currentTarget ||
          !sameCenter(center(currentTarget.element), targetCenter) ||
          !samePoint(await mapCenter(currentTarget.element), end)
        )
          throw new Error("Browser frame drag destination changed")
        await inputEvent({
          type: "mouseMove",
          x: Math.round(start.x + (end.x - start.x) * fraction),
          y: Math.round(start.y + (end.y - start.y) * fraction),
          button: "left",
        })
      }
      await inputEvent({ type: "mouseUp", ...end, button: "left", clickCount: 1 })
      return {
        check: () => {
          check()
          entry.check()
        },
        response: await observe(),
      }
    }
    throw new Error("Unsupported browser frame input")
  }
  if (request.op === "prepare_frame_select" || request.op === "select_option") {
    const [id, token] = request.ref.split(":")
    const [optionID, optionToken] = request.optionRef.split(":")
    const page = entry.snapshots?.get(id)
    const select = page?.elements.find((element) => element.token === token && element.tag === "select")
    if (
      !entry.world ||
      !page ||
      optionID !== id ||
      page.url !== entry.frame.url ||
      !select ||
      select.disabled ||
      !select.options?.some((option) => option.token === optionToken && !option.disabled)
    )
      throw new Error("Unsupported or stale frame selection")
    const selected = request.op === "select_option" ? request.frameSelectContext : undefined
    if (
      selected &&
      (!entry.selection ||
        selected.approval !== entry.selection.approval ||
        selected.op !== entry.selection.op ||
        selected.frameRef !== frameRef ||
        selected.ref !== request.ref ||
        selected.optionRef !== request.optionRef ||
        selected.ref !== entry.selection.ref ||
        selected.optionRef !== entry.selection.optionRef ||
        selected.topOrigin !== entry.top.securityOrigin ||
        selected.origin !== frameOrigin(entry.frame))
    )
      throw new Error("Browser frame selection approval changed")
    // Consume before any await: failed or interrupted selections never reuse this binding.
    if (selected) entry.selection = undefined
    await validate(entry, check, true)
    if (!selected) {
      entry.selection = {
        op: "select_option",
        frameRef,
        ref: request.ref,
        optionRef: request.optionRef,
        approval: randomUUID(),
        topOrigin: entry.top.securityOrigin,
        origin: frameOrigin(entry.frame),
      }
      return {
        check: () => {
          check()
          entry.check()
        },
        response: success<BrowserState>({
          tabID: tab.id,
          frameRef,
          url: entry.top.securityOrigin,
          title: "",
          visibleText: "",
          elements: [],
          frameSelectContext: entry.selection,
        }),
      }
    }
    markDispatched?.()
    const response = (await send(entry, entry.child, check, "Runtime.evaluate", {
      contextId: entry.world,
      expression: selectOptionScript(id, { generation: page.generation, token }, optionToken, deadline),
      returnByValue: true,
      timeout: Math.max(1, deadline - Date.now()),
    })) as { result?: { value?: unknown }; exceptionDetails?: unknown }
    if (response.exceptionDetails || response.result?.value !== true)
      throw new Error("Browser frame selection unavailable")
    await validate(entry, check)
    return {
      check: () => {
        check()
        entry.check()
      },
      response: success<BrowserState>({
        tabID: tab.id,
        frameRef,
        url: frameOrigin(entry.frame),
        title: "",
        visibleText: "",
        elements: [],
      }),
    }
  }
  if (
    binding &&
    (binding.approval !== entry.approval ||
      binding.frameRef !== frameRef ||
      binding.topOrigin !== entry.top.securityOrigin ||
      binding.origin !== frameOrigin(entry.frame) ||
      !entry.world)
  )
    throw new Error("Browser frame approval changed")
  await validate(entry, check)
  if (!binding) {
    const world = (await send(entry, entry.child, check, "Page.createIsolatedWorld", {
      frameId: entry.frame.id,
      worldName: "cm-browser-frame-read",
    })) as { executionContextId: number }
    if (!Number.isInteger(world.executionContextId)) throw new Error("Unsupported frame context")
    entry.world = world.executionContextId
    entry.approval = randomUUID()
    // Pin document identity across the private preparation/read round trip.
    const pinned = (await send(entry, entry.child, check, "Runtime.evaluate", {
      contextId: entry.world,
      expression: `globalThis.__cmFrameDocument = {document, root:document.documentElement, approval:${JSON.stringify(entry.approval)}}; true`,
      returnByValue: true,
      timeout: Math.max(1, deadline - Date.now()),
    })) as { result?: { value?: unknown }; exceptionDetails?: unknown }
    if (pinned.exceptionDetails || pinned.result?.value !== true) throw new Error("Frame document unavailable")
    return {
      check: () => {
        check()
        entry.check()
      },
      response: success<BrowserState>({
        tabID: tab.id,
        url: entry.top.securityOrigin,
        title: "",
        visibleText: "",
        elements: [],
        frameContext: {
          frameRef,
          approval: entry.approval,
          topOrigin: entry.top.securityOrigin,
          origin: frameOrigin(entry.frame),
        },
      }),
    }
  }
  entry.approval = undefined
  if (request.op === "wait_for_element") {
    const condition = request.condition ?? "visible"
    while (Date.now() < deadline) {
      const response = (await send(entry, entry.child, check, "Runtime.evaluate", {
        contextId: entry.world,
        expression: `(() => { const p = globalThis.__cmFrameDocument; if (!p || p.document !== document || p.root !== document.documentElement || p.approval !== ${JSON.stringify(binding.approval)}) return false; return ${browserConditionScript(request.selector, condition, deadline)}; })()`,
        returnByValue: true,
        awaitPromise: true,
        timeout: Math.max(1, deadline - Date.now()),
      })) as { result?: { value?: unknown }; exceptionDetails?: unknown }
      await validate(entry, check)
      if (response.exceptionDetails) throw new Error("Browser frame wait unavailable")
      if (response.result?.value === true) break
      await new Promise((resolve) => setTimeout(resolve, Math.min(100, Math.max(0, deadline - Date.now()))))
      check()
    }
    if (Date.now() >= deadline) throw new Error("Browser frame wait timed out")
  }
  const id = `frame.${randomUUID()}`
  const page = parseSnapshot(
    await send(entry, entry.child, check, "Runtime.evaluate", {
      contextId: entry.world,
      expression: `(() => { const p = globalThis.__cmFrameDocument; if (!p || p.document !== document || p.root !== document.documentElement || p.approval !== ${JSON.stringify(binding.approval)} || Date.now() >= ${deadline}) return null; return ${snapshotScript(id, undefined, selector)}; })()`,
      returnByValue: true,
      timeout: Math.max(1, deadline - Date.now()),
    }),
  )
  if (!page || page.url !== entry.frame.url) throw new Error("Browser frame snapshot unavailable")
  await validate(entry, check)
  // Match the isolated world's ten-snapshot bound; these refs never enter the top driver's store.
  const snapshots = (entry.snapshots ??= new Map())
  snapshots.set(id, page)
  while (snapshots.size > 10) snapshots.delete(snapshots.keys().next().value!)
  return {
    check: () => {
      check()
      entry.check()
    },
    response: success<BrowserState>({
      tabID: tab.id,
      frameRef,
      url: page.url,
      title: page.title,
      visibleText: page.visibleText,
      truncated: page.truncated,
      ...(page.inspection ? { inspection: page.inspection } : {}),
      ...(request.op === "wait_for_element"
        ? { observedCondition: { selector: request.selector, condition: request.condition ?? "visible" } }
        : {}),
      elements: page.elements.map(({ token, rect: _rect, options, ...element }) => ({
        ...element,
        ref: `${id}:${token}`,
        ...(options ? { options: options.map(({ token, ...option }) => ({ ...option, ref: `${id}:${token}` })) } : {}),
      })),
    }),
  }
}
