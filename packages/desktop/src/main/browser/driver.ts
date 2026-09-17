import { randomUUID } from "node:crypto"
import { setTimeout } from "node:timers/promises"
import {
  MAX_SNAPSHOT_BYTES,
  OPERATION_TIMEOUT_MS,
  screenshotBytes,
  screenshotDimensions,
  failure,
  success,
  type BrowserState,
  type Modifier,
  type PageRequest,
  type Response,
} from "@cookiemonster/cm-browser/protocol"
import {
  parseSnapshot,
  snapshotScript,
  dragSnapshotScript,
  selectOptionScript,
  type PageSnapshot,
  type SnapshotElement,
} from "./snapshot"
import { nativeT } from "../native-translations"

// Narrow native decoder seam: Bun unit tests do not load Electron.
export const screenshotDecoder = {
  async size(bytes: Buffer, check: () => void) {
    check()
    const { nativeImage } = await import("electron")
    check()
    const image = nativeImage.createFromBuffer(bytes)
    return image.isEmpty() ? undefined : image.getSize()
  },
}

export type DriverContents = {
  readonly mainFrame: { readonly detached: boolean }
  readonly focusedFrame: { readonly detached: boolean } | null
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
  readonly inputRef?: string
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

function checkFocusedFrame(target: Target) {
  check(target, true)
  // Native frame identity is only a focus boundary, not a document identity.
  const main = target.contents.mainFrame
  if (!main || main.detached || target.contents.focusedFrame !== main) throw new Error("Browser focused frame changed")
}

async function send(target: Target, method: string, params?: Record<string, unknown>) {
  check(target)
  if (target.contents.isLoadingMainFrame()) throw new Error("Browser page is loading")
  const keyboard = method === "Input.dispatchKeyEvent" || method === "Input.insertText"
  if (keyboard) {
    checkFocusedFrame(target)
    if (target.inputRef && !(await resolveRef(target, target.inputRef, true, true)))
      throw new Error("Browser focused input changed")
    // Recheck native focus and source/access after the identity await. Dispatch is not atomic with these checks.
    checkFocusedFrame(target)
  }
  const input = method === "Input.dispatchKeyEvent" || method === "Input.dispatchMouseEvent"
  if (input && (params?.type === "keyDown" || params?.type === "mousePressed")) inputDown.add(target.contents)
  const result = await target.contents.debugger.sendCommand(method, params)
  if (input && (params?.type === "keyUp" || params?.type === "mouseReleased")) inputDown.delete(target.contents)
  check(target)
  if (target.contents.isLoadingMainFrame()) throw new Error("Browser page is loading")
  if (keyboard) {
    checkFocusedFrame(target)
    if (target.inputRef && !(await resolveRef(target, target.inputRef, true, true)))
      throw new Error("Browser focused input changed")
    checkFocusedFrame(target)
  }
  return result
}

type StoredSnapshot = { readonly id: string; readonly page: PageSnapshot }
const histories = new WeakMap<object, { snapshots: Map<string, StoredSnapshot> }>()

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

async function capture(
  target: Target,
  id: string,
  reference?: Parameters<typeof snapshotScript>[1],
  targetToken?: string,
) {
  const contextId = await snapshotContext(target)
  if (typeof contextId !== "number") return
  const page = parseSnapshot(
    await send(target, "Runtime.evaluate", {
      expression:
        reference && targetToken ? dragSnapshotScript(id, reference, targetToken) : snapshotScript(id, reference),
      contextId,
      returnByValue: true,
      timeout: Math.max(1, target.deadline! - Date.now()),
    }),
  )
  if (!page || page.url !== target.contents.getURL()) return
  return page
}

function publicState(target: Target, page: PageSnapshot, id: string): BrowserState {
  const history = histories.get(target.contents) ?? { snapshots: new Map() }
  history.snapshots.set(id, { id, page })
  while (history.snapshots.size > 10) history.snapshots.delete(history.snapshots.keys().next().value!)
  histories.set(target.contents, history)

  const state: BrowserState = {
    tabID: target.tabID,
    url: page.url,
    title: page.title,
    visibleText: page.visibleText,
    truncated: page.truncated,
    elements: page.elements.map((element) => ({
      ref: `${id}:${element.token}`,
      tag: element.tag,
      role: element.role,
      label: element.label,
      text: element.text,
      checked: element.checked,
      selected: element.selected,
      expanded: element.expanded,
      disabled: element.disabled,
      ...(element.options
        ? {
            options: element.options.map((option) => ({
              ref: `${id}:${option.token}`,
              label: option.label,
              selected: option.selected,
              disabled: option.disabled,
            })),
            optionsTruncated: element.optionsTruncated,
          }
        : {}),
    })),
  }
  if (Buffer.byteLength(JSON.stringify(state)) <= MAX_SNAPSHOT_BYTES) return state
  return {
    ...state,
    truncated: true,
    elements: state.elements.slice(0, 100),
    visibleText: state.visibleText.slice(0, 8_000),
  }
}

async function refreshed(target: Target): Promise<Response<BrowserState>> {
  const id = `${target.tabID}.${randomUUID()}`
  const page = await capture(target, id)
  if (!page) return failure("unavailable", "The page did not return a usable snapshot.")
  return success(publicState(target, page, id))
}

// Suppress this tab's native menus, including simultaneous manual ones, until right-click settlement.
const rightClicks = new WeakSet<DriverContents>()

export function shouldShowBrowserContextMenu(contents: DriverContents) {
  return !rightClicks.has(contents)
}

async function dispatchClick(target: Target, element: SnapshotElement, button = "left", clickCount = 1) {
  // Native dispatch is not atomic with isolated-world identity/visibility/hit testing.
  const x = element.rect.x + element.rect.width / 2
  const y = element.rect.y + element.rect.height / 2
  const base = { x, y, button, buttons: button === "right" ? 2 : 1, clickCount }
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

async function resolveRef(target: Target, ref: string, fill = false, focused = false) {
  const match = /^([^:]+):([a-zA-Z0-9-]{1,64})$/.exec(ref)
  if (!match || !match[1].startsWith(`${target.tabID}.`)) return
  const stored = histories.get(target.contents)?.snapshots.get(match[1])
  const expected = stored?.page.elements.find((element) => element.token === match[2])
  if (!stored || !expected || target.contents.getURL() !== stored.page.url) return
  const current = await capture(target, stored.id, {
    generation: stored.page.generation,
    token: expected.token,
    fill,
    focused,
  })
  const actual = current?.generation === stored.page.generation ? current.elements[0] : undefined
  if (!actual || actual.token !== expected.token || actual.disabled !== false) return
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

  if (request.op === "screenshot") {
    const unavailable = () => failure("unavailable", nativeT("desktop.browser.screenshotUnavailable"))
    const metrics = (await send(target, "Page.getLayoutMetrics")) as
      | {
          visualViewport?: { clientWidth?: unknown; clientHeight?: unknown }
        }
      | undefined
    const viewport = metrics?.visualViewport
    if (!viewport || !screenshotDimensions(viewport.clientWidth, viewport.clientHeight)) return unavailable()
    const captured = (await send(target, "Page.captureScreenshot", {
      format: "jpeg",
      quality: 60,
      fromSurface: true,
      captureBeyondViewport: false,
    })) as { data?: unknown } | undefined
    const bytes = screenshotBytes(captured?.data)
    if (!bytes) return unavailable()
    check(target)
    const size = await screenshotDecoder.size(bytes, () => check(target))
    check(target)
    if (!size || !screenshotDimensions(size.width, size.height)) return unavailable()
    return success({
      tabID: target.tabID,
      url: target.contents.getURL(),
      title: "",
      visibleText: "",
      elements: [],
      screenshot: { data: bytes.toString("base64"), width: size.width, height: size.height },
    })
  }

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
    // ponytail: native hit metadata only; no child document inspection or frame grant.
    x = Math.round(x)
    y = Math.round(y)
    const tree = (await send(target, "Page.getFrameTree")) as { frameTree?: { frame?: { id?: unknown } } } | undefined
    const hit = (await send(target, "DOM.getNodeForLocation", { x, y })) as
      | { frameId?: unknown; backendNodeId?: unknown }
      | undefined
    if (
      typeof tree?.frameTree?.frame?.id !== "string" ||
      hit?.frameId !== tree.frameTree.frame.id ||
      typeof hit.backendNodeId !== "number"
    )
      return failure("unavailable", nativeT("desktop.browser.driver.frameUnavailable"))
    // OOPIF hits can identify the parent-owned iframe instead of the child frame.
    const node = (await send(target, "DOM.describeNode", {
      backendNodeId: hit.backendNodeId,
      depth: 0,
      pierce: false,
    })) as { node?: { nodeName?: unknown } } | undefined
    if (typeof node?.node?.nodeName !== "string" || /^(iframe|frame|object|embed)$/i.test(node.node.nodeName))
      return failure("unavailable", nativeT("desktop.browser.driver.frameUnavailable"))
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

  if (request.op === "drag") return dispatchDrag(target, request)

  if (request.op === "select_option") {
    const match = /^([^:]+):([a-zA-Z0-9-]{1,64})$/.exec(request.ref)
    const option = /^([^:]+):([a-zA-Z0-9-]{1,64})$/.exec(request.optionRef)
    const stored =
      match && match[1].startsWith(`${target.tabID}.`)
        ? histories.get(target.contents)?.snapshots.get(match[1])
        : undefined
    const select = stored?.page.elements.find((element) => element.token === match?.[2] && element.tag === "select")
    if (
      !stored ||
      !select ||
      !option ||
      option[1] !== stored.id ||
      !select.options?.some((entry) => entry.token === option[2]) ||
      target.contents.getURL() !== stored.page.url
    )
      return failure("stale_ref", nativeT("desktop.browser.driver.staleScrollRef"))
    const contextId = await snapshotContext(target)
    if (typeof contextId !== "number") return failure("unavailable", nativeT(contextId))
    const response = (await send(target, "Runtime.evaluate", {
      expression: selectOptionScript(
        stored.id,
        { generation: stored.page.generation, token: select.token },
        option[2],
        target.deadline!,
      ),
      contextId,
      returnByValue: true,
      timeout: Math.max(1, target.deadline! - Date.now()),
    })) as { exceptionDetails?: unknown; result?: { value?: unknown } } | undefined
    if (!response || "exceptionDetails" in response || response.result?.value !== true)
      return failure("stale_ref", nativeT("desktop.browser.driver.staleScrollRef"))
    await settle(target)
    return refreshed(target)
  }

  const element = await resolveRef(target, request.ref, request.op === "fill")
  if (!element) return failure("stale_ref", nativeT("desktop.browser.driver.staleRef", { ref: request.ref }))
  const x = element.rect.x + element.rect.width / 2
  const y = element.rect.y + element.rect.height / 2
  if (request.op === "click" && request.mode === "right") rightClicks.add(target.contents)
  try {
    await send(target, "Input.dispatchMouseEvent", { type: "mouseMoved", x, y, button: "none", buttons: 0 })
    if (request.op !== "hover") {
      // Hover handlers can replace nodes or change fill kind. Do not chase a moving center.
      const current = await resolveRef(target, request.ref, request.op === "fill")
      if (!current || current.rect.x + current.rect.width / 2 !== x || current.rect.y + current.rect.height / 2 !== y)
        return failure("stale_ref", nativeT("desktop.browser.driver.staleRef", { ref: request.ref }))
      await dispatchClick(target, current, request.op === "click" && request.mode === "right" ? "right" : "left")
      if (request.op === "click" && request.mode === "double") {
        const second = await resolveRef(target, request.ref)
        if (!second || second.rect.x + second.rect.width / 2 !== x || second.rect.y + second.rect.height / 2 !== y)
          return failure("stale_ref", nativeT("desktop.browser.driver.staleRef", { ref: request.ref }))
        await dispatchClick(target, second, "left", 2)
      }
    }

    if (request.op === "fill") {
      target = { ...target, inputRef: request.ref }
      await dispatchKey(target, "a", [process.platform === "darwin" ? "Meta" : "Ctrl"])
      await dispatchKey(target, "Backspace")
      for (const character of request.text) await dispatchKey(target, character)
    }

    await settle(target)
    return await refreshed(target)
  } finally {
    rightClicks.delete(target.contents)
  }
}

async function snapshotContext(target: Target) {
  const tree = (await send(target, "Page.getFrameTree")) as { frameTree?: { frame?: { id?: unknown } } } | undefined
  if (typeof tree?.frameTree?.frame?.id !== "string") return "desktop.browser.driver.frameUnavailable" as const
  const world = (await send(target, "Page.createIsolatedWorld", {
    frameId: tree.frameTree.frame.id,
    worldName: "cm-browser-snapshot",
  })) as { executionContextId?: unknown } | undefined
  if (typeof world?.executionContextId !== "number" || !Number.isInteger(world.executionContextId))
    return "desktop.browser.driver.contextUnavailable" as const
  return world.executionContextId
}

async function dispatchDrag(target: Target, request: Extract<PageRequest, { op: "drag" }>) {
  const source = /^([^:]+):([a-zA-Z0-9-]{1,64})$/.exec(request.sourceRef)
  const destination = /^([^:]+):([a-zA-Z0-9-]{1,64})$/.exec(request.targetRef)
  const stored =
    source && source[1].startsWith(`${target.tabID}.`)
      ? histories.get(target.contents)?.snapshots.get(source[1])
      : undefined
  const stale = () => failure("stale_ref", nativeT("desktop.browser.driver.staleScrollRef"))
  if (
    !stored ||
    !source ||
    !destination ||
    source[1] !== destination[1] ||
    source[2] === destination[2] ||
    target.contents.getURL() !== stored.page.url ||
    ![source[2], destination[2]].every((token) => stored.page.elements.some((element) => element.token === token))
  )
    return stale()

  const pair = async () => {
    const page = await capture(
      target,
      stored.id,
      { generation: stored.page.generation, token: source[2] },
      destination[2],
    )
    if (
      page?.generation !== stored.page.generation ||
      page.elements.length !== 2 ||
      page.elements[0].token !== source[2] ||
      page.elements[1].token !== destination[2] ||
      page.elements.some((element) => element.disabled !== false)
    )
      return
    return page.elements
  }
  const initial = await pair()
  if (!initial) return stale()
  const start = { x: initial[0].rect.x + initial[0].rect.width / 2, y: initial[0].rect.y + initial[0].rect.height / 2 }
  const end = { x: initial[1].rect.x + initial[1].rect.width / 2, y: initial[1].rect.y + initial[1].rect.height / 2 }
  const matches = (element: SnapshotElement | undefined, point: { x: number; y: number }) =>
    element &&
    element.rect.x + element.rect.width / 2 === point.x &&
    element.rect.y + element.rect.height / 2 === point.y

  await send(target, "Input.dispatchMouseEvent", { type: "mouseMoved", ...start, button: "none", buttons: 0 })
  const hovered = await pair()
  if (!hovered || !matches(hovered[0], start) || !matches(hovered[1], end)) return stale()
  await send(target, "Input.dispatchMouseEvent", {
    type: "mousePressed",
    ...start,
    button: "left",
    buttons: 1,
    clickCount: 1,
  })
  // ponytail: four fixed moves, not universal HTML5/native dragging. Never chase targets or clean up with a release.
  for (const fraction of [0.25, 0.5, 0.75, 1]) {
    if (!matches(await resolveRef(target, request.targetRef), end)) return stale()
    await send(target, "Input.dispatchMouseEvent", {
      type: "mouseMoved",
      x: start.x + (end.x - start.x) * fraction,
      y: start.y + (end.y - start.y) * fraction,
      button: "left",
      buttons: 1,
    })
  }
  if (!matches(await resolveRef(target, request.targetRef), end)) return stale()
  await send(target, "Input.dispatchMouseEvent", {
    type: "mouseReleased",
    ...end,
    button: "left",
    buttons: 0,
    clickCount: 1,
  })
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
