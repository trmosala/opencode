import { app, Menu, nativeImage, Tray } from "electron"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"

const root = dirname(fileURLToPath(import.meta.url))

let tray: Tray | null = null

function iconsDir() {
  return app.isPackaged ? join(process.resourcesPath, "icons") : join(root, "../../resources/icons")
}

function trayImage() {
  const ext = process.platform === "win32" ? "ico" : "png"
  return nativeImage.createFromPath(join(iconsDir(), `icon.${ext}`))
}

export function createTray(onOpen: () => void) {
  if (tray && !tray.isDestroyed()) return tray
  tray = new Tray(trayImage())
  tray.setToolTip(app.getName())
  const menu = Menu.buildFromTemplate([
    { label: `Open ${app.getName()}`, click: () => onOpen() },
    { type: "separator" },
    { label: "Quit", click: () => app.quit() },
  ])
  tray.setContextMenu(menu)
  tray.on("click", () => onOpen())
  tray.on("double-click", () => onOpen())
  return tray
}

export function destroyTray() {
  if (tray && !tray.isDestroyed()) tray.destroy()
  tray = null
}
