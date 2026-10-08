# Autonomous browser qualification

## Behavior

Agent-created blank tabs initialize lifetime transfer guarding and upload interception before main grants access. The plugin supplies lifecycle allow defaults below user rules. Native create/select/close confirmation is skipped for agent-controlled tabs, while private targets and unsaved-page leave handling retain their existing confirmation paths.

Agent tabs share `persist:cm-browser`. Creation and selection reveal the panel. URL/history recovery creates private tabs alongside a fresh authorized agent tab, rather than requiring manual restoration first.

Takeover is task-wide and process-local. It revokes live grants, invalidates refs and prepared lifecycle tokens, blocks replacement tabs and pauses history/page tools. Explicit resume restores only previously authorized live tabs that remain eligible. Explicit tab revoke, owner loss, closure and global disable remove pending resume grants. Main enforces the pause, independently of model instructions.

Model guidance makes CM the first choice, explains that its tools are outside the MCP catalog, requests human takeover for authentication and confirmation for consequential actions, and forbids browser substitution to bypass takeover. These instructions do not add native transaction classification. Chrome is opt-in with `CM_CHROME_DEVTOOLS=1`; exact legacy seeded definitions are migrated, and custom definitions are preserved.

## Checks on 8 October 2026

Run from the indicated package directories, never from the repository root:

- Desktop: `bun scripts/browser-smoke.ts --autonomous-browser` passed on Linux, Electron 44.3.0 / Chromium 152.0.7977.78. Uses a disposable profile and a loopback server. Exercises the actual plugin tool implementations and native router, shared synthetic login cookie, blank creation, navigation, fill, click, screenshot, private-tab exclusion, task takeover/resume, unsaved close Stay/Leave, and URL/history recovery. No routine native permission dialogs occurred. The fixture simulates OpenCode allow-policy settlement; the plugin config test separately verifies default ordering and explicit user policy preservation.
- Desktop: `bun scripts/browser-smoke.ts --tab-lifecycle` passed with updated autonomous-startup expectations. Preserves exact token binding, busy source reservations, native consent for private targets, cancellation/settlement, real Chromium unload handling, HTTP 204/media replacement, input quarantine and recovery. The runner allows 120 seconds for this longer fixture; a 60-second run did not complete. Run native fixtures serially because they share desktop focus.
- Desktop: 190 registry/router/delegation/operation/provider-config tests passed, including task-wide pause, old creation-token rejection after pause/resume, private/foreign tabs, global disable, explicit revoke and exact Chrome seed migration.
- Browser plugin: 102 tests passed, covering lifecycle defaults before user wildcard/exact rules and CM-first model guidance. Typecheck and plugin bundle build passed.
- App: the mounted navigation test passed with takeover/resume controls. Its tab-switch driver now reflects the tab strip being outside BrowserPanel. The separate mounted screenshot-preview test timed out, including a diagnostic run loading the unchanged HEAD version of BrowserPanel; it remains an unresolved fixture limitation and is not counted as passing. The temporary baseline override was removed.
- App native-translation tests: ten passed and six fixed-index/hash assertions failed. Comparing the committed dictionary's 295 keys to the current dictionary confirmed the entire existing prefix is unchanged; only the new task-pause key is appended. These assertion failures precede this change. Exact bundle validation passed.
- App, desktop and browser-plugin typechecks passed. Scoped lint reported warnings and zero errors.

No installed app or existing server was restarted. Synthetic fixture results do not establish real-site authentication, packaged-build or macOS qualification. Background/minimized operation is outside this change. New UI and native copy use English fallback keys pending reviewed translations.
