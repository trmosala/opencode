// MAIN-world, document-start injection of pageRecorder.js — the single make-or-break piece of
// the port.
//
// pageRecorder.js monkey-patches window.fetch + XMLHttpRequest to observe the model's SSE/JSON
// stream. That ONLY works if it runs:
//   1. in the page's MAIN world (a normal Electron preload runs in an isolated world and would
//      patch a different fetch than the page's own), and
//   2. BEFORE any page script (or the first model request escapes capture → "recorder did not
//      arm" in content.js waitForRecorderReset).
//
// CDP's Page.addScriptToEvaluateOnNewDocument satisfies both: it evaluates in the page's main
// world at document-start on every navigation. This reproduces the MV3 manifest guarantee
// ("world":"MAIN" + run_at:"document_start") by a different mechanism.

import type { WebContents } from "electron"
import recorderSource from "./injected/pageRecorder.js?raw"

const PROBE_BINDING = "__wppRecorderProbe"

// A tiny companion script (also main-world, document-start) that relays pageRecorder's
// window.postMessage status frames out to the main process via a CDP binding. This is how the
// prototype proves the recorder actually armed before page scripts ran. In production the
// ported content.js consumes these frames directly; the probe is verification scaffolding.
const PROBE_SOURCE = `
(() => {
  if (window.__wppRecorderProbeInstalled) return;
  window.__wppRecorderProbeInstalled = true;
  window.addEventListener("message", (event) => {
    if (event.source !== window) return;
    const data = event.data;
    if (data && data.source === "o1-code-bridge-page" && typeof window.${PROBE_BINDING} === "function") {
      try {
        window.${PROBE_BINDING}(JSON.stringify({ type: data.type, status: data.status || null, runId: data.runId || null }));
      } catch (_e) {}
    }
  });
})();
`

export type RecorderEvent = { type: string; status?: string | null; runId?: string | null }

// Attach the debugger, register the probe binding, and queue both scripts to run on every new
// document in the page's main world. Returns once injection is registered; events arrive
// asynchronously via onEvent as the page loads and the recorder posts "ready"/"reset".
export async function installRecorder(
  contents: WebContents,
  onEvent?: (event: RecorderEvent) => void,
): Promise<void> {
  const dbg = contents.debugger
  if (!dbg.isAttached()) dbg.attach("1.3")

  if (onEvent) {
    dbg.on("message", (_event, method, params) => {
      if (method !== "Runtime.bindingCalled") return
      const payload = params as { name?: string; payload?: string }
      if (payload.name !== PROBE_BINDING) return
      try {
        onEvent(JSON.parse(payload.payload || "{}") as RecorderEvent)
      } catch {
        // Malformed probe frame — ignore; the authoritative result path is unaffected.
      }
    })
    await dbg.sendCommand("Runtime.enable")
    await dbg.sendCommand("Runtime.addBinding", { name: PROBE_BINDING })
  }

  await dbg.sendCommand("Page.enable")
  // Probe before recorder so the relay listener exists when the recorder posts its first frame.
  // runImmediately covers the case where a document already exists when we attach.
  await dbg.sendCommand("Page.addScriptToEvaluateOnNewDocument", {
    source: PROBE_SOURCE,
    runImmediately: true,
  })
  await dbg.sendCommand("Page.addScriptToEvaluateOnNewDocument", {
    source: recorderSource,
    runImmediately: true,
  })
}
