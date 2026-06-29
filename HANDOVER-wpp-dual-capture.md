# WPP bridge reliability — state & fixes

Repo: `/Users/Tiisetso/Documents/opencode` · Branch: `session-thread-pinning` ·
Paths below are under `packages/desktop/src/main/wpp-bridge/` unless noted.

> Correction to an earlier draft of this file: the "dual network capture" design is
> **already implemented** in this codebase (`cdp-network-recorder.ts` +
> `capture-verdict.ts`, wired into `worker-pool.ts` and `proxy/openaiCompat.mjs`).
> Do NOT rebuild it. This file now records the *actual* fixes made and the current
> architecture.

## Capture pipeline (already exists)
Three layers, arbitrated per turn:
- **Page recorder** (`injected/pageRecorder.js`) — main-world fetch/XHR monkey-patch that
  parses the model SSE/JSON; a trusted parse → `responseSource:"network"`.
- **CDP network witness** (`cdp-network-recorder.ts`) — independent main-process
  `Network.*` recorder (metadata only) that says whether the POST to the assistant
  origin actually happened / finished / failed. Page JS can't bypass it.
- **DOM scrape** (`content.js`) — last-resort, whitespace-lossy `lowFidelity` fallback;
  never treated as byte-exact.

`WorkerPool.run` → `capture-verdict.ts` `decideCaptureVerdict` arbitrates: a non-network
result the witness can't corroborate throws a typed `o1_code_capture_failure`
(`wpp_request_failed` | `recorder_parser_miss` | `submit_or_ui_failure`); the worker is
discarded and `openaiCompat.mjs` retries once (fresh replay) before a 502. The
model-request predicate is duplicated (TS `isWppModelRequest` + injected
`MODEL_REQUEST_FILTER_SOURCE`) in `model-request-filter.ts` — keep both in sync.

## Fixes made this session (verified live: cold turn + continuity turn both 200/network)

### New WPP agent-selection UI (the live blocker) — `injected/content.js`
WPP shipped a new model/agent picker; the old selection logic failed at
`model-pill-not-found`/`wrong_agent`, so no prompt was ever submitted. New flow + fixes:
1. Trigger is now a **text-less** `[data-testid="chat-model-button"]` — `findModelPill`
   matches it by testid (text-token match could never fit an empty button).
2. Clicking it opens a popover (Auto / Premium routing modes) with a separate
   **"Select model or agent"** nav row (below a divider, › chevron). New
   `chooseModelOrAgentMode()` clicks that row by text to reveal the searchable, grouped
   list (the existing `findAgentSearchInput`/`expandAgentGroups`/`findAgentOption` logic
   then finds OgilvyOneCoder).
3. After an agent is chosen the model button shows an **icon only — no name, no tooltip**,
   so pill-text verification can't pass. `ensureAgentSelected` now confirms via
   **picker-dismissed** (search input + mode menu gone, option no longer visible);
   pill-text match kept as the old-UI fallback.
4. The caller trusts `agentSelection.ok` instead of re-checking the icon-only pill label.

### Capture-verdict no longer masks content.js errors — `worker-pool.ts`
If `runJob` returns `ok:false` (its own typed error, e.g. `o1_code_wrong_agent`),
`run()` returns it verbatim so `extensionBridge` surfaces the real error, instead of
relabeling everything as a generic `submit_or_ui_failure`. (This is what made the agent
bug debuggable.) Capture-failure errors also carry a `bridgeResult` with content.js's
submit view (`submitted`, `recorder`, `responseSource`, `diagnostics`).

### CDP witness telemetry false-positive — `model-request-filter.ts` (+ test)
`isWppModelRequest` now excludes `heap-api` / `heapanalytics` (both TS + injected source),
so a Heap beacon is no longer mistaken for the model response (was producing misleading
`recorder_parser_miss`). New `model-request-filter.test.ts` covers heap/datadog/control-plane
exclusion and that the chat endpoint passes.

### Worker startup readiness gate — `worker-pool.ts`
After the post-login `/external → /chat` redirect, the composer wasn't ready when the
worker submitted (cold-start race). `waitForAssistantBridge` now requires the composer to
report ready for two consecutive polls before submitting. (`iframe.src` is NOT a reliable
"settled" signal — the attribute keeps its initial `/external` value under SPA routing.)

### TTL tiers + sub-agent detection (earlier in session) — `worker-slot.ts` / `worker-pool.ts` / `openaiCompat.mjs`
`ttlForWorker`: unpinned 10 min, interactive 4h backstop (`O1_CODE_PINNED_TTL_MS`, lives
for the app run), sub-agent 5 min (`O1_CODE_SUBAGENT_TTL_MS`). A turn is sub-agent when it
carries `x-parent-session-id`. Plus: `isTranscriptEmpty` scope fix, DOM-fallback
whitespace preservation (`preserveAssistantPayloadText`/`rawText`/`lowFidelity`),
`responseSource`/`lowFidelity` in the run log + `x-o1-code-response-source` header.

## Verification
- `cd packages/desktop && bun test src/main/wpp-bridge/` → 60 pass.
- `bun run typecheck`; `bun run lint` (oxlint from root only — `.oxlintrc.json` `typeAware`
  rejects per-package invocation).
- Live: `O1_CODE_SHOW_WORKERS=1 bun run dev:desktop`, log in once, then
  `POST http://127.0.0.1:8787/v1/chat/completions` `{model:"o1-code", messages:[…]}`.
  Cold turn selects the agent and returns `responseSource:network`; a 2nd same-session
  turn continues fast. Run logs: `~/logs/*.json` (cwd is home).

## Gotchas
- **Restart hygiene:** `pkill -f electron-vite` does NOT kill the detached Electron
  binary; a stale instance causes a `bind() failed: Address already in use` on :9222 and a
  duplicate that produces bogus hangs. Use `pkill -9 -f "node_modules/.bun/electron@"` and
  verify :8787/:9222 free before relaunch.
- The new agent UI is re-selected on every fresh turn (the icon-only button gives no
  cheap "already selected" signal); continue-thread turns skip selection.
