# Inactive tab resource qualification

Issue: [#47](https://github.com/trmosala/opencode/issues/47). Qualified on Windows on 3 October 2026 with Electron 44.3.0 / Chromium 152.0.7977.78, using disposable profiles and synthetic loopback pages.

Inactive live documents stay intact by default. **Unload tab** is an explicit user action for an inactive tab, with confirmation that only supported URL/history metadata can be restored. There is no automatic eviction of arbitrary pages. Recreated views have fresh tab identity, start with Agent Access off and do not load their destination until explicit selection. Unloading preserves tab order, the active sibling and the recently closed list.

The [resource policy](./resource-policy.ts) protects active, loading, pinned, granted, busy, transferring, media, unsaved and unknown cases. Native integration in [tabs.ts](./tabs.ts) also protects pending permissions, uploads, account operations, capture grants and recovering downloads. Its fixed isolated-world probe checks at most 10,000 elements and 257 document/shadow roots; exceeding either budget or failing/timing out protects the tab. Embedded documents and custom elements without inspectable open shadow roots are protected. This probe does not prove that arbitrary JavaScript state is saved. The confirmation discloses that page state cannot be restored, and native `beforeunload` can veto the close without being overridden or replayed.

Run from `packages/desktop`:

```powershell
bun scripts/browser-smoke.ts --resources
bun test ./src/main/browser/resource-policy.test.ts
bun typecheck
```

The [native fixture](./resource-policy.fixture.ts) first visits 12 synthetic chat-like pages, each with 400 transcript messages, editable draft controls, background timers and canvas updates. It then measures private lazy recovery separately, followed by a fresh 12-page visited workload using the production unload command. CPU samples call `app.getAppMetrics()` before and after a two-second interval. Memory is the sum of working-set sizes of the fixture's renderer process IDs, rounded to MiB; shared pages can be counted more than once. These values are process observations, not unique physical-memory usage or sustained energy measurements.

Three full unload qualification runs measured:

| Sample                                    | Before unloading                             | After unloading                          | Dormant tabs | Observed working-set difference |
| ----------------------------------------- | -------------------------------------------- | ---------------------------------------- | ------------ | ------------------------------- |
| First                                     | 12 renderers; 1,836 MiB; 0.03% aggregate CPU | 1 renderer; 142 MiB; 0.02% aggregate CPU | 11           | 1,694 MiB                       |
| Final default command                     | 12 renderers; 1,844 MiB; 0.04% aggregate CPU | 1 renderer; 142 MiB; 0.02% aggregate CPU | 11           | 1,702 MiB                       |
| Final with private reservation protection | 12 renderers; 1,842 MiB; 0.03% aggregate CPU | 1 renderer; 142 MiB; 0.02% aggregate CPU | 11           | 1,700 MiB                       |

The pre-policy baseline recorded 12 visited renderers / 1,363 MiB / 0.02% CPU. Private lazy restoration initially loaded one renderer / 112 MiB / 0% CPU, leaving 11 saved tabs dormant. Subsequent complete runs measured 1,821–1,823 MiB for the eager fixture and 153 MiB for initial lazy restoration. Machine/runtime conditions affect working-set values; the paired visited unload results above are the relevant production-command comparison. No sustained CPU reduction is established by these short samples.

Native checks passed for draft, pinned, granted, busy, privately reserved, active and group-transfer protection; cancellation; selection or document navigation during approval; a real trusted-input `beforeunload` veto; private destination/Back-history restoration; preserved position and fresh identity; and no HTTP requests during unloading. The real probe protected textarea drafts, embedded documents, open-shadow editor drafts, playing muted media and traversal-budget exhaustion. Ten unit cases verify each policy blocker and explicit clean inactive eligibility.

Qualification caught and fixed a production history projection bug: native `NavigationHistory` must be read through `getAllEntries()` and `getActiveIndex()` before calling `recoveryNavigation`. Initial media qualification failed because Chromium pauses hidden muted media to save power; the fixture now displays its own disposable view during the playback check. The trusted-input veto check also refreshes its native viewport and focus before clicking the fixture guard.

One additional run after adding the private-reservation guard reached the smoke runner's 60-second deadline after the lazy baseline and produced no completion result. A diagnostic rerun of the same production code passed all cases, including the reservation guard. The fixture now logs its visited-page, reservation, approval and native-veto stages. This did not reproduce or establish the timeout's cause; no timeout root-cause fix is claimed.

These results cover the Windows development fixture, not authenticated Teams/Outlook/WPP pages, macOS, packaged builds or every application's hidden state. Unknown JavaScript work, inaccessible document trees and unsupported editors cannot be certified safe by DOM inspection. Protected pages remain live; users can preserve their work or explicitly close them through the existing leave-confirmation flow. No provider/tool replay, automatic form submission or forced disposal was added.
