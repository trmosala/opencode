# CM3 production integration

CM3 now presents CookieMonster's live application. The standalone prototype remains a design reference. The `quietCompanion` setting and Current UI return control are preserved.

- One production route tree owns conversations, streaming, tools, permission and question docks, prompt drafts, attachments, agent/model selection, review actions and the native browser. Switching CM3 changes presentation and navigation without mounting a second session or browser tree.
- The CM3 sidebar lists real sessions and projects through existing Home controllers, supports search and cross-server navigation, creates tasks, opens project folders, and offers loading/error/retry states. It does not register a second command palette.
- Theme controls use the shared Light/Dark/System preference. Scoped styles cover Light and Dark, the landing composer, live messages and review panels. Narrow layouts use a keyboard-accessible navigation drawer.
- New-task headings use the selected real project. Suggestions append text to the real prompt while preserving context and attachments. Submission uses the existing production composer.
- Thread Review opens the actual review panel on desktop and the existing Changes view on mobile. Browser opens the existing native session-owned panel on supported desktop layouts.
- The original Home, session actions and command palette remain accessible. Current UI remains available for its additional sidebar context actions.

## Repeatable checks

From `packages/app`, run `bun typecheck`, `bun run test:browser`, and `bun run test:cm3:chrome`. The Chrome command builds the actual application and runs deterministic session API fixtures on an isolated port. It verifies real routing/composer behavior; it does not establish WPP model inference or Electron native-window behavior.

Production navigation benchmark baseline and comparison were captured using the existing first-navigation scenario. Both completed with no blank or unknown samples. Single-run timing is diagnostic and does not establish a performance improvement.

Live Electron/native browser rendering and live model inference remain unverified while CookieMonster is offline. No app/server restart, commit, push, or release is part of this integration.

## Prototype history

The following notes record the earlier sample adapter and its validation before production integration. Prototype-only limits described below no longer describe the live CM3 route tree.
This list tracks the CM3 UI view inside CookieMonster. The current integration is a local prototype; real session integration is a separate scope decision.

## In-app Codex baseline

- The in-app redesign follows `packages/app/node_modules/.cache/cm3-reference/codex.jpg`. It opens the sample "Fix authentication redirect" thread with Review selected. New task opens the landing view.
- Desktop keeps the sidebar, conversation, and Review/Browser columns. Compact icon controls, header theme/return controls, sidebar Settings, attachment-help disclosure, and original/revised diff line numbers replace the earlier presentation.
- The in-app shell uses white `#ffffff` in Light and `#1e2024` in Dark through the shared Light/Dark/System setting. The standalone prototype's cream direction is separate.
- Preserve the `quietCompanion` preference, lazy mounting, hidden/inert state retention, and Current UI focus/command restoration. Browser content and thread data remain local samples.
- This verification pass updated DOM expectations and Chrome smoke coverage, plus formatting. It made no production behavior, backend, session, or timeline changes.

## New chat landing reference

- New chat follows `packages/app/node_modules/.cache/cm3-reference/codex-landing.jpg`, matching the app interior rather than wallpaper or native window buttons. The initial sample conversation and its Review layout remain the default.
- Landing hides and disables Context, removes its Review shortcut, and spans the space beside the unchanged sidebar. The upper-middle group is capped at 520px, with a project-aware heading, one retained composer, a compact toolbar, a sample-project/Local row, and three thin suggestion rows with hairline separators.
- Dark landing uses `#101010` with a `#252525` composer; Light uses white with a soft gray composer. Conversation colors are unchanged. Both follow the shared Light/Dark/System control.
- Only the four existing sample projects are selectable. Selection updates the heading and is recorded with local message options. Suggestions append to the shared draft. No branch, permission, commit, plugin, or automation controls were invented.
- Context returns when selecting or adding a conversation, retaining the selected file/browser state. Drafts, attachments, model/mode choices, and conversations survive navigation and Current UI switches. Ctrl+Enter or Command+Enter adds a local message; plain Enter and IME composition remain editable.
- Landing geometry, separators, project choices, suggestions, keyboard submission, theme changes, and state retention have focused DOM and isolated Chrome coverage. Verification results are recorded below.

## Complete within prototype scope

- Rename visible Quiet Companion labels to CM3 UI while preserving the saved preference.
- Composer: retain drafts, display submitted text safely, reject blank input without attachments, append follow-ups, and populate starter prompts.
- Dark and light themes: use CookieMonster's existing Light, Dark, and System setting, update palettes live, and preserve draft, conversation, and context selection during scheme changes. Keep CM3 colors scoped away from Current UI.
- Settings defaults remain isolated between providers, including after a provider enables CM3.
- Lazy-load CM3 on first enable, then retain its mounted content hidden and inert while disabled. Preserve local drafts, messages, attachments, options, and context selection across switches.
- Keep Current UI mounted and restore its focus and command handling when returning.
- Filter sample threads, project labels, local messages, and attachment names through sidebar search, with clear and empty states.
- Open four distinct sample threads and navigate through project cards without discarding the shared local draft or conversation.
- Select sample mode and model options. Snapshot those options and attachment metadata on local submission without making a model request.
- Select multiple attachments through a native file input, remove and reselect them, and permit attachments-only submission. Store metadata only, with limits of five files, 5 MiB per file, and 10 MiB total. Reject an over-limit batch without losing existing attachments.
- Select each of the three sample changed files and display its corresponding diff. No repository action runs.
- Use local demo browser address/history/back/forward, reload feedback, address visibility settings, and sample-page navigation. Unsupported URLs show an explicit state without fetching or embedding a page.
- Validate external addresses as HTTP(S), reject malformed or credential-bearing addresses, and invoke the existing platform external-open API only from the explicit button.
- Provide accessible names, selected states, keyboard controls, logical layout, and mixed-direction text isolation for the prototype interactions.
- Fix the 1024px layout overlap by sizing tablet grid rows to their content. Keep a real-Chrome hit-test assertion for attachment removal.
- Identify sample activity, connection, account, preview, and diff content. Remove fixed Today/Yesterday groups and show that no checks ran.

## Remaining outside prototype scope

- Connect conversations, search, projects, mode/model choices, and attachments to real sessions if live integration is authorized.
- Replace remaining sample account, connection, viewport, activity, and check information with live data. Add real repository actions only under an approved scope.
- Integrate the native browser panel and verify address, history, reload, settings, and external-open behavior in Electron.
- Verify CM3 in the live Electron app, including native browser visibility, focus/command restoration, and representative desktop, tablet, and mobile widths in both themes.

## Implemented; validation still has limits

- Persistent Current UI / CM3 UI preference with a return control outside the prototype's error boundary.
- Mobile navigation toggle, explicit close control, and access to Review/Browser at narrower widths in the in-app adapter.
- Local interaction state survives UI switches, not application reloads.
- External-open tests record calls to the platform API; they do not launch an OS browser.
- Isolated Chrome checks do not establish Electron or native-window behavior. No live model requests, backend integration, or repository actions were exercised.

## Verification

- On 2026-10-06, the complete browser DOM suite passed with 100 tests, 1256 assertions, and zero failures across 20 files before the final focus repair. The focused suite passed again after that repair with 37 tests and 603 assertions. Run `bun test --conditions=browser --preload ./happydom.ts ./test-browser --only-failures` from `packages/app`. The suite reports multiple Solid instances.
- Focused CM3 coverage includes the initial sample thread and Review state, Settings theme synchronization and state retention, attachment-help disclosure, mobile navigation close/focus restoration, all three changed-file links, and original/revised diff gutters.
- Run `bun test --conditions=browser --preload ./happydom.ts ./test-browser/quiet-companion.test.ts` from `packages/app` for the focused tests.
- happyDOM caches computed custom properties across dark-to-light changes. DOM palette assertions therefore use independently mounted initial Light and Dark cases. Dynamic computed-palette validation runs in real Chrome, not through CSS mocks or duplicated theme logic.
- Isolated Node Playwright smoke passed with `channel: "chrome"` at 1440, 1046, 1024, 768, and 390 pixels in Light/Dark and English LTR/RTL, covering 20 cases. Checks include Settings, search, project/thread selection, native file chooser invocation, attachment-help keyboard/click toggling, unobstructed attachment removal, navigation close, named icon controls, sample options, line-numbered diffs, local browser controls, and horizontal overflow.
- Chrome also checks live palettes, System OS dark/light/dark changes, explicit Light ignoring OS changes, repeated hidden/inert switching, rejected focus into hidden CM3, Current UI focus/command restoration, mount identity, preserved local state, Arabic locale with English fallback, and explicit external-open calls. The fixture emitted zero HTTP(S) requests and zero page/console errors.
- Run `node ./test-browser/quiet-companion.smoke.mjs` from `packages/app`, or `bun run test:cm3:chrome`. The script uses Node, bundles the existing fixture with Vite, and opens a local file without starting or restarting an app/server. Installed Google Chrome is required.
- Fourteen screenshots from the current smoke are in `packages/app/node_modules/.cache/cm3-smoke/output`: the eight conversation/Review captures plus landing captures at 948x624, 1440x900, and 390x844 in both themes. Visual inspection covered the reference-sized dark landing and mobile light landing, alongside the earlier conversation captures.
- Final Chrome smoke passed 12 landing and 20 conversation cases, including project-aware headings, suggestions, hidden/inert landing context, theme/state preservation, and strict return-button focus restoration. The switch now resolves the connected return control from its mounted shell instead of retaining a detached loading-fallback button. The supervisor independently reran Chrome and typecheck successfully. No diagnostic logging remains.
- Earlier supervisor contrast measurements of 5.05:1 in Light and 6.58:1 in Dark belong to the earlier baseline. Contrast ratios were not remeasured for this redesign.
- App `bun typecheck` and `bun run build --logLevel warn` passed. The production build exited with code 0 and reports a Node module-registration deprecation, mixed static/dynamic imports, a duplicate WASM sourcemap filename, and large chunks.
- Scoped root lint across the CM3 components, fixture/test/smoke, app integration, both general-settings components, settings context, and English copy completed with 16 warnings and zero errors. Fifteen warnings are on unchanged lines in `app.tsx`, `settings-general.tsx`, and `context/settings.tsx`; the remaining warning is the existing happyDOM type assertion in `test-browser/quiet-companion.test.ts:42`. Unrelated warnings remain untouched.
- Scoped Prettier checks and `git diff --check` passed. No dependencies, commits, app/server restarts, or live backend work were needed.
- Live Electron and native viewport verification remain outside this pass.
