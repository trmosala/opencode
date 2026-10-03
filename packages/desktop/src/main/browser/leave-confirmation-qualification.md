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

## Preferred implementation boundary

Complete support needs a supported native Electron API that retains the original beforeunload callback and gives main a one-shot asynchronous decision handle. It must continue or cancel Chromium's original pending request, including its POST body, rather than issue a replacement request. This should be developed or adopted at the Electron boundary before changing the browser's page-origin behavior; this repository does not currently own a custom Electron build.

The [native API proposal](./async-leave-native-proposal.md) records source checks against the pinned runtime, a newer stable release, prerelease and upstream main; the proposed callback lifecycle; renderer-sharing and debugger constraints; and the build and qualification work. None of the checked versions exposes the required asynchronous handle. The proposal does not implement the capability or complete this issue.

Main would bind that handle to the exact WebContents/document, task owner, current intent, operation cancellation and absolute deadline. Stay, lost ownership, revocation, window hide/closure, document replacement, debugger detachment and expiry must cancel the handle and close the dialog. Leave must validate authority immediately before resolving it once. Competing navigation must cancel or serialize the original request without reusing the answer for a new destination.

Qualification for that API must hold a real confirmation open while a second tab and main-process timers progress; exercise link, GET, URL-encoded and multipart POST, redirects, history and closure; assert one server request with the original bytes on Leave and zero requests plus an unchanged draft on Stay; and reject stale, canceled, revoked and expired approvals. The current native regression establishes the public-API limitation, not completion of those future requirements.
