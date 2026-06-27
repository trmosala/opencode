// Phase-3 de-risking harness. NOT wired into app startup — call manually (e.g. from a dev menu
// action or the Electron console) once you're logged into WPP in the persist:wpp partition.
//
// It opens one hidden worker window, installs the MAIN-world recorder via CDP, navigates to a
// WPP assistant URL, and resolves with the status frames the recorder emitted. If we see a
// "ready" and/or "reset" frame, the fetch/XHR patch landed before page scripts — the make-or-break
// guarantee — and we can confidently build the full webview pool on top of it.

import { createWorkerWindow, openWppLogin } from "./session"
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

export { openWppLogin }
