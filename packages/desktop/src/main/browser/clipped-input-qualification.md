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

## Remaining live acceptance

The running CookieMonster process was not restarted and does not include these new on-disk changes. Its exact launch hashes were not pinned. Authenticated calendar reading and day navigation are documented separately in [embedded-state qualification](./embedded-state-qualification.md). Live #40 acceptance still needs event-detail opening and verification of the rebuilt input/scroll behavior when the desktop is available. The last desktop observation was locked; no live account interaction or report transmission was performed for this change. Issue #40 remains open.
