import {
  MAX_SNAPSHOT_BYTES,
  failure,
  success,
  type BrowserState,
  type Modifier,
  type Request,
  type Response,
} from "@cookiemonster/cm-browser/protocol"
import { parseSnapshot, snapshotScript, type PageSnapshot, type SnapshotElement } from "./snapshot"

export type DriverContents = {
  isDestroyed(): boolean
  getURL(): string
  loadURL(url: string): Promise<void>
  debugger: {
    isAttached(): boolean
    attach(version?: string): void
    sendCommand(method: string, params?: Record<string, unknown>): Promise<unknown>
  }
}

export type Target = { readonly contents: DriverContents }

type StoredSnapshot = { readonly id: string; readonly page: PageSnapshot }
const histories = new WeakMap<object, { sequence: number; snapshots: Map<string, StoredSnapshot> }>()

const KEYS: Record<string, { key: string; code: string; keyCode: number; text?: string }> = {
  enter: { key: "Enter", code: "Enter", keyCode: 13, text: "\r" },
  tab: { key: "Tab", code: "Tab", keyCode: 9 },
  escape: { key: "Escape", code: "Escape", keyCode: 27 },
  backspace: { key: "Backspace", code: "Backspace", keyCode: 8 },
  delete: { key: "Delete", code: "Delete", keyCode: 46 },
  arrowup: { key: "ArrowUp", code: "ArrowUp", keyCode: 38 },
  arrowdown: { key: "ArrowDown", code: "ArrowDown", keyCode: 40 },
  arrowleft: { key: "ArrowLeft", code: "ArrowLeft", keyCode: 37 },
  arrowright: { key: "ArrowRight", code: "ArrowRight", keyCode: 39 },
  pageup: { key: "PageUp", code: "PageUp", keyCode: 33 },
  pagedown: { key: "PageDown", code: "PageDown", keyCode: 34 },
  home: { key: "Home", code: "Home", keyCode: 36 },
  end: { key: "End", code: "End", keyCode: 35 },
}

const modifierMask = (modifiers: readonly Modifier[]) =>
  modifiers.reduce((mask, modifier) => mask | { Alt: 1, Ctrl: 2, Meta: 4, Shift: 8 }[modifier], 0)

function attach(contents: DriverContents) {
  if (!contents.debugger.isAttached()) contents.debugger.attach("1.3")
}

const evaluate = (contents: DriverContents) =>
  contents.debugger.sendCommand("Runtime.evaluate", {
    expression: snapshotScript(),
    returnByValue: true,
    awaitPromise: true,
  })

async function capture(target: Target) {
  return parseSnapshot(await evaluate(target.contents))
}

function publicState(target: Target, page: PageSnapshot): BrowserState {
  const history = histories.get(target.contents) ?? { sequence: 0, snapshots: new Map() }
  const id = `s${(++history.sequence).toString(36)}`
  history.snapshots.set(id, { id, page })
  while (history.snapshots.size > 10) history.snapshots.delete(history.snapshots.keys().next().value!)
  histories.set(target.contents, history)

  const state: BrowserState = {
    url: page.url,
    title: page.title,
    visibleText: page.visibleText,
    elements: page.elements.map((element, index) => ({
      ref: `${id}:e${index.toString(36)}`,
      tag: element.tag,
      role: element.role,
      label: element.label,
      text: element.text,
    })),
  }
  if (Buffer.byteLength(JSON.stringify(state)) <= MAX_SNAPSHOT_BYTES) return state
  return { ...state, elements: state.elements.slice(0, 100), visibleText: state.visibleText.slice(0, 8_000) }
}

async function refreshed(target: Target): Promise<Response<BrowserState>> {
  const page = await capture(target)
  if (!page) return failure("unavailable", "The page did not return a usable snapshot.")
  return success(publicState(target, page))
}

async function dispatchClick(target: Target, element: SnapshotElement) {
  const x = element.rect.x + element.rect.width / 2
  const y = element.rect.y + element.rect.height / 2
  const base = { x, y, button: "left" as const, buttons: 1, clickCount: 1 }
  await target.contents.debugger.sendCommand("Input.dispatchMouseEvent", { ...base, type: "mouseMoved", buttons: 0 })
  await target.contents.debugger.sendCommand("Input.dispatchMouseEvent", { ...base, type: "mousePressed" })
  await target.contents.debugger.sendCommand("Input.dispatchMouseEvent", { ...base, type: "mouseReleased", buttons: 0 })
}

async function dispatchKey(target: Target, key: string, modifiers: readonly Modifier[] = []) {
  const mapped =
    KEYS[key.trim().toLowerCase()] ??
    (Array.from(key).length === 1
      ? { key, code: "", keyCode: key.toUpperCase().codePointAt(0) ?? 0, text: modifiers.length ? undefined : key }
      : undefined)
  if (!mapped) return false
  const params = {
    key: mapped.key,
    code: mapped.code,
    windowsVirtualKeyCode: mapped.keyCode,
    modifiers: modifierMask(modifiers),
  }
  await target.contents.debugger.sendCommand("Input.dispatchKeyEvent", {
    ...params,
    type: "keyDown",
    text: mapped.text,
  })
  await target.contents.debugger.sendCommand("Input.dispatchKeyEvent", { ...params, type: "keyUp" })
  return true
}

async function resolveRef(target: Target, ref: string) {
  const match = /^([^:]+):e([0-9a-z]+)$/.exec(ref)
  if (!match) return
  const stored = histories.get(target.contents)?.snapshots.get(match[1])
  const index = Number.parseInt(match[2], 36)
  const expected = stored?.page.elements[index]
  if (!stored || !expected || target.contents.getURL() !== stored.page.url) return
  const current = await capture(target)
  const actual = current?.url === stored.page.url ? current.elements[index] : undefined
  if (!actual || actual.fingerprint !== expected.fingerprint) return
  return actual
}

const settle = () => new Promise((resolve) => setTimeout(resolve, 100))

export async function execute(target: Target, request: Request): Promise<Response<BrowserState>> {
  if (target.contents.isDestroyed()) return failure("detached", "The browser panel view is no longer available.")
  attach(target.contents)

  if (request.op === "read_state") return refreshed(target)
  if (request.op === "navigate") {
    await target.contents.loadURL(request.url)
    return refreshed(target)
  }
  if (request.op === "press_key") {
    if (!(await dispatchKey(target, request.key, request.modifiers)))
      return failure("bad_request", `Unsupported key: ${request.key}.`)
    await settle()
    return refreshed(target)
  }

  const element = await resolveRef(target, request.ref)
  if (!element) return failure("stale_ref", `Element ref ${request.ref} is stale. Read browser state again.`)
  await dispatchClick(target, element)

  if (request.op === "fill") {
    await dispatchKey(target, "a", ["Ctrl"])
    await dispatchKey(target, "Backspace")
    for (const character of request.text) await dispatchKey(target, character)
  }

  await settle()
  return refreshed(target)
}
