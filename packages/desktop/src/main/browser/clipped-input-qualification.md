# Clipped controls and multiline fill qualification

Issue: [#40](https://github.com/trmosala/opencode/issues/40). Qualified on Windows on 3 October 2026 using Electron 44.3.0 / Chromium 152.0.7977.78, disposable profiles and synthetic documents. These checks reproduce the failure pattern seen during the Teams workflow; they do not prove the exact cause on that live page or qualify the newly rebuilt app against Teams.

## Failures and changes

The original native fixture returned `stale_ref` and `not_dispatched` for a fresh reference to a growing contenteditable inside a 180-pixel scrolling composer. It dispatched zero clicks, keys or input events. Reducing only the draft from 15 to 14 lines permitted dispatch; removing only overflow clipping also permitted dispatch with 30 lines. The reference's full-element center was outside the reachable area.

Reference validation now preserves the original center when its exact composed hit test succeeds. Otherwise it intersects the element with the viewport and supported ancestor overflow bounds, then applies the same hit test to the fallback point. Document generation, node identity, ancestry, writable kind and focus checks remain in force. Fully clipped or covered controls still fail. Snapshot observations retain their original geometry; fallback geometry is used during reference validation only.

The first successful geometry probe exposed a separate fill bug: the requested newline was absent from the resulting draft. A 7,349-character synthetic report also exceeded the existing 15-second deadline during character-by-character filling and left partial text with `dispatched_uncertain` status.

Top-level fill now matches the existing embedded implementation: select and clear, then perform one guarded native `Input.insertText` operation. It preserves multiline text without an Enter or Tab keyboard action that could submit a chat or change focus. Native focus, source, access and reference checks run before and after insertion. Failure after dispatch remains uncertain and never triggers automatic replay. Explicit `browser_press_key` semantics are unchanged.

## Native coverage

Run from `packages/desktop`:

```powershell
bun scripts/browser-smoke.ts --clipped-editor
bun scripts/browser-smoke.ts --snapshots
bun scripts/browser-smoke.ts --embedded-input
bun test ./src/main/browser/driver.test.ts ./src/main/browser/router.test.ts ./src/main/browser/registry.test.ts ./src/main/browser/frames.test.ts ./src/main/browser/frame-identity.test.ts
bun typecheck
```

The new fixture creates a real native tab, grants access once and uses production read, preparation and dispatch routes for both top-level and nested documents. It asserts exact short multiline/tab text and the full 7,349-character replacement, native input receipt and zero Enter-to-send events. Independent fill observations completed in approximately 126–178 milliseconds before the additional scroll cases were added.

Both surfaces also assert that an element-anchored wheel scroll moves the composer from 0 to 160 pixels, receives a trusted wheel event, preserves the draft and dispatches no click, keyboard, input or submission events. The original-center scroll failure was not separately rerun; the original fill failure exercises the shared reference resolver.

Refusal cases cover fully clipped and opaque-covered editors with zero input. Compatibility cases cover inline and `display:contents` wrappers plus fixed and absolutely positioned controls that escape an overflow ancestor. Review caught the positioned-control regression before completion: the clipped-only implementation failed its native witness, and preserving the original validated center made it pass.

The existing snapshot fixture passed its real input/textarea/contenteditable checks and its changed submit type, readonly, editability, node replacement, ancestry, shadow/slot and overlay guards. Its old expectation of per-tool approvals was corrected to assert no additional approvals under the approved whole-tab contract. The existing embedded-input fixture passed nested cross-origin transformed click, hover, drag, fill, key, selection and scrolling.

Independent focused validation passed **170 tests / 1,647 assertions** and the desktop typecheck. Driver regressions additionally cover replacement and revocation after clearing and after native insertion. Scoped lint reports zero errors and existing warnings; formatting and whitespace checks pass. This is focused Windows qualification, not a full-repository, packaged or macOS check.

## Live acceptance

The earlier running process did not include these changes and its launch hashes were not pinned. Authenticated calendar reading and day navigation from that process are documented separately in [embedded-state qualification](./embedded-state-qualification.md).

After explicit user authorization to override the restart restriction, the updated desktop build passed and a development instance started on 3 October 2026 at `07:27:00.9290398Z` from checkout `2d582ec4484fad03b3f6792c1eab2275e682d1cf`. The launch uses the absolute built entry path, the same persistent profile and an isolated bridge on port 8791. The bridge returned healthy. The exact unsent draft text was saved locally before shutdown; it was not transmitted or committed.

Launch artifact SHA-256 hashes:

- `packages/desktop/out/main/index.js`: `CBAD9964C463B9EDB24CDEC891F510879BA764633CD178A87FF3885C122F450E`
- `packages/cm-browser/dist/plugin.mjs`: `108D97E4867231360C39216A316F019B778B64D7C8FC0199E2D04BAA1FB1AE94`

The normal development relaunch initially failed because the relative entry path was resolved after the app changed its working directory to the home directory. Launching the same build with an absolute entry path succeeded; no startup-path source fix is claimed.

Native observation of the rebuilt instance initially showed Microsoft's account picker and the restored tab's Agent Access off. The user subsequently completed sign-in and enabled access. The [authenticated embedded-input qualification](./live-embedded-input-qualification.md) records successful week navigation and restoration, measured calendar wheel movement, and opening/closing an existing event preview through the bundled agent tools. The parent independently verified those results in the native window. No additional origin grant or operation approval appeared, and no real calendar edits or report transmission were performed. This live evidence completes the remaining #40 acceptance checks alongside the synthetic/native coverage above.
