# Asynchronous native leave confirmation: proposal for #48

## Decision and status

Deferred by the user on 3 October 2026. Finish shell responsiveness on stock Electron first. No custom runtime build or production adoption is authorized by that decision.

Propose an opt-in Electron API that retains Chromium's original beforeunload decision callback while main asks the user asynchronously. Leave would resume the native operation; Stay would cancel it. CookieMonster would not repeat a page click, resubmit a form, reconstruct a POST, or remove the site's beforeunload handler.

This is a proposal, not an implemented or compiled native patch. Issue #48 remains open. CookieMonster's existing main-owned address, history, reload and close confirmations remain the qualified implementation; unknown page-origin requests still have the limitation recorded in [leave-confirmation-qualification.md](./leave-confirmation-qualification.md). No product adapter should be added until the runtime exposes and passes qualification for this capability.

The preferred development path is an upstream Electron API. Using it before an upstream release would mean owning a custom Electron build and its updates. That is a material architecture and distribution decision, separate from approving this design document.

## Verified upstream boundary

Checked on 3 October 2026 against CookieMonster checkout `2d582ec4484fad03b3f6792c1eab2275e682d1cf`. Its [desktop dependency](../../../package.json) pins Electron `44.3.0`.

| Source checked                                                                                                                                                                                               | Beforeunload behavior                                                    |
| ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------ |
| [Electron 44.3.0](https://github.com/electron/electron/blob/v44.3.0/shell/browser/api/electron_api_web_contents.cc#L4463-L4477)                                                                              | Emits `will-prevent-unload`, then immediately calls the native callback. |
| [Electron 44.5.1](https://github.com/electron/electron/blob/v44.5.1/shell/browser/api/electron_api_web_contents.cc#L4610-L4625), latest stable major on the check date                                       | Same synchronous decision, with a focus restoration wrapper.             |
| [Electron 45.0.0-alpha.14](https://github.com/electron/electron/blob/v45.0.0-alpha.14/shell/browser/api/electron_api_web_contents.cc#L4956-L4970), latest prerelease on the check date                       | Still resolves immediately.                                              |
| [Upstream main at `df79406cecfd393f38d5a18b83379d4ba85cc29b`](https://github.com/electron/electron/blob/df79406cecfd393f38d5a18b83379d4ba85cc29b/shell/browser/api/electron_api_web_contents.cc#L5694-L5708) | Still resolves immediately.                                              |

The [public event documentation](https://www.electronjs.org/docs/latest/api/web-contents#event-will-prevent-unload) exposes no asynchronous response handle. Its synchronous `preventDefault()` permits unloading. The checked versions therefore do not supply a stock upgrade that completes #48. Release labels are time-sensitive; the source references above are fixed.

Electron already passes ordinary JavaScript dialog callbacks into its JavaScript bridge: [pinned C++ implementation](https://github.com/electron/electron/blob/v44.3.0/shell/browser/api/electron_api_web_contents.cc#L4442-L4461). Current upstream [JavaScript dialog handling](https://github.com/electron/electron/blob/df79406cecfd393f38d5a18b83379d4ba85cc29b/lib/browser/api/web-contents.ts#L410-L464) awaits `dialog.showMessageBox`, tracks abort controllers, and handles cancellation. This establishes a nearby implementation pattern, not an existing beforeunload API.

Electron 44.3.0 [pins Chromium 152.0.7977.78](https://github.com/electron/electron/blob/v44.3.0/DEPS#L3-L5). That Chromium exposes a [one-shot embedder dialog callback](https://github.com/chromium/chromium/blob/152.0.7977.78/content/public/browser/javascript_dialog_manager.h#L18-L47). Its [beforeunload dispatch](https://github.com/chromium/chromium/blob/152.0.7977.78/content/browser/web_contents/web_contents_impl.cc#L8699-L8745) retains the response chain and defers commits in the affected WebContents. Source inspection supports a narrow Electron bridge change; it does not prove exact POST behavior in a modified binary.

## Proposed API contract

The following names and signatures are proposed; none exist in stock Electron:

```ts
webContents.setBeforeUnloadHandler(handler, { timeoutMs })

// handler(details, respond)
// details: { requestId, frame, isReload, signal }
// respond(true): Leave; respond(false): Stay
```

Use a single registered handler per WebContents, rather than multiple public listeners with conflicting answers. `null` unregisters the handler. With no handler, preserve the existing `will-prevent-unload` behavior. When the opt-in handler owns a request, it is the decision path; do not also invoke the legacy event as a second authority.

`requestId` identifies a native dialog generation within that WebContents. `frame` identifies the source frame, and native ownership additionally binds its document lifetime. `isReload` comes from Chromium. These details do not claim to provide a destination URL, navigation method or POST body: Chromium's renderer-origin dialog entry point does not always have a browser-side NavigationRequest. CookieMonster must not infer the destination from its current URL or fabricate missing request metadata.

`signal` is a main-process AbortSignal produced by the JavaScript bridge and backed by native cancellation. The handler may await an asynchronous dialog without resolving the native response. `respond` resolves once; a duplicate or late response is a harmless no-op. Handler exceptions, missing handlers after registration changes, teardown and expiry choose Stay. Validation must reject invalid timeout values before registration.

For a reviewable initial default, propose a 60-second native timeout, configurable from 1 millisecond to 5 minutes. Capture the absolute deadline at request creation; elapsed time and repeated prompts never extend it. CookieMonster would apply its existing, possibly shorter operation deadline. These timeout values are proposed policy, not measured requirements or an existing Electron guarantee.

Internally, a dedicated `-run-before-unload-dialog` bridge event can carry the details and response function, following ordinary dialog callback conversion. A matching cancellation notification would abort the exact bridge request. These private events remain Electron implementation details; CookieMonster should consume the eventual public API only.

## Native ownership and settlement

The native owner should retain the original `DialogClosedCallback`, a weak WebContents/frame/document identity, request generation, captured pending-load association when available, and a finite deadline. It should resolve on the browser UI thread and release those resources on every terminal path.

| Trigger                                                                             | Required result                                                                                                                                   |
| ----------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------- |
| Current owner answers Leave before the deadline                                     | Validate the native generation and source document, then resolve the original callback with `true` once.                                          |
| Stay, handler failure or deadline                                                   | Resolve with `false` once and abort the bridge signal.                                                                                            |
| `CancelDialogs`, destruction, renderer crash, source replacement or handler removal | Cancel the retained request and signal; late answers cannot continue another operation. Teardown must respect Chromium's callback lifetime rules. |
| Competing browser-owned navigation or close                                         | Cancel or serialize the original operation before transferring ownership. Never reuse its answer for the newer request.                           |
| Agent operation loses task ownership or consent, is canceled, or expires            | CookieMonster cancels the handle before returning. User-owned navigation keeps its distinct user ownership.                                       |

Cancellation must be observable while a dialog is waiting, not only when the answer arrives. Handler replacement cancels outstanding requests created under the old handler. The retained callback must not hold a strong reference that prevents WebContents destruction.

Native admission should allow at most one active confirmation generation per WebContents. A second native request cannot replace the first callback silently or share its approval. Coalescing is permissible only when native identity proves it is the same pending operation; otherwise cancel the new request or serialize it. Chromium documents additional renderer-origin/subframe dialog cases, so a URL comparison alone cannot establish identity: [pinned frame dispatch](https://github.com/chromium/chromium/blob/152.0.7977.78/content/browser/renderer_host/render_frame_host_impl.cc#L7460-L7488).

The API retains native request semantics. CookieMonster must never read and rebuild form bodies as a fallback. For renderer-origin submissions, the pending renderer operation and callback chain must remain intact; for browser-owned requests, the native NavigationRequest remains authoritative. Whether URL-encoded, multipart/file and redirect cases preserve their original semantics requires native tests.

Electron's existing pending-load error reporting is tied to `pending_unload_url_`. Moving its decision later requires capturing the original association and preventing a denied old request from reporting failure against a newer load. Preserve exactly-once `ERR_ABORTED` reporting for affected `loadURL` promises. Keep the newer runtime's focus restoration behavior around final settlement; confirmation must not leave the renderer unable to accept physical keyboard input.

## Renderer and debugger constraints

An asynchronous callback frees Electron main; it does not unfreeze the affected page while the user decides. Chromium [blocks input for tabs sharing the affected renderer and stops beforeunload timers](https://github.com/chromium/chromium/blob/152.0.7977.78/content/browser/renderer_host/render_frame_host_impl.cc#L7491-L7517). It [unblocks the renderer and restarts those timers after settlement](https://github.com/chromium/chromium/blob/152.0.7977.78/content/browser/renderer_host/render_frame_host_impl.cc#L12720-L12734). The native timeout must therefore run independently in main. The proposed Electron API alone cannot promise that every same-process tab stays interactive.

Enabled DevTools Page handlers also receive a response callback through the [same Chromium dispatch](https://github.com/chromium/chromium/blob/152.0.7977.78/content/browser/web_contents/web_contents_impl.cc#L8730-L8745). Holding Electron's copy does not prevent another debugger from answering first. CDP cancellation/acceptance must be covered in qualification, with stale Electron handles retired after external settlement. Agents must not gain raw `Page.handleJavaScriptDialog` access around main's consent checks. If untrusted external CDP clients must be prevented from resolving the dialog, this becomes a broader Chromium arbitration requirement; the narrow Electron patch does not establish exclusive authority over them.

The stock limitation remains: once a dialog has closed, [CDP clears its pending callback](https://github.com/chromium/chromium/blob/152.0.7977.78/content/browser/devtools/protocol/page_handler.cc#L662-L672). Attaching a debugger and answering later does not recover a canceled request.

## Minimal Electron review surface

Start from a fixed supported Electron release, record its Chromium revision, and review these modules together:

| Electron module                                                                                                                                      | Proposed responsibility                                                                                                               |
| ---------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------- |
| [`shell/browser/api/electron_api_web_contents.cc`](https://github.com/electron/electron/blob/v44.3.0/shell/browser/api/electron_api_web_contents.cc) | Opt-in beforeunload dispatch, original callback retention, guarded settlement, cancellation hooks and pending-load error association. |
| [`shell/browser/api/electron_api_web_contents.h`](https://github.com/electron/electron/blob/v44.3.0/shell/browser/api/electron_api_web_contents.h)   | Per-WebContents pending ownership and lifetime declarations.                                                                          |
| [`lib/browser/api/web-contents.ts`](https://github.com/electron/electron/blob/v44.3.0/lib/browser/api/web-contents.ts)                               | Public handler registration, request signal and dedicated internal bridge listeners.                                                  |
| [`typings/internal-electron.d.ts`](https://github.com/electron/electron/blob/v44.3.0/typings/internal-electron.d.ts)                                 | Internal bridge declarations.                                                                                                         |
| [`docs/api/web-contents.md`](https://github.com/electron/electron/blob/v44.3.0/docs/api/web-contents.md)                                             | Public contract and generated public type inputs; do not hand-edit generated type output.                                             |
| [`spec/api-web-contents-spec.ts`](https://github.com/electron/electron/blob/v44.3.0/spec/api-web-contents-spec.ts) and necessary native test support | Real navigation, lifecycle, competing responder and compatibility regressions.                                                        |

This is the intended review surface, not a claim that these files alone will prove sufficient. Prefer existing weak-lifetime, one-shot callback and timer primitives. A Chromium patch is not currently justified for ordinary trusted-embedder continuation; exclusive control over untrusted debugger responders would change that scope.

## Qualification matrix

Use disposable profiles, loopback servers and synthetic drafts. The server must record method, body bytes and request count independently of renderer assertions.

| Area                | Required evidence                                                                                                                                                                        |
| ------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Original request    | Link, GET form, URL-encoded POST, multipart POST/file upload; leave sends the original operation once with expected body and headers. No reconstructed submission.                       |
| Redirects           | 302/303 method conversion and 307/308 method/body preservation follow Chromium's native behavior; assert each expected network hop and no duplicate initial submission.                  |
| Stay                | Zero destination requests, same source document and exact draft retained, input usable after settlement.                                                                                 |
| Other leave intents | Address navigation, history, reload and close, including existing legacy event compatibility and `loadURL` promise results.                                                              |
| Responsive main     | Hold confirmation open while timers, bridge HTTP work and operations in a separate renderer progress. Record renderer process IDs.                                                       |
| Process sharing     | Repeat with same-origin tabs that actually share a renderer; document Chromium's input blocking and ensure main/shell remain responsive. Do not infer process sharing from origin alone. |
| Lifecycle           | Cancel, destroy, crash, hide/owner loss, remove/replace handler, source replacement, task change, consent revocation and deadline before/after an answer.                                |
| Races               | Duplicate/late responses, competing close/navigation, repeated requests and subframe beforeunload; no approval transfers between generations.                                            |
| Debugger            | Attached CDP, external Stay/Leave, detach and DevTools closure; no stuck native handle or second continuation after another responder wins.                                              |
| Focus               | Physical keyboard input after Stay and native dialog closure on Windows; equivalent supported-platform tests, including macOS.                                                           |
| Packaging           | Run the packaged branded app with the exact custom runtime; report architecture, Electron/Chromium versions, binary hashes and source revisions.                                         |

## Build and distribution boundary

Until upstream ships this API, the work requires a custom Electron binary. An application dependency bump, an npm JavaScript patch or a native addon around private pointers does not supply the proposed supported callback contract.

The runtime owner would need to build the selected Electron/Chromium revision for each required platform and architecture, distribute those artifacts privately, pin their bytes in CookieMonster's dependency/build pipeline, qualify installer/runtime compatibility, and carry or retire the patch during security updates. CookieMonster's branded release target is macOS; Windows native development evidence does not qualify that release. Signing and notarization remain part of the release path. Existing private-distribution restrictions continue to apply.

An upstream contribution avoids a permanent private patch after adoption, but its acceptance and release timing are unknown. Approving a prototype build would not approve changing CookieMonster's production runtime or release pipeline.

Without a custom binary, this proposal cannot validate compilation, callback conversion and destruction semantics, original POST preservation, exact race/cancellation behavior, physical focus restoration, shared-renderer behavior or packaged compatibility. The existing native fixture proves the stock limitation only. Completion of #48 requires the new runtime capability, its tests, then a separately reviewed CookieMonster adapter and native end-to-end qualification.
