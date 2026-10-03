# Page-origin leave requests: qualification for #48

## Current result

Address-bar navigation, history, reload and tab closure already have asynchronous Stay/Leave confirmation. Their source intent is owned by main and can be retried once after Chromium settles the original veto. Unknown page links and form submissions remain vetoed with guidance. This preserves the live draft but does not satisfy Leave continuation for those requests. Issue #48 must remain open for that limitation.

The unresolved boundary is in Electron 44.3.0, the desktop's pinned runtime. [`WebContents::RunBeforeUnloadDialog`](https://github.com/electron/electron/blob/v44.3.0/shell/browser/api/electron_api_web_contents.cc#L4463-L4477) emits `will-prevent-unload` synchronously and immediately runs the native callback with the event's result. It exposes no asynchronous response handle. Returning from the event while an asynchronous dialog is open has already canceled the native navigation, including any POST body.

CDP does not retain that request. Chromium reports `Page.javascriptDialogOpening`, then Electron resolves the callback and `Page.javascriptDialogClosed` reports false. A later `Page.handleJavaScriptDialog({ accept: true })` rejects with `No dialog is showing`. Chromium's [pinned Page handler clears its pending dialog callback when the dialog closes](https://github.com/chromium/chromium/blob/152.0.7977.78/content/browser/devtools/protocol/page_handler.cc#L662-L672).

No production workaround was added. Repeating a DOM click or submission can rerun site handlers, duplicate side effects or alter form data. Reconstructing a request from its URL loses method, body and other native navigation semantics. Suppressing a site's beforeunload handler would discard the user's unsaved work without the required decision.

## Native regression

From `packages/desktop`, run:

```sh
bun scripts/browser-smoke.ts --leave-confirmation
```

The existing Stay/Leave/close/history/reload/concurrent-navigation/cancellation checks still run. Added cases use an isolated loopback HTTP server and synthetic drafts only:

- A page link, GET form and POST form each retain the source document and its exact unsaved input when beforeunload vetoes them.
- The server sees no target request from the vetoed action, and a late CDP acceptance cannot replay it.
- CDP witnesses the opening and immediate rejection of the beforeunload dialog on the real native view.
- Main-process timers and an independent HTTP request continue to progress.
- A new explicit submission after the fixture removes its own beforeunload handler sends exactly one native request. The GET/POST payload preserves spaces, plus, ampersand and Unicode text. This is witness qualification, not a delayed Leave replay.

Windows native validation on 3 October 2026 passed this combined fixture twice consecutively in approximately three and four seconds. One intermediate run timed out before those passes. An earlier fixture-only UTF-8 response-header omission was corrected before the passing runs. Desktop `bun typecheck` passed before parallel resource-policy integration; its final cumulative check belongs to that integration. Scoped lint on the fixture reports zero errors and 12 warnings, chiefly the existing Electron fixture type assertions. No authenticated third-party page, macOS, packaged build or physical dialog accessibility is qualified here.

## Active cancellation follow-up, 3 October 2026

The stock-runtime confirmation now dismisses while waiting when its captured task/access authority changes, the source document commits another navigation, the renderer/window is lost, the agent cancels, or the original absolute deadline expires. Closure-only authority checks also run every 100 milliseconds. The final answer is revalidated. Cancellation signals dismiss the dialog, but its native/busy lease remains held until the dialog and original native attempt settle.

Stop aborts the exact pending user leave intent before stopping the load. A late Leave answer cannot restart it. The isolated Stop reproduction failed twice before this change with `Stop must dismiss a waiting Leave confirmation before an answer`, then passed after it.

The native leave fixture adds waiting Stop, task change, access revocation, same-document navigation, agent cancellation and agent deadline cases. Each checks dialog abortion, retained tab/draft, observer cleanup and no late replay. Agent close receives the original signal and deadline through the native tab-action boundary. These tests use real Electron views and Chromium beforeunload, with controlled message-box answers.

The broader tab-lifecycle fixture also exposed a pre-existing close-result bug, reproduced against unchanged committed sources. Normal native destruction revoked tab access and incorrectly canceled the successful close reply. The router now lets native close acknowledgement determine that destroyed tab's result; explicit revocation while it is alive still cancels. Unit regressions cover both paths and native lease retention.

The lifecycle fixture's old synchronous-dialog controls were replaced with asynchronous controls. It now expects one native veto followed by one main-owned close retry on Leave. Its HTTP 204 recovery case gives the retained page fresh trusted input before expecting another unload prompt. An approved unload followed by a retained document does not itself guarantee a second Chromium prompt.

Verification for this follow-up:

- The six focused desktop unit suites pass 178 tests and 1,212 assertions.
- `bun scripts/browser-smoke.ts --leave-confirmation` passes the six added cancellation cases and existing Stay/Leave/history/reload/close/concurrent intent and page-request veto cases. A concurrent run alongside the tab-lifecycle GUI fixture timed out in the page-link witness. The subsequent serial run passed in 4.6 seconds. Run native GUI fixtures serially; their desktop focus is shared.
- `bun scripts/browser-smoke.ts --tab-lifecycle` passes, including paused-renderer early cancellation, revocation/native settlement, HTTP 204/Stop/disconnect recovery, and an actual unparented Windows lifecycle-consent dialog closed through AbortSignal. An earlier run timed out in the stale synchronous-control recovery cases before those controls were corrected.
- Desktop `bun typecheck` passes. Lint on the nine changed TypeScript files reports zero errors and 111 warnings, including existing warnings and fixture type assertions. Formatting and whitespace checks pass.

This follow-up does not add a native asynchronous beforeunload callback or page-origin Leave continuation. The production leave dialog remains parent-modal, and its `owner.suspended` state hides browser views while it waits. Main-process progress therefore does not prove that other tabs or the parent shell accept physical input. The Windows native fixtures do not qualify macOS, packaged runtime behavior, physical keyboard focus or an authenticated site's unsaved-state behavior. The live signed-in application was not restarted or rebuilt for this follow-up. No calendar, timesheet or chat data was changed.

## Preferred implementation boundary

Complete support needs a supported native Electron API that retains the original beforeunload callback and gives main a one-shot asynchronous decision handle. It must continue or cancel Chromium's original pending request, including its POST body, rather than issue a replacement request. This should be developed or adopted at the Electron boundary before changing the browser's page-origin behavior; this repository does not currently own a custom Electron build.

The [native API proposal](./async-leave-native-proposal.md) records source checks against the pinned runtime, a newer stable release, prerelease and upstream main; the proposed callback lifecycle; renderer-sharing and debugger constraints; and the build and qualification work. None of the checked versions exposes the required asynchronous handle. The proposal does not implement the capability or complete this issue.

Main would bind that handle to the exact WebContents/document, task owner, current intent, operation cancellation and absolute deadline. Stay, lost ownership, revocation, window hide/closure, document replacement, debugger detachment and expiry must cancel the handle and close the dialog. Leave must validate authority immediately before resolving it once. Competing navigation must cancel or serialize the original request without reusing the answer for a new destination.

Qualification for that API must hold a real confirmation open while a second tab and main-process timers progress; exercise link, GET, URL-encoded and multipart POST, redirects, history and closure; assert one server request with the original bytes on Leave and zero requests plus an unchanged draft on Stay; and reject stale, canceled, revoked and expired approvals. The current native regression establishes the public-API limitation, not completion of those future requirements.
