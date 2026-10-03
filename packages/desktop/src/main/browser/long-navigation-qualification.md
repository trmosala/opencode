# Long native authentication navigation

## Result

On 3 October 2026, the signed-in Teams tab stopped at a white Microsoft terms handoff page. A bounded live observation twice reported a completed document with no visible text and zero body height. Its current URL was 190 characters, its hidden POST form targeted a 72-character Microsoft login URL, and its inline script submitted that form. No credentials, hidden input values, cookies, request bodies or full authentication URLs were captured in the diagnostic output.

The earlier native URL-length fix remained uncommitted in the separate `teams-login` checkout. It was absent from the current `browser-gaps` build. Its files were inspected without changing that checkout or copying its older browser implementation wholesale.

A normal fresh navigation to `https://teams.cloud.microsoft/` recovered the live signed-in interface on the unchanged running app. The observed retry used short Microsoft/Teams redirects. The original failed authentication hop was not captured, so the URL limit is a confirmed implementation gap and synthetic reproduction, not a proven cause of that particular Microsoft handoff. Recovery did not require restarting the app or server, extracting tokens or replaying the stopped POST manually.

## Policy

Native browser navigation, redirects, scripted page navigation, popups, human links and bookmarks accept supported HTTP(S) destinations through 65,536 characters, checking both raw input and canonical encoded URL length. The same policy protects native redirects that follow an agent action. Explicit agent destination inputs retain their 2,048-character protocol limit. Scheme, credential and origin restrictions are unchanged.

Supported recovery history retains long native URLs within that bound. Existing source identity and legacy recovery records remain compatible, including oversized history sources; oversized navigation stacks remain omitted. Long pages still resolve site and zoom preferences to their exact origin. Empty bookmark titles use a bounded URL fallback so saving a long URL does not produce invalid title metadata.

## Reproduction and validation

Run from `packages/desktop`:

```sh
bun scripts/browser-smoke.ts --long-navigation
bun test ./src/main/browser/policy.test.ts ./src/main/browser/router.test.ts ./src/main/browser/tab-recovery.test.ts ./src/main/browser/link-destination.test.ts ./src/main/browser/bookmark-format.test.ts ./src/main/browser/site-permissions.test.ts ./src/main/browser/presentation-preferences.test.ts
bun typecheck
```

Before the production fix, the native fixture failed with `expected 2096 characters, observed 45` and a `will-redirect` witness reporting `length:2096,cancelled:true`. It reproduced a blank auto-submitting POST shell whose short endpoint returned a long HTTP 302 destination.

After the fix, the Windows Electron 44.3.0 fixture passed POST/302/GET handoffs at 2,096 and 8,192 characters with an exact synthetic UTF-8 payload and one POST per case. It also passed direct UI navigation, scripted navigation, a fresh private popup and an actual prepared agent route from a short requested URL to a long native redirect. The guarded redirect witness reported no cancellation, explicit long agent destinations remained rejected, and previous POST handoffs were not replayed.

Independent review found that Unicode URL encoding could expand an accepted raw URL beyond the limit and leave unreadable bookmark metadata. Policy and bookmark-import regressions failed before adding the canonical-length check and passed afterwards. The native navigation fixture passed again after this correction.

The seven focused desktop suites passed 129 tests / 1,031 assertions. App and desktop typechecks and the branded desktop build passed. The compiled main bundle contains the final canonical-length guard. Scoped lint reported no errors and existing warnings; the build emitted existing dependency/eval/chunk warnings. These tests use disposable profiles and loopback pages. They do not establish the original Microsoft failure's cause, a clean initial authenticated login on the corrected running app, calendar agent parity, macOS or packaged-app behavior. The live app remains on its previously compiled main process; the source fix takes effect on a future launch of the rebuilt desktop.
