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
import { installInRootAndChildTargets } from "./cdp-targets"
import recorderSource from "./injected/pageRecorder.js?raw"

const PROBE_PREFIX = "__wppRecorderProbe:"

// A tiny companion script (also main-world, document-start) that relays pageRecorder's
// window.postMessage status frames out to the main process via console-message. This is how the
// prototype proves the recorder actually armed before page scripts ran. In production the
// ported content.js consumes these frames directly; the probe is verification scaffolding.
const PROBE_SOURCE = `
(() => {
  if (window.__wppRecorderProbeInstalled) return;
  window.__wppRecorderProbeInstalled = true;
  window.addEventListener("message", (event) => {
    if (event.source !== window) return;
    const data = event.data;
    if (data && data.source === "o1-code-bridge-page") {
      try {
        console.log("${PROBE_PREFIX}" + JSON.stringify({ type: data.type, status: data.status || null, runId: data.runId || null }));
      } catch (_e) {}
    }
  });
})();
`

export type RecorderEvent = { type: string; status?: string | null; runId?: string | null }

// Attach the debugger, register the probe relay, and queue both scripts to run on every new
// document in the page's main world. Returns once injection is registered; events arrive
// asynchronously via onEvent as the page loads and the recorder posts "ready"/"reset".
export async function installRecorder(
  contents: WebContents,
  onEvent?: (event: RecorderEvent) => void,
): Promise<void> {
  await waitForInitialDocument(contents)
  const dbg = contents.debugger

  if (onEvent) {
    contents.on("console-message", (_event, _level, message) => {
      if (!message.startsWith(PROBE_PREFIX)) return
      try {
        onEvent(JSON.parse(message.slice(PROBE_PREFIX.length)) as RecorderEvent)
      } catch {
        // Malformed probe frame — ignore; the authoritative result path is unaffected.
      }
    })
  }

  await installInRootAndChildTargets(contents, async (sessionId) => {
    await dbg.sendCommand("Page.enable", {}, sessionId)
    // Probe before recorder so the relay listener exists when the recorder posts its first frame.
    // runImmediately covers the case where a document already exists when we attach.
    await dbg.sendCommand("Page.addScriptToEvaluateOnNewDocument", {
      source: PROBE_SOURCE,
      runImmediately: true,
    }, sessionId)
    await dbg.sendCommand("Page.addScriptToEvaluateOnNewDocument", {
      source: recorderSource,
      runImmediately: true,
    }, sessionId)
  })
}

async function waitForInitialDocument(contents: WebContents) {
  if (!contents.getURL()) {
    await contents.loadURL("about:blank").catch(() => undefined)
  }
  if (!contents.isLoadingMainFrame()) return
  await new Promise<void>((resolve) => {
    const done = () => {
      clearTimeout(timeout)
      contents.off("did-finish-load", done)
      contents.off("did-fail-load", done)
      resolve()
    }
    // ponytail: initial about:blank can race BrowserWindow creation; don't let a dev probe hang.
    const timeout = setTimeout(done, 2000)
    contents.once("did-finish-load", done)
    contents.once("did-fail-load", done)
  })
}
