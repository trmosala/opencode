# T3 sidebar behavior study

Study date: 2026-11-07. Target: the left thread sidebar, especially Working, Snoozed, and Settled.

## Status and evidence boundary

This is a source-backed study of the installed T3 Code 0.1.7 build, commit `322f6544dfad`, plus controlled live prompt experiments through the T3 connector. **Live state transitions were tested; visual sidebar observation remains blocked.** Do not treat this document as UX acceptance or evidence that CookieMonster matches T3.

The running application listens on port 3773. Opening its web interface through T3 preview reached `/pair`. Snapshot and evaluation calls each timed out after 15 seconds. The alternate browser host reported unavailable. No pairing credentials, application restart, or changes to existing chats were attempted.

The user authorized two dedicated test chats. Five prompts were sent across them; existing user chats were not used as test targets. The unrelated, already reviewed CookieMonster feature changes remain untouched by this study.

Evidence labels used below:

- **Installed source:** behavior read from the JavaScript shipped in the running application, rather than from a screenshot or a live interaction.
- **Live experiment:** controlled prompts and organization actions, followed by connector reads. These establish API-visible transitions, not row positions, animations, or button behavior.
- **Pending experiment:** a behavior still requiring a prompt or UI interaction.

## Main finding

T3's sidebar is an attention inbox with supporting sections. **Working is not the default category for all unsettled chats.** Working accepts an active or idle runtime, subject to specific exclusions; it does not require background tasks for an idle runtime. Pending approvals, user input, and subagent requests exclude a chat from Working, but pending guest messages alone do not. Settled and Snoozed have distinct purposes and coexist with pinned chats and the inbox.

The installed user's client settings have `sidebarWorkingShelfEnabled: true`, `boringSidebarEnabled: false`, and `legacySidebarEnabled: false`. This identifies the relevant configuration; the resulting screen could not be inspected. T3 also exposes alternate layouts, so descriptions of the normal Working section should not be generalized to every layout.

## Placement and transitions

| Condition                                                                                                       | Source-backed behavior                                                                                                            | Evidence                                                                             |
| --------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------ |
| Ordinary unsettled chat without an eligible runtime                                                             | Active inbox rather than Working                                                                                                  | `main` function `NV`; `usageLimits` functions `S` and `je`                           |
| Preparing, queued, starting, running, or waiting runtime                                                        | Eligible for Working when enabled and connected, subject to attention checks and higher-priority placement                        | `usageLimits.S`, `usageLimits.je`; imported active-runtime predicate `utils.eXe/nXe` |
| Idle runtime, including monitoring/background work                                                              | Eligible for Working even without background tasks, subject to the same exclusions                                                | `usageLimits.S`; runtime projection `utils.iXe`                                      |
| Approval, user input, or a pending subagent request                                                             | Not classified as Working by its predicate                                                                                        | `usageLimits.S`                                                                      |
| Actionable proposed plan after the run ends                                                                     | Not classified as Working                                                                                                         | `usageLimits.S`                                                                      |
| Normal work finishes                                                                                            | Working observer has a 2,000 ms grace period before returning the row; attention, failure, or placement changes bypass that grace | `usageLimits.ve`                                                                     |
| Return from Working                                                                                             | Inbox ordering considers the recorded return time, alongside run and placement timestamps                                         | `usageLimits.he`, called by `main.NV`                                                |
| Snoozed until a future time                                                                                     | Snoozed section while the snooze remains effective                                                                                | `session-logic.pe`; `main.NV`                                                        |
| Snooze deadline passes                                                                                          | Snooze is no longer effective                                                                                                     | `session-logic.pe`                                                                   |
| Snoozed chat gets an approval, input request, pending runtime/subagent request, guest request, or newer failure | Attention overrides the effective snooze                                                                                          | `session-logic.ue`, `pe`, and `me`                                                   |
| Explicit settled override                                                                                       | Settled section                                                                                                                   | `usageLimits.ke`; `main.NV`                                                          |
| Pinned chat without effective snooze or settled override                                                        | Pinned section, before the ordinary inbox                                                                                         | `usageLimits.ke`; `main.NV`                                                          |

The placement selector gives effective snooze precedence over settled, then pinned, then active/Working. Working is a derived section, not another durable organization override. Its routing also checks connectivity. The exact Working predicate requires a runtime in preparing, queued, starting, running, waiting, or idle; rejects pending approvals, user input, or a subagent request; and rejects an actionable plan when plan mode has a terminal latest run not owned by the runtime. A pending guest message is not an exclusion in this predicate, even though it affects labels and snooze. Eligibility and the row's visible status label are separate decisions.

The live connector sample contained running/unsettled and completed/settled records, and also idle/settled records. This confirms that execution status and settled state are separate fields. That initial sample alone did not prove lifecycle behavior; the controlled experiments below establish completion and new-prompt behavior. Opening a chat in the UI remains untested.

## What the sidebar communicates

Installed-source row labels include Pending Approval, Awaiting Input, Guest Request, Working, Connecting, Waiting, and Failed. Approval and input checks precede ordinary execution labels. Working and Connecting have pulsing indicators; Waiting has a quiet indicator. These are code-defined labels/styles, not visually verified appearances.

Section order is pinned, active inbox, Working, Snoozed, Settled. Working and Snoozed headers appear when they contain threads. The implementation keeps independent expansion state for Working, Snoozed, and Settled. Those settings default collapsed in the inspected component.

**The selected chat survives collapse.** When a section is collapsed, the helper returns its currently routed chat if present, rather than hiding every row. This preserves a navigation anchor while reducing clutter.

Settled initially exposes ten entries when expanded, with increments of 25 and an older-thread loading path. Snoozed entries sort by wake time, soonest first. Settled ordering prefers settlement time; Working uses user-authored send recency. Inbox ordering changes with the selected layout and Working setting, so it should not be described as a universal last-update sort.

Sources: `main.bV`, `NV`, `yV`; `threadSort.t`, `n`, `h`; `usageLimits.ge`, `he`, `dt`; `olderSettledShelf`.

## Actions and safeguards

- The context menu exposes Settle thread / Un-settle thread, Snooze / Wake thread, pin/unpin, and Mark unread when supported.
- Snooze presets include an expected return label. Custom snooze supports a future date/time or a positive duration. Presets are configurable; the settings describe them as sorted soonest first. Do not assume a fixed universal list.
- The UI disables snooze for pending approvals/input/runtime requests, pending subagent requests, guest requests, and prompt-start conditions. It is not a blanket prohibition on all running chats.
- Settle and snooze actions have Undo toasts. Some row actions are exposed on hover. Exact discoverability and hit areas are unverified.
- Dragging can pin, settle, or move a thread back into the active section. Working and Snoozed are not accepted as direct drop destinations in the inspected section-target logic. Pin and active ordering have separate handling.
- Settings expose inactivity-based auto-settle, auto-settle on PR merge, per-thread opt-out, and protection for threads with PRs. These are separate from the explicit Settle action. Their configured server values and live triggers have not been tested.

Sources: `main` context-menu builder around lines 19700–19805, action handlers around 19060–19230, custom snooze component `uP`; `usageLimits.Pe`, `Fe`, `ze`; `session-logic.fe`, `le`; `SettingsPanels` auto-settle and snooze settings.

The connector contract says settling the **current** thread applies at turn end, and a failed turn or queued message leaves it active. The experiment below separately tests self-settlement and settling another running thread. Failure and queued-message exceptions remain contract-only.

## Live prompt observations

Two dedicated top-level chats used `codex / gpt-6.1-sol`, high effort, in the existing project. All times below are UTC on 2026-11-07. Each started idle, unsettled, unsnoozed, with no runs. The prompts prohibited file changes, network access, and delegation; only harmless delays, the actual input-request tool, and self-settlement were permitted where required.

Test A: <t3-thread://v2/bd218a59-ae5e-4825-ab2c-cf69e90df225/thread:mcp:a11fab1d-6e20-4968-81c4-367c0ac600bf:t3-sidebar-study-two-tests-20261107:0>

Test B: <t3-thread://v2/bd218a59-ae5e-4825-ab2c-cf69e90df225/thread:mcp:a11fab1d-6e20-4968-81c4-367c0ac600bf:t3-sidebar-study-two-tests-20261107:1>

| Experiment                  | Action and observed result                                                                                                                                                                                                                                                                                                                                                                                        | Limit                                                                                                  |
| --------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------ |
| Concurrent runs             | At 14:46:24, sent A “Reply exactly READY” and B a 30-second delay then “DONE.” Both were read as running with distinct active run IDs. A completed at 14:46:30; B at 14:47:03. Both remained unsettled.                                                                                                                                                                                                           | Confirms concurrent execution and no immediate automatic settlement, not visible Working placement.    |
| Settle completed chat       | At 14:46:48, settled A. A subsequent read reported `settled: true`; its transcript remained available.                                                                                                                                                                                                                                                                                                            | Reading through the connector is not opening the chat in the UI.                                       |
| Prompt wakes settled chat   | Sent A “Reply exactly AGAIN.” Subsequent reads reported `settled: false`, `settledAt: null`; the response was AGAIN.                                                                                                                                                                                                                                                                                              | Connector send, not a composer click.                                                                  |
| Settle another running chat | Tried settling B during its first run. The API rejected it: “is still running. Stop it before settling.” B stayed running and unsettled, then completed normally.                                                                                                                                                                                                                                                 | This must not be conflated with the current-thread deferred-settle API.                                |
| Snooze expiry               | At 14:47:17, snoozed completed B until 14:48:02.893. A pre-deadline read reported `snoozed: true`. A post-deadline read reported false and a null deadline without a new prompt.                                                                                                                                                                                                                                  | These are API-visible fields; no claim about durable storage cleanup or row return timing.             |
| Attention overrides snooze  | Started A's third run with a 30-second delay followed by a real input-request tool. Snoozed A until 14:57:36.421 while running with zero pending requests. Before the question appeared, reads confirmed `snoozed: true`. At about 14:48:21, a real pending question existed (`pendingRequestCount: 1`), and the API reported `snoozed: false`, deadline null. No second prompt was sent before that observation. | Isolates attention from new-prompt and deadline wake. Visual inbox placement is still source-backed.   |
| Self-settle at turn end     | B called its own settle action at 14:48:44; the recorded tool result was `settlesWhenTurnEnds: true`. A subsequent running-state read still had `settled: false`. B replied SELF_SETTLED, completed at 14:49:06.148, and its settlement timestamp was 14:49:06.443.                                                                                                                                               | Confirms the successful current-thread path; failure and queued-message exceptions were not exercised. |
| Resolve attention           | Read the actual question “Sidebar test: choose alpha or beta”; answered Alpha through the pending-request API. A returned ACK, completed at 14:48:39, with zero pending requests.                                                                                                                                                                                                                                 | The coordinator answered the harmless test question.                                                   |
| Prompt wakes snoozed chat   | At 14:48:29, snoozed B until 14:58:29.847 and confirmed true. At 14:48:35, sent the self-settlement test prompt. During the new run, B reported unsnoozed, deadline null, and unsettled.                                                                                                                                                                                                                          | Distinct from the no-new-prompt attention experiment above.                                            |

Both test chats are now completed, settled, unsnoozed, and have zero pending requests. Their transcripts were retained.

The input question's generated ID was `0`; the request API supplied the actual ID and choices before the coordinator answered. A prose clarification question would not establish pending input and was not used as evidence.

Raw timestamped responses, exact prompts, thread/run IDs, and final cleanup reads are saved in `/tmp/t3-panel-study/live-results.json`. The table preserves the useful results if temporary evidence is removed.

## Remaining visual and exception checks

Browser automation could not inspect the actual sidebar. Still unverified: Working entry and its two-second exit grace in the rendered UI; row ordering and counts during concurrent completion; opening a settled chat; selected-row retention after collapse; drag targets and feedback; hover discoverability, keyboard behavior, and screenshots. These source-backed behaviors are not UX acceptance.

Failure, queued-input, pending-approval, monitoring, and automatic PR/inactivity settlement exceptions were not exercised. Do not manufacture a risky permission request merely to test attention; the harmless actual-input experiment already covers one attention path.

## Differences found before the implementation follow-up

This records the comparison at study time, before the user requested the implementation follow-up below:

1. CookieMonster currently has three mutually exclusive filters: Working, Snoozed, Settled. Every unclassified chat is Working. T3 has a separate active inbox and derived Working section.
2. CookieMonster's timed snooze persists through ordinary activity. Its current state selector does not model T3's attention-based snooze override.
3. Outside search, CookieMonster's filters hide other states; a nonempty search bypasses the workflow filter. T3 keeps section headers/counts together and preserves the selected chat inside a collapsed section.
4. CookieMonster's current settlement uses a pending flag and session update timestamps. T3 live tests establish new-message wake and reject externally settling an active run; equivalence with CookieMonster remains unproven.

The earlier Sol loop approved correctness of the implemented CookieMonster feature against its stated scope. It did not establish that its sidebar interaction model reproduces T3.

## CookieMonster implementation follow-up

The requested follow-up implements the four identified gaps in the shared app UI:

- Project chat lists now contain Pinned, Inbox, Working, Snoozed, and Settled sections. Idle chats default to Inbox; busy/retry execution without attention is Working. Normal completion has a two-second return grace, while permission requests, questions, and errors bypass it. A return timestamp promotes the chat within its project's Inbox.
- Section expansion persists by server, project, and section. Working, Snoozed, and Settled start collapsed, retaining the selected chat. Search reveals matches across states. Snoozes order by wake time; settlements by settlement time; Working by available user-message recency. Settled pages start at ten and grow by 25. Pin changes reveal the destination and reserve enough page space for both the moved chat and the retained selected chat.
- New user messages and attention wake snoozed chats. Saved workflow entries reconcile their prompt history after reload, including chats outside the two prefetched histories; failed reads can retry after index refresh or resumed session events. New entries store a backend-timestamp prompt watermark so client clock skew does not prevent wake-up. Attention also reopens settled chats. Clearing an attention request does not restore the old snooze. Mere metadata updates, including rename, no longer reopen a settled chat.
- Sidebar settlement is unavailable while execution is active or its initial status is unknown, matching the observed external-settle boundary. Older persisted pending-settlement requests still wait for initialized idle status and reconciled prompt history, and cancel on new input or attention. This is migration compatibility, not a new current-thread settlement API.

This uses CookieMonster's existing execution, question, permission, notification, and message data. T3-specific idle monitoring runtimes, guest requests, proposed-plan flags, PR/inactivity auto-settlement, configurable/custom snooze presets, Undo toasts, and section-drop organization are outside this follow-up. Existing project navigation and Recent sessions shortcuts are retained. The Claude-style split-chat interactions remain unchanged.

Implementation review: **APPROVE**, three rounds with gpt-6.1-sol on high effort. All four findings are resolved: persisted-history reconciliation (S1), unpin focus with selected-row retention (S2), backend-domain prompt comparisons (S3), and retry after failed reconciliation (S4). No findings were declined. Review scope grew from 1,160 additions / 64 deletions to 1,420 additions / 69 deletions across ten files, including existing split work and added regression fixtures. Usage was not exposed; nothing was committed or pushed.

Validation evidence is recorded in `/tmp/cm-sidebar-parity/ledger.json`. All 32 focused unit tests, 34 final browser cases, app/e2e typechecks, and scoped lint pass. The new regressions fail against the corresponding reviewed builds and pass with the fixes. Sol independently reran the unit tests and scoped whitespace check, and reviewed the browser/typecheck/lint evidence. The earlier wider browser run passed 77 of 87 cases; fixes and targeted reruns covered all ten failures, but the full wider suite was not rerun after the final fixes.

The production navigation benchmark passed before and after (stable selection 261 ms and 245 ms; one run each, not statistically significant). Browser checks use production CookieMonster builds with mocked backend data. This approval covers implementation correctness within the stated follow-up scope; it does not establish full T3 feature or visual parity, or live macOS Electron/WPP behavior. The study approval below remains separate.

## Requested sidebar layout follow-up

The user requested one T3-style sidebar: chats needing attention or review at the top, with Working, Snoozed, and Settled collapsed at the bottom. The shared app now has one server-wide Pinned/Inbox list and three bottom workflow sections, above Help and Settings. There are no duplicate per-project or Recent session rows. Project selection, editing, pinning, and opening remain under a compact Projects disclosure; open chat tabs remain in the top title bar for drag-to-split.

The bottom headers remain visible even when empty, default collapsed, and retain the selected chat as established in the study. Their scroll area is bounded so expanded history cannot consume the whole sidebar. Expansion state is now keyed by server and workflow section, independently of older per-project expansion preferences. Search reveals matching rows across all sections. Existing Settle/Snooze actions, wake-up safeguards, history reconciliation, focus restoration, and split behavior remain.

Attention requests promote older chats above ordinary Inbox rows. Normal completion returns a chat to the top of the ordinary Inbox after the existing two-second grace; questions, approvals, and failures return immediately. The request does not add the other T3-only runtime, auto-settlement, Undo, or organization-drag capabilities listed above.

Validation and a fresh Sol review for this layout change are recorded separately under `/tmp/cm-sidebar-layout/`. The first 40 wider browser cases passed; the remaining 50 cases passed after the mobile draft-navigation test was changed to use the sidebar. Sol round 1 correctly identified that this test change masked a real compact-tab selection/Close overlap (L1), and that global drafts lacked project labels (L2). The follow-up separates compact selection and Close targets, restores direct mobile tab selection coverage, and renders the project beneath every draft title. Dedicated LTR/RTL compact-tab and two-project draft regressions fail against the reviewed build and pass with the fixes. The round-2 run passed 42 of 43 cases; its remaining assertion used the wrong fixture project name. After correcting that expectation, all seven affected navigation cases passed, including the restored direct mobile tab flow. **Sol round 2: APPROVE**, with L1 and L2 resolved and no new material findings. The layout loop used gpt-6.1-sol on high effort in two rounds; no findings were declined and usage was not exposed. All 32 focused unit tests and both typechecks pass; the changed sidebar/controller files are lint-clean, while the titlebar retains pre-existing warnings outside the edited lines. Production navigation benchmarks pass before and after. This layout approval is separate from the earlier sidebar behavior approval. The reviewer inspected the source, compiled CSS, and regression logs and independently checked whitespace; it did not rerun the browser tests. Nothing was committed or pushed. Screenshot evidence uses production app builds with test chats; live macOS/WPP remains unverified.

## Reproducibility

The installed archive was read without changing it. Relevant assets were copied under `/tmp/t3-panel-study/bundle/apps/server/dist/client/assets/`; formatted reading copies are under `/tmp/t3-panel-study/readable/`. Function names below are minified export names in this exact build, not stable upstream APIs. Temporary evidence paths may disappear after cleanup.

| Asset                       | SHA-256                                                            |
| --------------------------- | ------------------------------------------------------------------ |
| `main-sk5g_Jie.js`          | `1cc2d181b7f1cab17909638e767f7046c3849af0a0fdd94bed1b52e9e3ff5a26` |
| `usageLimits-DPef9zw7.js`   | `f93d1ed5a087e3d30204f2c2471708367634dcf88b1c2ddd478495ce9fc1ea7d` |
| `session-logic-B7KSdKlx.js` | `e029c3ed7f96d170fac142468da5927fc3fead68161ed96cc629b98f69223339` |
| `threadSort-DAijm5mR.js`    | `db3727bd043808b24c931ed221b562cc4882c7356fa9c4ce73e0e6975283add7` |

Review status: round 1 requested changes D1–D3. Corrected the exact Working predicate, isolated the attention experiment using a real input request, and qualified CookieMonster filtering outside search. Round 2: APPROVE, all D1–D3 resolved and no new material findings. Reviewed with gpt-6.1-sol on high effort in two rounds. Approval covers source/live-state accuracy only; visual acceptance remains outstanding. The study grew from 110 to 125 lines with live evidence; no findings were declined, usage was not exposed, and nothing was pushed.
