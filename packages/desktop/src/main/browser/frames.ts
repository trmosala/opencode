import { randomUUID } from "node:crypto"
import type { WebContents } from "electron"
import {
  success,
  type BrowserState,
  type FrameRequest,
  type FrameSelectContext,
} from "@cookiemonster/cm-browser/protocol"
import { browserAgentEnabled, browserRegistration, type BrowserRegistration } from "./registry"
import { browserInputFailure } from "./driver"
import { hostPolicyRevision } from "./allowlist"
import { parseSnapshot, snapshotScript, selectOptionScript, type PageSnapshot } from "./snapshot"

type Frame = { id: string; parentId?: string; loaderId: string; url: string; securityOrigin: string }
type Tree = { frameTree: { frame: Frame; childFrames?: { frame: Frame }[] } }
type Session = ReturnType<NonNullable<BrowserRegistration["frameSessions"]>["capture"]>
type Entry = {
  frame: Frame
  top: Frame
  root: Session
  child: Session
  owner: string
  check: () => void
  world?: number
  approval?: string
  snapshots?: Map<string, PageSnapshot>
  selection?: FrameSelectContext
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

// No child document access. Conservative full-owner visibility: overlapping elements, clipping,
// transformed geometry, shadow owners and generated ancestor content are unsupported.
const ownerFunction = (pin: boolean) => `function() {
  const node = this, doc = document, root = document.documentElement;
  if (!(node instanceof HTMLIFrameElement) || node.getRootNode() !== doc || !node.isConnected ||
      node.hasAttribute("sandbox") || node.hasAttribute("srcdoc") || !/^https?:/.test(node.src)) return false;
  const chain = [];
  for (let el = node; el; el = el.parentElement) {
    if (chain.length >= 64) return false;
    chain.push(el);
    const css = getComputedStyle(el);
    // ponytail: reject paint containment until full containment clipping is modeled.
    if (css.contain.split(" ").some(value => ["paint", "content", "strict"].includes(value)) ||
        css.contentVisibility !== "visible") return false;
    if (css.transform !== "none" || css.perspective !== "none" || css.rotate !== "none" ||
        css.scale !== "none" || css.translate !== "none" || !["1", "normal"].includes(css.zoom) ||
        css.clip !== "auto" || css.clipPath !== "none" || css.maskImage !== "none" || css.filter !== "none" ||
        Number(css.opacity) !== 1 || el.hasAttribute("inert") ||
        ["::before", "::after"].some(p => !["none", "normal"].includes(getComputedStyle(el,p).content))) return false;
  }
  const state = globalThis.__cmFrameOwners ||= new WeakMap();
  const stored = state.get(node);
  if (${pin}) state.set(node, { doc, root, chain });
  else if (!stored || stored.doc !== doc || stored.root !== root ||
    chain.length !== stored.chain.length || chain.some((el,i) => el !== stored.chain[i])) return false;
  const r = node.getBoundingClientRect();
  if (!node.checkVisibility({checkOpacity:true,checkVisibilityCSS:true}) || r.width <= 0 || r.height <= 0 ||
      r.left < 0 || r.top < 0 || r.right > innerWidth || r.bottom > innerHeight) return false;
  for (const el of chain.slice(1)) {
    const css = getComputedStyle(el), a = el.getBoundingClientRect();
    if ((css.overflowX !== "visible" || css.overflowY !== "visible") &&
      (r.left < a.left + el.clientLeft || r.top < a.top + el.clientTop ||
       r.right > a.left + el.clientLeft + el.clientWidth ||
       r.bottom > a.top + el.clientTop + el.clientHeight)) return false;
  }
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_ELEMENT);
  let count = 0;
  for (let el = walker.currentNode; el; el = walker.nextNode()) {
    if (++count > 4000) return false;
    if (chain.includes(el) || !el.checkVisibility({checkOpacity:true,checkVisibilityCSS:true})) continue;
    const a = el.getBoundingClientRect();
    if (a.width > 0 && a.height > 0 && a.left < r.right && a.right > r.left && a.top < r.bottom && a.bottom > r.top) return false;
  }
  return document.elementFromPoint(r.left+r.width/2,r.top+r.height/2) === node;
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

async function validate(entry: Entry, check: () => void) {
  const top = (await send(entry, entry.root, check, "Page.getFrameTree")) as Tree
  const tree = entry.child.sessionID ? ((await send(entry, entry.child, check, "Page.getFrameTree")) as Tree) : top
  const frame = entry.child.sessionID
    ? tree.frameTree.frame
    : tree.frameTree.childFrames?.find((row) => row.frame.id === entry.frame.id)?.frame
  if (!same(top.frameTree.frame, entry.top) || !same(frame, entry.frame))
    throw new Error("Browser frame document changed")
  const result = (await send(entry, entry.root, check, "Runtime.callFunctionOn", {
    objectId: entry.owner,
    functionDeclaration: ownerFunction(false),
    returnByValue: true,
  })) as { result?: { value?: unknown }; exceptionDetails?: unknown }
  if (result.exceptionDetails || result.result?.value !== true) throw new Error("Unsupported browser frame owner")
}

export async function discoverFrames(tab: BrowserRegistration, check: () => void, allowed: (url: string) => boolean) {
  const sessions = tab.frameSessions
  check()
  if (!sessions || sessions.overflowed()) return undefined
  const hosts = hostPolicyRevision()
  const root = sessions.capture()
  const top = ((await root.tree()) as Tree).frameTree.frame
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
      hostPolicyRevision() !== hosts ||
      browserRegistration(source.task, tab.id) !== tab ||
      tab.contents !== source.contents ||
      tab.ownerID !== source.owner ||
      tab.revision !== source.revision ||
      (tab.accessRevision ?? 0) !== source.access ||
      !tab.agentAccess ||
      !browserAgentEnabled() ||
      browserInputFailure(tab.contents) ||
      tab.contents.getURL() !== top.url ||
      !allowed(top.url)
    )
      throw new Error("Browser frame access changed")
  }
  sourceCheck()
  const world = (await root.send("Page.createIsolatedWorld", {
    frameId: top.id,
    worldName: "cm-browser-frame-owner",
  })) as { executionContextId: number }
  sourceCheck()
  check()
  if (!Number.isInteger(world.executionContextId)) throw new Error("Unsupported frame owner context")
  await root.send("Runtime.releaseObjectGroup", { objectGroup: "cm-browser-frame-owners" })
  sourceCheck()
  check()
  const entries = new Map<string, Entry>()
  refs.set(tab, entries)
  // Only direct children are considered; native context/frame IDs, never URLs, map CDP sessions.
  const contexts = sessions
    .list()
    .filter((context) => context.frameId !== top.id)
    .slice(0, 32)
  for (const context of contexts) {
    sourceCheck()
    check()
    const child = sessions.capture(context.sessionID)
    const tree = (await child.tree()) as Tree
    sourceCheck()
    check()
    const frame = context.sessionID
      ? tree.frameTree.frame
      : tree.frameTree.childFrames?.find((row) => row.frame.id === context.frameId)?.frame
    if (!frame || frame.id !== context.frameId || frame.parentId !== top.id || !origin(frame) || !allowed(frame.url))
      continue
    const mapped = sessions.context(frame.id)
    const bindingCheck = () => {
      sourceCheck()
      child.check()
      mapped.check()
      if (!allowed(frame.url) || !allowed(frame.securityOrigin)) throw new Error("Browser receiver host blocked")
    }
    bindingCheck()
    const owner = (await root.send("DOM.getFrameOwner", { frameId: frame.id })) as { backendNodeId: number }
    bindingCheck()
    check()
    if (!Number.isInteger(owner.backendNodeId)) continue
    const node = (await root.send("DOM.resolveNode", {
      backendNodeId: owner.backendNodeId,
      executionContextId: world.executionContextId,
      objectGroup: "cm-browser-frame-owners",
    })) as { object?: { objectId?: string } }
    bindingCheck()
    check()
    if (!node.object?.objectId) continue
    const visible = (await root.send("Runtime.callFunctionOn", {
      objectId: node.object.objectId,
      functionDeclaration: ownerFunction(true),
      returnByValue: true,
    })) as { result?: { value?: unknown }; exceptionDetails?: unknown }
    bindingCheck()
    check()
    if (visible.exceptionDetails || visible.result?.value !== true) continue
    const ref = randomUUID()
    entries.set(ref, { frame, top, root, child, owner: node.object.objectId, check: bindingCheck })
  }
  const delivery = () => {
    sourceCheck()
    for (const entry of entries.values()) entry.check()
  }
  delivery()
  check()
  return {
    frames: [...entries].map(([frameRef, entry]) => ({ frameRef, origin: entry.frame.securityOrigin })),
    check: delivery,
  }
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
) {
  const { frameRef } = request
  const binding = request.op === "read_state" ? request.frameContext : undefined
  const entry = refs.get(tab)?.get(frameRef)
  if (!entry) throw new Error("Unsupported or stale browser frame")
  const check = () => {
    authority()
    if (!allowed(entry.top.securityOrigin) || !allowed(entry.frame.url) || !allowed(entry.frame.securityOrigin))
      throw new Error("Browser receiver host blocked")
  }
  entry.check()
  check()
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
        selected.origin !== entry.frame.securityOrigin)
    )
      throw new Error("Browser frame selection approval changed")
    // Consume before any await: failed or interrupted selections are never retried with the same consent.
    if (selected) entry.selection = undefined
    await validate(entry, check)
    if (!selected) {
      entry.selection = {
        op: "select_option",
        frameRef,
        ref: request.ref,
        optionRef: request.optionRef,
        approval: randomUUID(),
        topOrigin: entry.top.securityOrigin,
        origin: entry.frame.securityOrigin,
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
        url: entry.frame.securityOrigin,
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
      binding.origin !== entry.frame.securityOrigin ||
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
    // Metadata identity only: no text, attributes, field values or child snapshot before approval.
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
          origin: entry.frame.securityOrigin,
        },
      }),
    }
  }
  entry.approval = undefined
  const id = `frame.${randomUUID()}`
  const page = parseSnapshot(
    await send(entry, entry.child, check, "Runtime.evaluate", {
      contextId: entry.world,
      expression: `(() => { const p = globalThis.__cmFrameDocument; if (!p || p.document !== document || p.root !== document.documentElement || p.approval !== ${JSON.stringify(binding.approval)} || Date.now() >= ${deadline}) return null; return ${snapshotScript(id)}; })()`,
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
      elements: page.elements.map(({ token, rect, options, ...element }) => ({
        ...element,
        ref: `${id}:${token}`,
        ...(options ? { options: options.map(({ token, ...option }) => ({ ...option, ref: `${id}:${token}` })) } : {}),
      })),
    }),
  }
}
