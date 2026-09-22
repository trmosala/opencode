# HANDOVER — WPP token counting and the approximately 250K context window

Repo: `E:\Work\Development\CookieMonster`

Status: **implemented**. This handover was reconciled with the live code and WPP
UI on 2026-09-22 while resolving issue #3.

## What a new user needs to know

- The WPP models used here appear to have an approximately **250,000-token total
  context window**.
- On 2026-08-18, WPP showed a cumulative conversation count of `221,750` while
  displaying its "This chat is getting long" warning. That is about 88.7% of
  250,000 and corroborates the configured 250K context window.
- `221,750` is an observed warning point, not a hard limit. The warning means
  response quality may be deteriorating and the user should prepare to continue
  in a new chat.
- 250K is the total model context, not 250K of guaranteed prompt/input space.
  CookieMonster advertises a 128K maximum output capability, and the local
  compaction policy reserves output space. The effective prompt budget depends
  on whether the legacy OpenCode or Session V2 execution path is active.

## Evidence and confidence

There are two independent pieces of evidence:

1. `proxy/providerConfig.mjs` advertises `O1_CODE_CONTEXT_LIMIT = 250000` and
   `O1_CODE_OUTPUT_LIMIT = 128000` for every CookieMonster WPP model.
2. The live WPP UI observation above placed its long-chat warning at `221,750`,
   close to the upper end of a 250K window. It is also only 3,750 tokens above
   the legacy OpenCode path's normal 218K usable threshold.

Together these are strong confirmation that the intended total context is about
250K. They do not prove the backend's exact hard-rejection boundary; WPP can
change its model or warning policy independently of this repository.

### 2026-09-22 live acceptance evidence

A branded unsigned macOS build was installed locally and exercised against the
real WPP project with visible worker windows:

- The first turn settled at `3,869` tokens.
- On the consecutive continued turn, the pre-submit and network-complete values
  were both the stale `3,869`; the pill changed to `3,890` after 202 ms, and the
  OpenAI-compatible response reported `3,883 + 7 = 3,890`.
- A 24,275-character continued request reached `9,970`. Replacing its history
  with a one-message fresh replay dropped the counter to `3,827`. This proves
  the pill is current-context usage (`scope: "context"`), not process or account
  lifetime usage, and that it can decrease after history truncation.
- Closing the app and continuing the logical conversation after restart forced
  a fresh worker/thread. It reported `3,888` rather than adding the previous
  retained total, confirming replacement does not double-count usage state.
- A live stream with `stream_options.include_usage: true` emitted the stop chunk,
  then the usage-only chunk (`3,876 + 6 = 3,882`), then `[DONE]`.

Every accepted turn used page-recorder network response capture, had no recovery
or capture retry, and maintained `prompt_tokens + completion_tokens === total_tokens`.

## Current implementation

WPP's model-completion SSE did not expose token usage in the 2026-09-22 live
captures. The recorder nevertheless parses a standard OpenAI `usage` object if
WPP starts sending one. The current WPP-owned count is the post-turn token pill
in the conversation DOM.

The current flow is:

`WPP token pill` → `injected/content.js` → `proxy/extensionBridge.mjs` →
`proxy/openaiCompat.mjs` → OpenAI-compatible `usage` → OpenCode context handling

1. `injected/pageRecorder.js` retains exact request-scoped network usage when it
   exists.
2. `injected/content.js` records the pill before submit, again when the network
   response completes, and waits up to three seconds for a changed post-turn
   value. An unchanged stale pill is unavailable rather than authoritative.
   Exact network usage takes priority over this DOM measurement.
3. `proxy/extensionBridge.mjs` carries the measurement and before/network/settled
   observation through the run envelope.
4. `proxy/usage.mjs` resolves usage in this order: exact request-scoped network
   usage, confirmed changed context pill, then the conservative local estimate.
   A continued-thread estimate includes that session's retained context; a
   fresh replay does not.
5. `proxy/openaiCompat.mjs` commits transcript and usage state only after every
   recovery path succeeds. Reset, failed replay, and worker replacement clear or
   bypass retained state so retries cannot double-count it.
6. `proxy/streamAdapter.mjs` preserves finite usage in normal responses and emits
   the optional streaming usage-only chunk after `finish_reason` and before
   `[DONE]` when `stream_options.include_usage` is true.
7. If neither network nor DOM usage is available, the bridge uses
   `proxy/tokenEstimate.mjs` (`CHARS_PER_TOKEN = 3`).

Token counting is separate from model-response capture. A turn can have a
byte-exact `network` response source while its usage still comes from the DOM
pill. Do not use `x-o1-code-response-source` to infer the token-count source.

## Fork ownership: CookieMonster versus upstream OpenCode

This boundary matters during investigation and upstream merges. It was verified
against `upstream/dev` on 2026-08-18.

### CookieMonster-owned changes

The following behavior is specific to this fork and has no counterpart in
upstream OpenCode:

- The entire `packages/desktop/src/main/wpp-bridge/` directory. This includes the
  WPP browser workers, authenticated bridge, token-pill scraper, heuristic token
  estimator, OpenAI-compatible adapter, usage mapping, model roster, provider
  seeding, and bridge tests.
- `packages/desktop/src/main/index.ts` integration that starts the WPP bridge and
  wires the visible WPP login flow into the Electron lifecycle.
- `packages/desktop/src/main/server.ts` integration that injects
  `o1CodeConfigContent()` into the bundled sidecar through
  `OPENCODE_CONFIG_CONTENT`.
- The `cookiemonster` provider and its advertised 250K context / 128K output
  limits in `wpp-bridge/proxy/providerConfig.mjs`.
- Conversion of WPP's DOM-only cumulative pill into standard OpenAI-compatible
  `usage`, including the three-characters-per-token fallback.

These are product behavior, not temporary compatibility shims. An upstream merge
must not delete `wpp-bridge/` merely because upstream has no matching directory.
Conflicts in desktop boot or sidecar setup must preserve the bridge-start and
configuration-injection responsibilities at the lifecycle seams used by the new
upstream code.

### Related CookieMonster-only subsystem: embedded browser

The embedded browser is also exclusive to this fork. As of 2026-08-18, none of
these directories exist on `upstream/dev`:

- `packages/app/src/components/browser-panel/` — the user-facing Electron
  `<webview>` embedded in the session side panel.
- `packages/cm-browser/` — the OpenCode plugin that gives the agent
  `browser_read_state`, `browser_navigate`, `browser_click`, `browser_fill`, and
  `browser_press_key` tools.
- `packages/desktop/src/main/browser/` — the main-process router, driver, session
  registry, and authoritative host allowlist used by those tools.

These are two connected surfaces, not one implementation:

1. The **browser panel** is what the user sees. CookieMonster extends the shared
   app platform contract, session header, session side panel, desktop renderer,
   preload, and IPC wiring to mount and register the active webview by session.
2. The **agent browser plugin** runs inside the OpenCode sidecar. It sends
   session-scoped `browser_request` messages to Electron main, where the request
   is permission-checked, host-allowlisted, and executed against the registered
   panel webview. The plugin bundle is built during desktop predev/prebuild and
   packaged under `resources/cm-browser/plugin.mjs`.

Do not conflate either surface with the WPP worker BrowserWindows. The embedded
panel is the user's browsing workspace; `cm-browser` lets the agent operate that
workspace; the WPP workers are separate authenticated browser sessions used as
the model transport.

The three directories above are wholly CookieMonster-owned. The integration
points below are upstream files modified by this fork and are likely merge
hotspots:

- `packages/app/src/context/platform.tsx`
- `packages/app/src/components/session/session-header.tsx`
- `packages/app/src/pages/session/session-side-panel.tsx`
- `packages/desktop/src/renderer/index.tsx`
- `packages/desktop/src/main/server.ts`
- `packages/desktop/electron-builder.config.ts`

During an upstream merge, preserve the `platform.browserPanel` capability,
webview registration IPC, sidecar plugin entry, main-process allowlist boundary,
and packaged plugin resource. A browser panel that still renders but loses any of
those seams can appear healthy while agent browser tools are unavailable or
unsafe.

### Upstream-owned behavior consumed by CookieMonster

CookieMonster relies on, but does not own, these policies:

- `packages/opencode/src/provider/transform.ts` — legacy OpenCode's effective
  output-token cap.
- `packages/opencode/src/session/overflow.ts` — legacy OpenCode's usable-context
  and overflow decision.
- `packages/core/src/session/compaction.ts` — Session V2's compaction budget and
  trigger.
- OpenCode's normal provider/session pipeline that consumes OpenAI-compatible
  `usage.total_tokens` from the CookieMonster provider response.

Do not copy the current upstream calculations into the WPP bridge. Keep the fork
boundary narrow: CookieMonster should report the best available standard usage;
OpenCode should continue to own the policy for when that usage triggers
compaction.

### Upstream-merge checks

When syncing upstream OpenCode:

1. Confirm the WPP imports and `startWppBridge()` boot path remain in
   `packages/desktop/src/main/index.ts`.
2. Confirm `packages/desktop/src/main/server.ts` still supplies
   `o1CodeConfigContent()` to the sidecar without overwriting an explicit user
   `OPENCODE_CONFIG_CONTENT` value.
3. Re-read upstream's output-limit, usage-consumption, overflow, and Session V2
   compaction contracts; do not assume the 218K or 122K examples remain current.
4. Run the focused token regression and the complete WPP bridge suite.
5. Live-check that WPP's pill still becomes `usage.total_tokens` and that the
   active OpenCode session path reacts to that total as expected.
6. Confirm the embedded browser still mounts, registers by session, and responds
   to `browser_read_state`; verify that a mutating browser tool still crosses the
   permission and main-process allowlist boundaries.

## Usage-field contract

| Field               | Exact network usage                       | Confirmed WPP pill                                            | Heuristic fallback           |
| ------------------- | ----------------------------------------- | ------------------------------------------------------------- | ---------------------------- |
| `total_tokens`      | Network prompt + completion                | Current WPP context pill                                      | Estimated prompt + completion |
| `completion_tokens` | Exact network value                        | Estimated from current output, capped at total                | Estimated                    |
| `prompt_tokens`     | Exact network value                        | Derived as total minus estimated completion                   | Estimated                    |

For the current WPP response shape, only the DOM `total_tokens` is WPP-owned;
the prompt/completion split remains estimated. If structured network usage is
present, all three values are exact and optional cached/reasoning details are
preserved.

OpenCode's overflow logic reads the latest assistant message's `tokens.total`
rather than summing every message, so the cumulative WPP total is the correct
shape. Do not convert it into a per-turn delta.

## DOM scraper contract

The scraper deliberately prefers a missed count over a wrong count:

- It queries the legacy `[data-testid='message-tokens']` / `.cs-message-tokens`
  hooks and the current `[data-testid='response-type-tag']` /
  `.cs-response-type-tag` hooks. The current UI exposes `N tokens` in
  `aria-label` while its text content contains only `N`.
- It does not scan arbitrary document prose. Losing all precise hooks safely
  activates the heuristic fallback.
- It accepts only an element whose complete trimmed text matches
  `<positive number> token` or `<positive number> tokens`, with comma separators
  allowed.
- It rejects invisible nodes, prose mentioning tokens, and ambiguous used/limit strings such as
  `19,547 / 250,000 tokens`.
- It selects the newest equally specific assistant pill, since older assistant
  messages retain their counters in the DOM.
- It marks a successful settled scrape as
  `{ scope: "context", source: "dom-pill", fidelity: "confirmed" }`.
- A miss is non-fatal and activates the heuristic fallback.

Keep the existing SSE usage parser even while live WPP omits the field: it is
the highest-fidelity path and is covered by recorder and adapter regressions.

## Configuration and compaction

`proxy/providerConfig.mjs` is the source of truth for the advertised limits:

- Context: `250,000`
- Output: `128,000`

The advertised output value is model capability. The effective compaction
threshold depends on the session path:

- **Legacy OpenCode:** `packages/opencode/src/provider/transform.ts` sets
  `OUTPUT_TOKEN_MAX` to 32,000 by default, and
  `packages/opencode/src/session/overflow.ts` subtracts that effective maximum
  from the context limit. With default settings, that is:

`250K context - 32K output headroom = 218K usable`

- **Session V2:** `packages/core/src/session/compaction.ts` subtracts the
  request's generation maximum or, when absent, the routed model's output limit,
  while also respecting its compaction buffer. With the advertised 128K output
  limit and no narrower request value, that is:

`250K context - 128K output headroom = 122K usable`

`OPENCODE_EXPERIMENTAL_OUTPUT_TOKEN_MAX`, request generation settings, and
compaction configuration can move these thresholds. Neither local threshold
contradicts WPP's approximately 250K total model context window.

The proxy's serialized-prompt character cap is a separate safety boundary. Do
not raise or reinterpret any of these limits solely from the `221,750` warning
observation.

## Verification

Regression coverage verifies the full priority and lifecycle contract:

- exact network usage wins and preserves optional details;
- a changed WPP context pill becomes authoritative `total_tokens`, with
  `prompt_tokens + completion_tokens === total_tokens`;
- an unchanged stale pill becomes unavailable;
- a missing pill falls back to finite heuristic prompt usage;
- continuation retains context for fallback estimates, while fresh replay,
  worker replacement, reset, and different sessions do not share it;
- streamed usage appears after the finish chunk and before `[DONE]`.

Run the focused regression from the desktop package, never the repository root:

```powershell
cd packages/desktop
bun test src/main/wpp-bridge/proxy/openaiCompat.capture.test.mjs
```

Run the complete bridge suite after changing capture or token accounting:

```powershell
cd packages/desktop
bun test src/main/wpp-bridge/
```

For live verification:

1. Start the app with `O1_CODE_SHOW_WORKERS=1 bun run dev:desktop`.
2. Run a multi-turn WPP conversation and read the visible token pill.
3. Inspect the corresponding proxy run JSON (default `logs/`); normal logs retain
   `o1Code.response.usage` and the final OpenAI-compatible `response.usage` even
   when transcript payloads are omitted.
4. Confirm the observation records `before`, `networkComplete`, and `settled`,
   and final `usage.total_tokens` equals the changed settled value.
5. Confirm a turn with no pill still returns finite heuristic usage.

## Known limitations and change triggers

- The DOM scraper is necessarily format-fragile. If WPP renames the selector or
  changes the pill text, token reporting safely becomes heuristic until repaired.
- The current and legacy DOM selector shapes, delayed settlement, exact network
  usage, fallback, streaming order, and state reset paths have direct regressions.
- Reverify the assumptions in this handover if WPP exposes structured usage in
  the network response, changes the warning threshold, displays separate used and
  maximum values, or changes the routed models.

## Critical files

- **CookieMonster:** `packages/desktop/src/main/wpp-bridge/injected/content.js` — strict token-pill
  scraper and `response.usage` attachment.
- **CookieMonster:** `packages/desktop/src/main/wpp-bridge/proxy/extensionBridge.mjs` — usage
  passthrough in the bridge envelope.
- **CookieMonster:** `packages/desktop/src/main/wpp-bridge/proxy/openaiCompat.mjs` — authoritative
  total and estimated breakdown.
- **CookieMonster:** `packages/desktop/src/main/wpp-bridge/proxy/usage.mjs` — usage priority,
  normalization, and continued-context fallback.
- **CookieMonster:** `packages/desktop/src/main/wpp-bridge/proxy/streamAdapter.mjs` — OpenAI response
  usage normalization.
- **CookieMonster:** `packages/desktop/src/main/wpp-bridge/proxy/tokenEstimate.mjs` — heuristic
  fallback.
- **CookieMonster:** `packages/desktop/src/main/wpp-bridge/proxy/providerConfig.mjs` — advertised
  context and output limits.
- **Upstream:** `packages/opencode/src/provider/transform.ts` — normal output cap and effective
  per-turn maximum.
- **Upstream:** `packages/opencode/src/session/overflow.ts` — usable-budget and overflow logic.
- **Upstream:** `packages/core/src/session/compaction.ts` — Session V2 compaction budget.
- **CookieMonster:** `packages/desktop/src/main/wpp-bridge/proxy/openaiCompat.capture.test.mjs` —
  authoritative-total and fallback regressions.
