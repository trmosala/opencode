# HANDOVER — WPP bridge reliability work (for Codex)

Repo: `/Users/Tiisetso/Documents/opencode` · Branch: `session-thread-pinning` ·
All paths below are under `packages/desktop/src/main/wpp-bridge/`.

This file is a handover. Sections below are: (A) what's **already applied** in the
working tree — do NOT redo; (B) the **remaining work** to implement (dual network
capture), which is the actual task for Codex.

## A. Already applied in the working tree (uncommitted, do not redo)

1. **electron binary self-heal** — `packages/desktop/scripts/predev.ts` runs
   `electron/install.js` if `path.txt` is missing (bun skips postinstall). Unrelated to
   the bridge but present in the diff.
2. **`isTranscriptEmpty` false-positive fix** — `injected/content.js`: added
   `MESSAGE_CONTAINER_SELECTOR` + `transcriptRootFor()`; the emptiness check now scopes to
   the conversation container, not `chatRootFor()` (which resolves to the `.chat-input`
   composer and always looked empty → spurious `o1_code_thread_desync` every continue turn).
3. **Proxy preamble disabled** — `proxy/messageSerializer.mjs`: `SERIALIZED_SESSION_PREAMBLE`
   injection is commented out (kept for restore); rely on the WPP-side OgilvyOneCoder system
   prompt. `provenance` param retained but unused (`_provenance`).
4. **Sub-agent short-TTL workers** — DONE (see "Plan: Differentiate sub-agent turns" below;
   it is implemented + tested, 42 tests pass).
5. **Interactive-tab lifetime** — DONE: `PINNED_WORKER_TTL_MS` is now a 4h backstop, env
   `O1_CODE_PINNED_TTL_MS` (see "Addendum" below).
6. **DOM-fallback whitespace fix + attribution** — `injected/content.js`: split normalizers
   — `normalizeAssistantMessageText` is now COMPARE-ONLY; new `preserveAssistantPayloadText`
   (whitespace-preserving) feeds `snapshot.rawText`; `domRecordFromSnapshot` uses `rawText`,
   sets `lowFidelity:true`, warns. `proxy/openaiCompat.mjs`: run log gets top-level
   `responseSource` + `lowFidelity`; `x-o1-code-response-source` header on non-stream turns.
7. **Environment (not code):** `.opencode/node_modules/zod` was a corrupt/partial install
   (missing `v4/core/versions.js`) that crashed `ToolRegistry` → "Failed to send command".
   Repaired by copying complete `zod@4.1.8`. `.opencode/node_modules/effect` is also
   incomplete but off the desktop tool path; patch only if an `effect` ERR_MODULE_NOT_FOUND
   appears. Root cause: `.opencode` auto-install fails on `@opencode-ai/plugin@local`.

## B. Remaining work for Codex
The task is **"Dual network capture"** — the last major section of this file. Everything
above it is context/done. Start there.

---

# Plan: Differentiate sub-agent turns from new sessions (short-TTL pinned workers)

## Context

In the WPP bridge, every OpenCode turn is pinned to a worker tab keyed by
`${sessionID}::${agentName}`, and pinned tabs get a 30-min idle TTL
(`PINNED_WORKER_TTL_MS`) so conversation context survives between turns.

Sub-agents (Explore/Plan/Task) are throw-away: they run, return a result, and are
never resumed. But the proxy currently treats a sub-agent turn **identically to a
brand-new top-level session** — each sub-agent gets its own worker tab held open
for the full 30 minutes after it's already done, wasting authenticated windows.

OpenCode already gives us the signal to tell them apart for free. In
[request.ts:196-201](packages/opencode/src/session/llm/request.ts), every
non-`opencode`-provider call (our proxy) sets:

- `x-session-affinity` / `X-Session-Id` = the turn's own session id
- `x-parent-session-id` = **present only when the session has a parent** (i.e. a
  sub-agent), populated from `session.parentID` ([prompt.ts:1276](packages/opencode/src/session/prompt.ts),
  set by the Task tool at [task.ts:145](packages/opencode/src/tool/task.ts)).

The proxy's `sessionIdFromHeaders` ([openaiCompat.mjs:48](packages/desktop/src/main/wpp-bridge/proxy/openaiCompat.mjs))
reads the affinity headers but ignores `x-parent-session-id`.

**Goal:** detect sub-agent turns via `x-parent-session-id` and still pin them
(preserving delta/thread continuity *within* the sub-agent's own multi-turn run),
but reap their tabs on a much shorter idle TTL than a real interactive session.

## Approach

Keep the sub-agent's `sessionKey` exactly as today (`${sessionID}::${agentName}`,
its child-session id is already unique, so worker selection needs no change). Only
add a `subagent` flag that flows from the proxy to the pool and lowers the TTL.

Follow the existing split: pure, Electron-free logic lives in `worker-slot.ts`
(unit-testable); `worker-pool.ts` is the Electron glue.

### 1. Detect the sub-agent signal — `proxy/openaiCompat.mjs`
- Add a small helper alongside `sessionIdFromHeaders`, e.g.
  `hasParentSession(headers)` that returns true when `x-parent-session-id` is a
  non-empty string.
- Where `sessionKey` is computed (~line 137-138), derive
  `const subagent = Boolean(sessionKey) && hasParentSession(request.headers)`
  (compaction already forces `sessionKey = ""`, so it's never a sub-agent).
- Pass `subagent` into `bridgeOptions` (~line 191) next to `sessionKey`/`continueThread`.

### 2. Plumb the flag through the bridge — `proxy/extensionBridge.mjs`
- In `createWorkerJob` (~line 309-321) add `subagent: options.subagent === true`
  to `payload`, next to `sessionKey`.

### 3. Pure TTL decision — `worker-slot.ts`
- Extend `WorkerView` with `subagent?: boolean`.
- Add a pure helper:
  ```ts
  export function ttlForWorker(
    worker: WorkerView,
    ttls: { idle: number; pinned: number; subagent: number },
  ): number {
    if (!worker.sessionKey) return ttls.idle
    return worker.subagent ? ttls.subagent : ttls.pinned
  }
  ```
  This replaces the inline `worker.sessionKey ? PINNED : IDLE` ternary and makes the
  three-way choice testable without the Electron runtime.

### 4. Apply in the pool — `worker-pool.ts`
- Add `SUBAGENT_WORKER_TTL_MS` (default 5 min; env-overridable via
  `O1_CODE_SUBAGENT_TTL_MS`, mirroring the `O1_CODE_MAX_SPAWNS` pattern).
- Add `subagent: boolean` to the `Worker` type.
- Thread `subagent` through `run` (read `job.payload?.subagent`) → `acquire(agent,
  sessionKey, subagent)` → `claim`/`spawn` (set `worker.subagent`). On `claim`,
  always assign `worker.subagent = subagent` (an adopted unpinned worker takes the
  current turn's classification).
- In `prune()`, replace the TTL ternary with
  `ttlForWorker(worker, { idle: IDLE_WORKER_TTL_MS, pinned: PINNED_WORKER_TTL_MS, subagent: SUBAGENT_WORKER_TTL_MS })`.
- `workerTitle` (debug, `O1_CODE_SHOW_WORKERS=1`): append a marker (e.g. ` (subagent)`)
  so sub-agent windows are visually distinguishable.
- `view()` includes `subagent` so `prune()` sees it.

No change needed to `selectWorkerSlot` (selection is by unique `sessionKey`) or to
`shouldReapWorker` (already TTL-parameterized).

## Critical files
- [packages/desktop/src/main/wpp-bridge/proxy/openaiCompat.mjs](packages/desktop/src/main/wpp-bridge/proxy/openaiCompat.mjs) — detect + pass flag
- [packages/desktop/src/main/wpp-bridge/proxy/extensionBridge.mjs](packages/desktop/src/main/wpp-bridge/proxy/extensionBridge.mjs) — payload plumbing
- [packages/desktop/src/main/wpp-bridge/worker-slot.ts](packages/desktop/src/main/wpp-bridge/worker-slot.ts) — `WorkerView` + `ttlForWorker`
- [packages/desktop/src/main/wpp-bridge/worker-pool.ts](packages/desktop/src/main/wpp-bridge/worker-pool.ts) — constant, `Worker` field, plumbing, `prune`

## Verification

**Unit tests** (`worker-pool.test.ts`, which imports `worker-slot.ts`):
- `ttlForWorker`: unpinned → idle; pinned non-subagent → pinned; pinned subagent →
  subagent TTL.
- A reap scenario asserting a sub-agent worker is reaped once idle past
  `SUBAGENT_WORKER_TTL_MS` while a normal pinned worker of the same age survives
  (uses existing `shouldReapWorker` + the chosen TTL).
- Run: `cd packages/desktop && bun test src/main/wpp-bridge/`

**Optional proxy test:** assert `hasParentSession` is true only when
`x-parent-session-id` is present.

**Live check** (`O1_CODE_SHOW_WORKERS=1 bun run dev:desktop`):
1. Run a turn that spawns a sub-agent (e.g. an Explore/Task) in OpenCode.
2. Confirm a worker window appears titled with the `(subagent)` marker and a
   distinct child-session key from the parent's window.
3. Confirm follow-up calls within the sub-agent reuse that same tab (delta
   continuity preserved during the run).
4. Confirm the sub-agent window is reaped ~5 min after it goes idle, while the
   parent interactive session's window persists.

Run `bun run lint` (oxlint from repo root) and `bun turbo typecheck` before finishing.

## Open tunable
`SUBAGENT_WORKER_TTL_MS` default is 5 min (vs 10 min idle / 30 min pinned). Adjust
if sub-agent runs commonly idle longer than that between turns.

---

# Addendum: interactive-tab lifetime = app session (long idle backstop)

> The sub-agent section above is **already implemented and verified** (42 tests
> pass, lint/typecheck clean). This addendum is the follow-on change.

## Context

The 30-min `PINNED_WORKER_TTL_MS` reaps an interactive session's WPP tab after
30 min of no requests — so if a user steps away from an active conversation, its
authenticated thread (browser-held context) is thrown away and the next turn has
to resync fresh. The ask: tie an interactive tab's lifetime to the **running app
session** instead — keep it alive as long as the app is open, with only a long
idle backstop as a leak guard.

There is **no per-tab/per-session close event** to key off (OpenCode conversations
persist; only an explicit `session.deleted` exists, and the user opted for
app-close semantics, not delete-driven reaping). Electron already destroys all
worker `BrowserWindow`s on app quit, and the pool's reap timer is `unref`'d, so
"reap on app close" needs **no new wiring** — it happens for free. The only change
is to stop reaping interactive tabs on the aggressive 30-min idle clock.

## Approach (minimal)

In [worker-pool.ts](packages/desktop/src/main/wpp-bridge/worker-pool.ts), raise the
interactive pinned TTL from 30 min to a long backstop (default **4h**), env-
overridable via `O1_CODE_PINNED_TTL_MS` (mirrors `O1_CODE_SUBAGENT_TTL_MS` /
`O1_CODE_MAX_SPAWNS`). Update the constant's comment to state the new intent: the
tab lives for the app session; this TTL is only a leak guard against a forgotten/
abandoned session, not a normal reaper.

```ts
// Interactive session tabs live for the running app session (Electron destroys them on quit). This
// long idle TTL is only a leak guard so a forgotten session can't hold an authenticated window
// forever; normal same-session turns refresh lastUsed and never hit it.
const PINNED_WORKER_TTL_MS = Math.max(
  30 * 60 * 1000,
  Number(process.env.O1_CODE_PINNED_TTL_MS) || 4 * 60 * 60 * 1000,
)
```

No other code changes: `ttlForWorker` already routes pinned non-subagent workers to
this constant, sub-agents keep `SUBAGENT_WORKER_TTL_MS` (5 min), unpinned scratch
keep `IDLE_WORKER_TTL_MS` (10 min). The three-tier split built above is unchanged.

## Verification
- Existing `ttlForWorker` tests already assert pinned → `pinned` TTL and that the
  three tiers are distinct; they use literal TTLs, so the constant bump doesn't
  break them. Re-run `cd packages/desktop && bun test src/main/wpp-bridge/`.
- `bun run lint` (oxlint from root) + `bun run typecheck`.
- Live (`O1_CODE_SHOW_WORKERS=1`): an interactive session's window persists well
  past 30 min idle; quitting the app closes all worker windows.

## Note / tradeoff
Every interactive session ever touched keeps one hidden authenticated
`BrowserWindow` for up to the backstop (or until app quit). With many sessions in
one app run this accumulates windows/memory — acceptable per the chosen
"app-close only" semantics; the 4h backstop bounds the worst case.

---

# Dual network capture (CDP witness in main + page recorder as parser, DOM = display only)

> Implement **all at once** (per decision). Builds on the just-landed work that added
> `responseSource`/`lowFidelity` to the run log and demoted DOM to a flagged,
> whitespace-preserving fallback.

## Context

Today the only network capture is the page monkey-patch (`injected/pageRecorder.js`),
injected main-world at document-start via `recorder-injection.ts`, patching
`fetch`/`XMLHttpRequest` and relaying chunks by `postMessage`. It's the sole
transport witness *and* the parser, and it depends on WPP page JS + timing. When it
misses, the run loop in `content.js` silently falls back to **DOM scraping**, whose
whitespace-lossy output then gets executed by the harness — the failure mode behind
the "environment is lying to me" sessions.

Electron lets us add an **independent transport witness** that page JS cannot bypass:
attach `webContents.debugger`, enable the `Network` domain, and observe the model
request directly in the main process. The page recorder stays as the *semantic SSE
parser*; CDP becomes the *truth* about whether a model request happened, streamed
bytes, and finished or failed; DOM is demoted to UI evidence only.

Key simplifier: **one job per worker**, so within a worker's run window there is
exactly one model request — CDP correlation is just "the POST to the assistant
origin during the run window," no per-request id needed.

## Architecture / placement

- **CDP witness lives on the worker** (it owns the `webContents`/debugger).
- **Arbiter + capture-health verdict: `worker-pool.ts` `run()`** — it's the only place
  with the worker, its CDP witness, the controller result, and reload/reinject. It
  records `t0` before `controller.runJob`, then asks the witness what it saw in the
  window and emits a verdict.
- **Retry-with-reset: `proxy/openaiCompat.mjs`** — it already catches bridge errors and
  calls `resetThread`, and it holds the full transcript needed for a fresh replay. A
  typed `o1_code_capture_failure` from the pool triggers: reset continuity → retry once
  (the retry naturally takes the fresh-chat path because the watermark was reset).
- `content.js` is largely unchanged: still parses + returns its own `responseSource`
  and `recorder:{ready,reset,requestCount}`; main now *arbitrates* that result instead
  of trusting it.

## Work items

### 1. Main-process CDP Network recorder — new `cdp-network-recorder.ts`
- `installNetworkWitness(contents)`: via existing `installInRootAndChildTargets`
  (reused from [cdp-targets.ts](packages/desktop/src/main/wpp-bridge/cdp-targets.ts)),
  `Network.enable` on root + the cross-origin assistant iframe target; subscribe to
  `dbg.on("message")` for `Network.requestWillBeSent`, `responseReceived`,
  `dataReceived`, `loadingFinished`, `loadingFailed`, `eventSourceMessageReceived`.
- Keep a small rolling ring buffer of `{ts, requestId, url, method, status, bytes,
  state}`. Filter to model requests with the **same predicate as the page recorder's
  `shouldRecordRequest`** (POST to assistant origin, excluding datadog/`/v1/project`/
  `/v1/tools`/`/v1/oauth`) — factor that predicate into a shared module so both stay in
  sync.
- Return a handle: `summarizeWindow(sinceTs)` → `{ requestSeen, status, bytes,
  finished, failed, failureText, eventSourceMessages }`.
- Witness is **metadata-only** (no `Network.getResponseBody`) per "witness, not parser."

### 2. Spawn wiring — `worker-pool.ts`
- In `spawn()`, after `installRecorder`/`installController`, call `installNetworkWitness`
  and store the handle on the `Worker` (`worker.netWitness`).
- In `run()`: capture `t0 = Date.now()` before `controller.runJob`; after it resolves,
  `const witness = worker.netWitness.summarizeWindow(t0)`; compute the **verdict**:
  - controller result `responseSource === "network"` (page recorder parsed) → **accept**;
    attach witness as corroboration.
  - result `responseSource === "dom"` **or** page recorder saw nothing
    (`recorder.requestCount === 0`):
    - witness `failed` → throw typed `o1_code_capture_failure` (kind: `wpp_request_failed`).
    - witness `requestSeen && finished` but parser missed → typed `o1_code_capture_failure`
      (kind: `recorder_parser_miss`) — **never** return DOM payload as authoritative.
    - witness `!requestSeen` → typed `o1_code_capture_failure` (kind: `submit_or_ui_failure`).
  - Mark the worker for reap when the verdict is a parser/transport failure so the retry
    gets a clean tab.

### 3. Retry-with-reset — `proxy/openaiCompat.mjs`
- Wrap the `bridge.run` call: on `o1_code_capture_failure`, `resetThread(sessionKey)`,
  then retry **once** (fresh replay). If the retry also fails capture, surface the typed
  error (don't fall back to DOM). Distinguish the three kinds in the error message so the
  user sees "WPP request failed" vs "recorder/parser miss" vs "submit/UI failure."

### 4. DOM = display only
- With the arbiter in place, the DOM-fallback record ([content.js](packages/desktop/src/main/wpp-bridge/injected/content.js)
  `domRecordFromSnapshot`, already `lowFidelity:true`) is **never accepted as payload** by
  the pool when a model request was witnessed/seen-failed. DOM only survives as evidence
  in the capture-health log (and as a last resort only if CDP also saw nothing AND the
  page produced visible text — configurable; default: reject).

### 5. Capture-health record (per turn)
Extend the run log (the `responseSource`/`lowFidelity` fields just added in
[openaiCompat.mjs](packages/desktop/src/main/wpp-bridge/proxy/openaiCompat.mjs)) with a
`capture` block, surfaced in `/bridge/health` too:
`{ recorderArmedAt, submitAt, cdpRequestSeen, cdpStatus, cdpBytes, cdpFinished,
cdpFailed, pageRecorderRequestSeen, parseComplete, responseSourceAccepted, retryCount,
verdict }`. This is what makes failures non-spooky.

## Critical files
- **new** `packages/desktop/src/main/wpp-bridge/cdp-network-recorder.ts` — witness
- **new/shared** request-predicate module (extract `shouldRecordRequest` logic) shared by
  the witness and [pageRecorder.js](packages/desktop/src/main/wpp-bridge/injected/pageRecorder.js)
- [worker-pool.ts](packages/desktop/src/main/wpp-bridge/worker-pool.ts) — install witness, arbiter verdict, reap-on-capture-failure
- [proxy/openaiCompat.mjs](packages/desktop/src/main/wpp-bridge/proxy/openaiCompat.mjs) — retry-with-reset, capture-health log
- [proxy/extensionBridge.mjs](packages/desktop/src/main/wpp-bridge/proxy/extensionBridge.mjs) — pass witness summary up the envelope; `/bridge/health` capture block
- reuse [cdp-targets.ts](packages/desktop/src/main/wpp-bridge/cdp-targets.ts) `installInRootAndChildTargets`

## Verification
- **Unit (Electron-free):** the verdict function is pure — feed `{controllerResult,
  witnessSummary}` permutations (network-ok, dom+failed, dom+finished-parser-miss,
  dom+no-request) and assert accept / typed-failure-kind. Put it next to `worker-slot.ts`
  style pure logic so it tests without Electron. Run `bun test src/main/wpp-bridge/`.
- **CDP event parsing:** unit-test the ring-buffer reducer over recorded `Network.*`
  event fixtures.
- **Live (`O1_CODE_SHOW_WORKERS=1`):** run a turn; confirm `capture.cdpRequestSeen=true`
  + `responseSourceAccepted=network`. Then force a parser miss (e.g. temporarily break
  the page recorder predicate) and confirm: DOM is **not** executed, a typed
  `recorder_parser_miss` is logged, one retry fires after reset, and the health block
  records it. Kill network mid-turn → `wpp_request_failed` surfaced.
- `bun run lint` + `bun run typecheck`.

## Risks / notes
- Two `setAutoAttach` passes already exist (recorder + controller injection); a third is
  idempotent but adds CDP chatter — acceptable, or fold `Network.enable` into the
  recorder-injection target pass.
- SSE over CDP surfaces as `dataReceived` (and sometimes `eventSourceMessageReceived`);
  treat *either* as "bytes arrived." `loadingFinished` may lag the visible completion —
  the witness is queried after `controller.runJob` resolves, so timing is fine.
- Keep CDP witness metadata-only; capturing bodies (`getResponseBody`/
  `streamResourceContent`) is a possible future "CDP-as-second-parser" upgrade, out of
  scope here.
