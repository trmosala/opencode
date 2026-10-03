# Authenticated embedded input qualification for #40

Issue: [#40](https://github.com/trmosala/opencode/issues/40). This record covers read-only acceptance in the real Teams tab on 3 October 2026. The agent used CookieMonster's bundled browser plugin, utility-process sidecar and main-process routing with `cookiemonster/CM_Opus5.5-High`. The parent independently inspected the actual native window. No standalone browser or Teams desktop operation substitutes for those tool calls.

## Runtime

Windows x64 development instance, Electron 44.3.0 / Chromium 152.0.7977.78. The desktop build passed before launch at `2026-10-03T07:27:00.9290398Z` from source checkout `2d582ec4484fad03b3f6792c1eab2275e682d1cf`. Later commits before this test changed qualification documentation only. The same launch artifacts were hashed again immediately before acceptance:

- `packages/desktop/out/main/index.js`: SHA-256 `CBAD9964C463B9EDB24CDEC891F510879BA764633CD178A87FF3885C122F450E`
- `packages/cm-browser/dist/plugin.mjs`: SHA-256 `108D97E4867231360C39216A316F019B778B64D7C8FC0199E2D04BAA1FB1AE94`

The user completed Microsoft sign-in and enabled the restored Teams tab's Agent Access. No additional origin grant or operation approval appeared during the tests, including input in the embedded Outlook calendar. The temporary test session enabled only observation, navigation clicks, scrolling and Escape dismissal. Filling, typing, messaging, event responses and calendar edits were excluded.

## Live observations

| Check                    | Evidence                                                                                                                                                                                                                                                                                                                                               | Result |
| ------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------ |
| Previous week            | A fresh embedded button ref changed the label from 28 September–4 October to 21–27 September. The tool returned `dispatched_observed`; a separate read and native-window observation confirmed the changed week.                                                                                                                                       | Pass   |
| Restore week             | A fresh next-week ref restored 28 September–4 October. The tool returned `dispatched_observed`; a separate read and native-window observation confirmed restoration.                                                                                                                                                                                   | Pass   |
| Actual scroll movement   | An element-anchored embedded `browser_scroll` sent `deltaX: 0`, `deltaY: 300` and returned `dispatched_observed`. Before/after screenshots and native-window observations showed hour rows moving from approximately 10–13 to 14–17. The week label stayed unchanged. Successful dispatch alone was not used as proof of movement.                     | Pass   |
| Open existing event      | A fresh ref opened one visible timed work event. The tool returned `dispatched_observed`; an independent embedded-frame read exposed its detail fields, and both a screenshot and native-window observation confirmed the preview was visible. No Join, Chat, edit or response control was used.                                                       | Pass   |
| Close preview            | The first Escape and a subsequent frame-scoped read were refused with `unavailable`; the preview remained open. A new whole-tab read reacquired the calendar frame. Immediate Escape to that fresh binding returned `dispatched_observed`; a separate read and native-window observation confirmed the preview closed. Event opening was not repeated. | Pass   |
| Restore initial Day view | Fresh refs opened the responsive toolbar overflow and view submenu, then selected Day. The selection returned `dispatched_uncertain` during replacement; a separate whole-tab read and native-window observation confirmed Day view on 3 October 2026, with the preview and menus closed and the navigation pane hidden.                               | Pass   |

## Recovery and limits

Opening Calendar and selecting Week initially returned `dispatched_uncertain` with `observation_failed` during document replacement. Subsequent reads confirmed each operation had taken effect; those actions were not blindly repeated.

A calendar navigation-pane overlay then obscured the controls. Previous-week and pane-toggle refs were refused with `unavailable` and no visible effect. Screenshot observation identified the overlay. One embedded Escape operation returned `dispatched_observed`, and a separate read, screenshot and native-window observation confirmed dismissal. Week navigation then succeeded with fresh refs. These refusals and recovery are part of the evidence; this is not a claim of an error-free run or proof of a specific internal cause for every refusal.

Closing the event preview also required reacquiring a usable frame binding. The failed frame-scoped read established that the old binding was unusable; it does not prove the internal cause. Closing with the fresh binding succeeded without a screenshot or inventory refresh between acquisition and dispatch. No tab-scoped fallback was needed, and no unsupported operation was silently redirected to another document.

The initial test restrictions omitted keyboard input. They were updated to permit Escape, and a fresh model execution loaded the updated tool roster. The agent execution also compacted its existing history before continuing; no app or server restart occurred during this acceptance run. All successful mutations of the visible interface were navigation or dismissal only. The initial Day view and date were restored after the checks.

Earlier [embedded input and clipped-editor qualification](./clipped-input-qualification.md) covers nested cross-origin click, hover, drag, fill, key, selection, scrolling, supported transforms, stale references, replacement, revocation and focus guards using synthetic documents. It includes 170 focused tests / 1,647 assertions and native fixtures, with no changes to real account data. This live record supplies the authenticated week, scroll and event-observation checks required by #40.

No event titles, account identity, attendees, meeting links, event descriptions, report content or authenticated screenshots are published here. This is Windows development qualification; macOS and packaged builds remain unqualified. The stopped timesheet report was not resumed or sent, and no calendar data was changed.
