import {
  app,
  BrowserWindow,
  ImageView,
  View,
  WebContentsView,
  type Event,
  type Rectangle,
  type NativeImage,
} from "electron"
import { join } from "node:path"
import { Option, Schema } from "effect"

const decodeWheel = Schema.decodeUnknownOption(
  Schema.Tuple([Schema.Finite, Schema.Finite, Schema.Finite, Schema.Finite]),
)

// Keep the authenticated offscreen WebContents and its CDP sessions intact while debugging.
// A separate native window displays its capped paints and forwards input to the same page.
const previews = new WeakMap<BrowserWindow, BrowserWindow | undefined>()

export function attachWorkerPreview(win: BrowserWindow) {
  win.webContents.setFrameRate(15)
  previews.set(win, undefined)
}

export function showWorkerWindow(win: BrowserWindow, title: string) {
  const preview = previews.has(win) ? (previews.get(win) ?? createPreview(win)) : win

  if (previews.has(win)) previews.set(win, preview)

  preview.showInactive()
  preview.setTitle(title)

  return preview
}

export function hideWorkerWindow(win: BrowserWindow) {
  if (!previews.has(win)) return win.hide()

  previews.get(win)?.hide()
}

function createPreview(win: BrowserWindow) {
  const bounds = win.getContentBounds()

  const preview = new BrowserWindow({
    show: false,
    width: bounds.width,
    height: bounds.height,
    useContentSize: true,
    minWidth: 1280,
    enableLargerThanScreen: true,
    webPreferences: { contextIsolation: true, nodeIntegration: false, sandbox: true },
  })

  const image = new ImageView()

  const input = new WebContentsView({
    webPreferences: {
      preload: join(app.getAppPath(), "out/preload/worker-preview.cjs"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  })

  input.setBackgroundColor("#00000000")
  preview.setContentView(new View())
  preview.contentView.addChildView(image)
  preview.contentView.addChildView(input)

  const layout = () => {
    const bounds = preview.getContentBounds()
    win.setContentSize(bounds.width, bounds.height)
    image.setBounds({ x: 0, y: 0, width: bounds.width, height: bounds.height })
    input.setBounds({ x: 0, y: 0, width: bounds.width, height: bounds.height })
  }

  layout()
  preview.on("resize", layout)

  const paint = (_event: Event, _dirty: Rectangle, frame: NativeImage) => {
    if (preview.isVisible() && !preview.isMinimized()) image.setImage(frame)
  }

  win.webContents.on("paint", paint)
  preview.on("show", () => {
    win.webContents.invalidate()
    input.webContents.focus()
  })
  input.webContents.on("before-mouse-event", (event, mouse) => {
    event.preventDefault()
    win.webContents.sendInputEvent(mouse)
  })
  input.webContents.on("before-input-event", (event, key) => {
    event.preventDefault()

    if (key.type !== "keyDown" && key.type !== "keyUp") return

    const modifiers = [key.shift && "shift", key.control && "control", key.alt && "alt", key.meta && "meta"].filter(
      (value): value is "shift" | "control" | "alt" | "meta" => value !== false,
    )

    win.webContents.sendInputEvent({ type: key.type, keyCode: key.key, modifiers })

    if (key.type === "keyDown" && key.key.length === 1 && !key.control && !key.meta) {
      win.webContents.sendInputEvent({ type: "char", keyCode: key.key, modifiers })
    }
  })
  input.webContents.on("ipc-message", (_event, channel, ...args: unknown[]) => {
    if (channel !== "worker-preview-wheel") return

    const wheel = decodeWheel(args)

    if (Option.isNone(wheel)) return

    win.webContents.sendInputEvent({
      type: "mouseWheel",
      x: Math.round(wheel.value[0]),
      y: Math.round(wheel.value[1]),
      deltaX: wheel.value[2],
      deltaY: wheel.value[3],
    })
  })
  input.webContents.on("will-navigate", (event) => event.preventDefault())
  input.webContents.setWindowOpenHandler(() => ({ action: "deny" }))
  void input.webContents.loadURL(
    'data:text/html,<meta http-equiv="Content-Security-Policy" content="default-src %27none%27; style-src %27unsafe-inline%27"><body style="margin:0;background:transparent">',
  )
  const destroy = () => preview.destroy()
  win.once("closed", destroy)
  preview.on("close", (event) => {
    event.preventDefault()
    preview.hide()
  })
  preview.on("closed", () => {
    win.removeListener("closed", destroy)
    win.webContents.removeListener("paint", paint)

    if (!input.webContents.isDestroyed()) input.webContents.close()
    previews.set(win, undefined)
  })

  return preview
}
