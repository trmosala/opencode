import { randomUUID } from "node:crypto"
import { setTimeout } from "node:timers/promises"
import {
  MAX_SNAPSHOT_BYTES,
  OPERATION_TIMEOUT_MS,
  failure,
  success,
  type BrowserState,
  type Modifier,
  type PageRequest,
  type Response,
} from "@cookiemonster/cm-browser/protocol"
import { parseSnapshot, snapshotScript, type PageSnapshot, type SnapshotElement } from "./snapshot"
import { nativeT } from "../native-translations"

export type DriverContents = {
  backgroundThrottling?: boolean
  isDestroyed(): boolean
  isLoadingMainFrame(): boolean
  getURL(): string
  loadURL(url: string): Promise<void>
  stop(): void
  debugger: {
    isAttached(): boolean
    attach(version?: string): void
    sendCommand(method: string, params?: Record<string, unknown>): Promise<unknown>
  }
}

export type Target = {
  readonly tabID: string
  readonly contents: DriverContents
  readonly check?: (source?: boolean) => void
  readonly signal?: AbortSignal
  readonly deadline?: number
}

function check(target: Target, source = false) {
  target.signal?.throwIfAborted()
  if (Date.now() >= (target.deadline ?? Infinity)) throw new DOMException("Browser operation timed out", "TimeoutError")
  target.check?.(source)
}

export function invalidateSnapshots(contents: DriverContents) {
  histories.delete(contents)
}

// ponytail: input pairs are serial; an uncertain down quarantines this WebContents for its lifetime.
// Never synthesize a release after revocation: keyUp/mouseReleased can trigger page actions.
const inputDown = new WeakSet<DriverContents>()

export function browserInputFailure(contents: DriverContents) {
  if (!inputDown.has(contents)) return undefined
  return failure("unavailable", nativeT("desktop.browser.driver.inputHeld"))
}

async function send(target: Target, method: string, params?: Record<string, unknown>) {
  check(target)
  if (target.contents.isLoadingMainFrame()) throw new Error("Browser page is loading")
  const input = method === "Input.dispatchKeyEvent" || method === "Input.dispatchMouseEvent"
  if (input && (params?.type === "keyDown" || params?.type === "mousePressed")) inputDown.add(target.contents)
  const result = await target.contents.debugger.sendCommand(method, params)
  if (input && (params?.type === "keyUp" || params?.type === "mouseReleased")) inputDown.delete(target.contents)
  check(target)
  if (target.contents.isLoadingMainFrame()) throw new Error("Browser page is loading")
  return result
}

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

async function capture(target: Target) {
  const page = parseSnapshot(
    await send(target, "Runtime.evaluate", {
      expression: snapshotScript(),
      returnByValue: true,
      awaitPromise: true,
    }),
  )
  if (!page || page.url !== target.contents.getURL()) return
  return page
}

function publicState(target: Target, page: PageSnapshot): BrowserState {
  const history = histories.get(target.contents) ?? { sequence: 0, snapshots: new Map() }
  const id = `${target.tabID}.${randomUUID()}`
  history.snapshots.set(id, { id, page })
  while (history.snapshots.size > 10) history.snapshots.delete(history.snapshots.keys().next().value!)
  histories.set(target.contents, history)

  const state: BrowserState = {
    tabID: target.tabID,
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
  await send(target, "Input.dispatchMouseEvent", { ...base, type: "mouseMoved", buttons: 0 })
  await send(target, "Input.dispatchMouseEvent", { ...base, type: "mousePressed" })
  await send(target, "Input.dispatchMouseEvent", { ...base, type: "mouseReleased", buttons: 0 })
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
  await send(target, "Input.dispatchKeyEvent", {
    ...params,
    type: "keyDown",
    text: mapped.text,
  })
  await send(target, "Input.dispatchKeyEvent", { ...params, type: "keyUp" })
  return true
}

async function resolveRef(target: Target, ref: string) {
  const match = /^([^:]+):e([0-9a-z]+)$/.exec(ref)
  if (!match || !match[1].startsWith(`${target.tabID}.`)) return
  const stored = histories.get(target.contents)?.snapshots.get(match[1])
  const index = Number.parseInt(match[2], 36)
  const expected = stored?.page.elements[index]
  if (!stored || !expected || target.contents.getURL() !== stored.page.url) return
  const current = await capture(target)
  const actual = current?.url === stored.page.url ? current.elements[index] : undefined
  if (!actual || actual.fingerprint !== expected.fingerprint) return
  return actual
}

async function settle(target: Target) {
  check(target)
  await setTimeout(Math.min(100, Math.max(0, (target.deadline ?? Infinity) - Date.now())), undefined, {
    signal: target.signal,
  })
  check(target)
}

export async function execute(target: Target, request: PageRequest): Promise<Response<BrowserState>> {
  target = {
    ...target,
    deadline: Math.min(
      target.deadline ?? Infinity,
      Date.now() + ("timeoutMs" in request ? (request.timeoutMs ?? OPERATION_TIMEOUT_MS) : OPERATION_TIMEOUT_MS),
    ),
  }
  if (request.tabID !== target.tabID) return failure("no_target", "Browser tab mismatch.")
  check(target)
  if (target.contents.isDestroyed()) return failure("detached", "The browser panel view is no longer available.")
  const blocked = browserInputFailure(target.contents)
  if (blocked) return blocked
  attach(target.contents)

  if (request.op === "wait_for_navigation") {
    while (target.contents.getURL() !== request.url || target.contents.isLoadingMainFrame()) await settle(target)
    // Pin the observed destination epoch before any snapshot await.
    check(target, true)
    return refreshed(target)
  }
  if (request.op === "wait_for_element") return waitForVisibleElement(target, request)

  if (request.op !== "read_state" && request.op !== "navigate") {
    await send(target, "Runtime.evaluate", {
      expression:
        "new Promise(resolve => { const timer = setTimeout(resolve, 1000); requestAnimationFrame(() => requestAnimationFrame(() => { clearTimeout(timer); resolve() })) })",
      awaitPromise: true,
    })
  }

  if (request.op === "read_state") return refreshed(target)
  if (request.op === "navigate") {
    const deadline = target.deadline!
    // Explicit recovery replaces the old load. Cancellation itself never stops an observed user load.
    if (target.contents.isLoadingMainFrame()) {
      target.contents.stop()
      do {
        check(target, true)
        if (target.contents.isDestroyed() || Date.now() >= deadline) throw new Error("Browser navigation interrupted")
        await settle(target)
      } while (target.contents.isLoadingMainFrame())
    }
    check(target, true)
    await target.contents.loadURL(request.url)
    // loadURL resolves before Chromium clears main-frame loading.
    while (target.contents.isLoadingMainFrame()) {
      check(target)
      if (target.contents.isDestroyed() || Date.now() >= deadline) throw new Error("Browser navigation interrupted")
      await settle(target)
    }
    return refreshed(target)
  }
  if (request.op === "press_key") {
    if (!(await dispatchKey(target, request.key, request.modifiers)))
      return failure("bad_request", `Unsupported key: ${request.key}.`)
    await settle(target)
    return refreshed(target)
  }

  if (request.op === "scroll") {
    const element = request.ref ? await resolveRef(target, request.ref) : undefined
    if (request.ref && !element) return failure("stale_ref", nativeT("desktop.browser.driver.staleScrollRef"))
    let x = element ? element.rect.x + element.rect.width / 2 : 0
    let y = element ? element.rect.y + element.rect.height / 2 : 0
    if (!element) {
      const metrics = await send(target, "Page.getLayoutMetrics")
      const viewport =
        metrics && typeof metrics === "object" && "cssVisualViewport" in metrics ? metrics.cssVisualViewport : undefined
      if (
        !viewport ||
        typeof viewport !== "object" ||
        !("clientWidth" in viewport) ||
        typeof viewport.clientWidth !== "number" ||
        !Number.isFinite(viewport.clientWidth) ||
        viewport.clientWidth <= 0 ||
        !("clientHeight" in viewport) ||
        typeof viewport.clientHeight !== "number" ||
        !Number.isFinite(viewport.clientHeight) ||
        viewport.clientHeight <= 0
      )
        return failure("unavailable", nativeT("desktop.browser.driver.viewportUnavailable"))
      x = viewport.clientWidth / 2
      y = viewport.clientHeight / 2
    }
    await send(target, "Input.dispatchMouseEvent", {
      type: "mouseWheel",
      x,
      y,
      deltaX: request.deltaX,
      deltaY: request.deltaY,
    })
    await settle(target)
    return refreshed(target)
  }

  const element = await resolveRef(target, request.ref)
  if (!element) return failure("stale_ref", `Element ref ${request.ref} is stale. Read browser state again.`)
  await dispatchClick(target, element)

  if (request.op === "fill") {
    await dispatchKey(target, "a", [process.platform === "darwin" ? "Meta" : "Ctrl"])
    await dispatchKey(target, "Backspace")
    for (const character of request.text) await dispatchKey(target, character)
  }

  await settle(target)
  return refreshed(target)
}

async function waitForVisibleElement(target: Target, request: Extract<PageRequest, { op: "wait_for_element" }>) {
  // Only one ASCII compound selector: no attribute/state tests, relationships, escapes or lists.
  if (
    !request.selector ||
    request.selector.length > 512 ||
    !/^(?:[A-Za-z][A-Za-z0-9-]*)?(?:[.#][A-Za-z_][A-Za-z0-9_-]*)*(?![\s\S])/.test(request.selector)
  )
    return failure("bad_request", nativeT("desktop.browser.driver.invalidSelector"))
  const tree = await send(target, "Page.getFrameTree")
  if (
    !tree ||
    typeof tree !== "object" ||
    !("frameTree" in tree) ||
    !tree.frameTree ||
    typeof tree.frameTree !== "object" ||
    !("frame" in tree.frameTree) ||
    !tree.frameTree.frame ||
    typeof tree.frameTree.frame !== "object" ||
    !("id" in tree.frameTree.frame) ||
    typeof tree.frameTree.frame.id !== "string"
  )
    return failure("unavailable", nativeT("desktop.browser.driver.frameUnavailable"))
  const world = await send(target, "Page.createIsolatedWorld", {
    frameId: tree.frameTree.frame.id,
    worldName: "cm-browser-wait",
  })
  if (
    !world ||
    typeof world !== "object" ||
    !("executionContextId" in world) ||
    typeof world.executionContextId !== "number"
  )
    return failure("unavailable", nativeT("desktop.browser.driver.contextUnavailable"))
  // A short native sample owns its cleanup, even if main cancels while CDP is pending.
  const expression = `(async () => {
    let matches;
    try { matches = document.querySelectorAll(${JSON.stringify(request.selector)}) } catch { return "invalid" }
    if (!matches.length) return false;
    let observer, timer;
    try {
      return await new Promise((resolve, reject) => {
        observer = new IntersectionObserver(entries => {
          try {
            resolve(entries.some(entry =>
              entry.intersectionRect.width > 0 && entry.intersectionRect.height > 0 &&
              entry.target.matches(${JSON.stringify(request.selector)}) &&
              entry.target.checkVisibility({ checkOpacity: true, checkVisibilityCSS: true })
            ));
          } catch { reject(); }
        });
        timer = setTimeout(() => resolve(false), Math.min(100, Math.max(0, ${target.deadline!} - Date.now())));
        for (const el of matches) observer.observe(el);
      });
    } finally {
      observer?.disconnect();
      clearTimeout(timer);
    }
  })()`
  for (;;) {
    const response = await send(target, "Runtime.evaluate", {
      expression,
      contextId: world.executionContextId,
      returnByValue: true,
      awaitPromise: true,
      timeout: Math.max(1, target.deadline! - Date.now()),
    })
    if (
      !response ||
      typeof response !== "object" ||
      "exceptionDetails" in response ||
      !("result" in response) ||
      !response.result ||
      typeof response.result !== "object" ||
      !("value" in response.result)
    )
      return failure("unavailable", nativeT("desktop.browser.driver.probeUnavailable"))
    if (response.result.value === "invalid")
      return failure("bad_request", nativeT("desktop.browser.driver.invalidSelector"))
    if (response.result.value === true) return refreshed(target)
    if (response.result.value !== false)
      return failure("unavailable", nativeT("desktop.browser.driver.probeUnavailable"))
    await settle(target)
  }
}
