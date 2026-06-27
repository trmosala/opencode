// Phase-3 de-risking harness. NOT wired into app startup — call manually (e.g. from a dev menu
// action or the Electron console) once you're logged into WPP in the persist:wpp partition.
//
// It opens one hidden worker window, installs the MAIN-world recorder via CDP, navigates to a
// WPP assistant URL, and resolves with the status frames the recorder emitted. If we see a
// "ready" and/or "reset" frame, the fetch/XHR patch landed before page scripts — the make-or-break
// guarantee — and we can confidently build the full webview pool on top of it.

import { createWorkerWindow, WPP_PARTITION, WPP_WORKSPACE_ORIGIN } from "./session"
import { installRecorder, type RecorderEvent } from "./recorder-injection"

export type RecorderProbeResult = {
  url: string
  events: RecorderEvent[]
  armed: boolean
}

export async function runRecorderPrototype(url: string, settleMs = 8000): Promise<RecorderProbeResult> {
  const win = createWorkerWindow()
  const events: RecorderEvent[] = []

  try {
    await installRecorder(win.webContents, (event) => events.push(event))
    const settled = new Promise((resolve) => setTimeout(resolve, settleMs))
    // ponytail: WPP entrypoints can keep redirecting/streaming and never resolve loadURL.
    // The probe only needs document-start frames, so bound navigation to the settle window.
    await Promise.race([win.webContents.loadURL(url).catch(() => undefined), settled])

    // "ready" is posted by pageRecorder at install time; a "reset" only follows a job's
    // RECORDER_RESET, so for a bare navigation "ready" alone proves the main-world patch ran.
    const armed = events.some((event) => event.type === "O1_CODE_BRIDGE_RECORDER_STATUS")
    return { url, events, armed }
  } finally {
    if (!win.isDestroyed()) win.destroy()
  }
}

// One-time interactive SSO. Opens a VISIBLE persist:wpp window at the WPP workspace origin so a
// human can complete SSO once; the partition persists cookies across restarts, so the hidden
// worker pool is authenticated afterward. ponytail: dev scaffolding for the Phase-3 gate —
// superseded by the first-class renderer login panel (Phase 5).
export function openWppLogin(url = WPP_WORKSPACE_ORIGIN) {
  const win = createWorkerWindow({ show: true })
  // Some enterprise IdPs complete login in a popup; allow it and keep it on the same partition
  // so the popup shares the session it is authenticating.
  win.webContents.setWindowOpenHandler(() => ({
    action: "allow",
    overrideBrowserWindowOptions: { webPreferences: { partition: WPP_PARTITION } },
  }))
  void win.loadURL(url)
  return win
}
