// Bun test preload for the desktop package.
//
// `node_modules/electron` exports the path to the Electron binary, not the runtime API, so any
// module doing `import { app } from "electron"` cannot be linked under `bun test`. Test files used
// to each call `mock.module("electron", ...)` before importing the module under test, but the
// module registry is shared across files: whichever file first linked an electron-importing module
// decided which stub every other file saw. That is why the three affected files passed in isolation
// and failed in the full suite. Registering one stub here runs before any test file loads, which
// makes the behaviour order-independent.

import { mock } from "bun:test"

const noop = () => {}

export type ResponseStartedDetails = {
  statusCode: number
  url: string
  webContents?: { id: number; isDestroyed(): boolean; reloadIgnoringCache(): void }
}

export type ResponseStartedListener = (details: ResponseStartedDetails) => void

// Listeners registered through session.webRequest.onResponseStarted, newest last. Tests that need
// to drive a web-request callback read from here instead of installing their own electron mock.
const responseStartedListeners: ResponseStartedListener[] = []

function createSession() {
  return {
    webRequest: {
      onResponseStarted(listener: ResponseStartedListener) {
        responseStartedListeners.push(listener)
      },
      onBeforeRequest: noop,
      onBeforeSendHeaders: noop,
      onHeadersReceived: noop,
      onCompleted: noop,
      onErrorOccurred: noop,
    },
    cookies: {
      get: async () => [],
      set: async () => {},
      remove: async () => {},
    },
    clearStorageData: async (_options?: unknown) => {},
    setPermissionRequestHandler: noop,
    setUserAgent: noop,
    setProxy: async () => {},
    protocol: { handle: noop, isProtocolHandled: () => false },
    on: noop,
  }
}

type FakeSession = ReturnType<typeof createSession>

// Electron hands back one Session per partition string; preserve that identity so a module and its
// test observe the same object.
const partitions = new Map<string, FakeSession>()
const fromPartition = (partition = "") => {
  const existing = partitions.get(partition)
  if (existing) return existing
  const created = createSession()
  partitions.set(partition, created)
  return created
}
const defaultSession = fromPartition("")

class FakeWebContents {
  id = 1
  session = defaultSession
  isDestroyed() {
    return false
  }
  on() {
    return this
  }
  once() {
    return this
  }
  removeListener() {
    return this
  }
  send() {}
  setWindowOpenHandler() {}
  reloadIgnoringCache() {}
  openDevTools() {}
  async loadURL() {}
  async loadFile() {}
  async executeJavaScript() {
    return undefined
  }
  get debugger() {
    return { attach: noop, detach: noop, on: noop, sendCommand: async () => ({}) }
  }
}

class FakeBrowserWindow {
  static getAllWindows() {
    return [] as FakeBrowserWindow[]
  }
  static getFocusedWindow() {
    return null
  }
  static fromWebContents() {
    return null
  }
  webContents = new FakeWebContents()
  isDestroyed() {
    return false
  }
  isVisible() {
    return false
  }
  on() {
    return this
  }
  once() {
    return this
  }
  show() {}
  showInactive() {}
  hide() {}
  focus() {}
  close() {}
  destroy() {}
  async loadURL() {}
}

const app = {
  isPackaged: false,
  getPath: (name: string) => `/tmp/opencode-desktop-test/${name}`,
  getName: () => "opencode",
  getVersion: () => "0.0.0-test",
  getAppPath: () => "/tmp/opencode-desktop-test",
  getLocale: () => "en-US",
  on: noop,
  once: noop,
  whenReady: async () => {},
  quit: noop,
  exit: noop,
  relaunch: noop,
  setAppUserModelId: noop,
  setLoginItemSettings: noop,
  requestSingleInstanceLock: () => true,
  commandLine: { appendSwitch: noop, appendArgument: noop },
  dock: { hide: noop, show: noop },
}

class FakeMenu {
  static setApplicationMenu() {}
  static getApplicationMenu() {
    return null
  }
  static buildFromTemplate() {
    return new FakeMenu()
  }
  popup() {}
  append() {}
}

class FakeTray {
  setToolTip() {}
  setContextMenu() {}
  setImage() {}
  on() {
    return this
  }
  destroy() {}
}

const electron = {
  app,
  BrowserWindow: FakeBrowserWindow,
  Menu: FakeMenu,
  MenuItem: FakeMenu,
  Tray: FakeTray,
  session: { fromPartition, defaultSession },
  ipcMain: {
    handle: noop,
    handleOnce: noop,
    on: noop,
    once: noop,
    removeHandler: noop,
    removeAllListeners: noop,
  },
  ipcRenderer: {
    invoke: async () => undefined,
    on: noop,
    once: noop,
    send: noop,
    removeListener: noop,
  },
  contextBridge: { exposeInMainWorld: noop },
  webUtils: { getPathForFile: () => "" },
  dialog: {
    showOpenDialog: async () => ({ canceled: true, filePaths: [] as string[] }),
    showSaveDialog: async () => ({ canceled: true, filePath: undefined }),
    showMessageBox: async () => ({ response: 0, checkboxChecked: false }),
    showErrorBox: noop,
  },
  shell: {
    openExternal: async () => {},
    openPath: async () => "",
    showItemInFolder: noop,
    beep: noop,
  },
  clipboard: { writeText: noop, readText: () => "", writeImage: noop },
  nativeImage: {
    createEmpty: () => ({ isEmpty: () => true, resize: () => ({}) }),
    createFromPath: () => ({ isEmpty: () => true, resize: () => ({}) }),
    createFromDataURL: () => ({ isEmpty: () => true, resize: () => ({}) }),
  },
  nativeTheme: { shouldUseDarkColors: false, themeSource: "system", on: noop },
  protocol: { handle: noop, registerSchemesAsPrivileged: noop, isProtocolHandled: () => false },
  net: { fetch: async () => new Response("") },
  utilityProcess: {
    fork: () => ({ pid: 0, on: noop, once: noop, postMessage: noop, kill: () => true }),
  },
  crashReporter: { start: noop },
  netLog: { startLogging: async () => {}, stopLogging: async () => {} },
  powerMonitor: { on: noop },
  globalShortcut: { register: () => true, unregister: noop, unregisterAll: noop },
  screen: {
    getPrimaryDisplay: () => ({ workAreaSize: { width: 1920, height: 1080 } }),
    getAllDisplays: () => [] as unknown[],
  },
  systemPreferences: { getMediaAccessStatus: () => "granted" },
}

// mock.module returns a promise, but the registration itself is synchronous and must be in place
// before any test file links. Awaiting at top level would be pointless here, so discard it.
void mock.module("electron", () => ({ ...electron, default: electron }))

export const desktopElectronMock = {
  session: { fromPartition, defaultSession },
  responseStartedListeners,
}
