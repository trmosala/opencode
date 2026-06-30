# HANDOVER — WPP real token count (replace heuristic with WPP's exposed count)

Repo: `/Users/Tiisetso/Documents/opencode` ·
All paths below are under `packages/desktop/src/main/wpp-bridge/` unless noted.

This file is a handover. It captures (A) the investigation findings (the token
pipeline as it exists today, end to end) so the next person does not have to
re-trace it, and (B) the remaining work to surface WPP's own token count instead
of the local heuristic.

The user request: the new WPP UI shows a token count (e.g. the "19,547 tokens"
pill at the bottom of the conversation). Use that real number to improve our
token reporting instead of the chars/token estimate.

## Decisions already taken (from the user)

1. **Source not yet confirmed** — whether the number lives in the SSE/network
   response or only in the DOM pill must be verified first (work item 1).
2. **The pill is a cumulative conversation total**, not a per-turn count.
3. **Keep the current heuristic as the fallback** when no real number is
   available for a turn (do not report zero / omit).

## A. How token counting works today (investigation findings — do not redo)

The bridge **never uses a real token count**. It is 100% heuristic:

1. `proxy/tokenEstimate.mjs` — `CHARS_PER_TOKEN = 3`, deliberately biased to
   OVER-estimate (over-counting nudges early compaction = safe; under-counting
   risks context overflow = bad). No real tokenizer (repo is zero-runtime-dep and
   reaches the model through the authenticated browser session, no API key, so it
   cannot call Anthropic's `count_tokens` or bundle a tokenizer). Image cost is a
   visual-patch estimate (`estimateImageTokens`).
2. `proxy/contextMetrics.mjs` — `buildContextMetrics` produces
   `input.estimatedTokens = promptMetrics.estimatedTokens + imageTokens`. This is
   the heuristic prompt-side number.
3. `proxy/openaiCompat.mjs` — `buildUsage({ promptTokens, completionText })`
   (~line 562): prompt side = `context.input.estimatedTokens` (heuristic),
   completion side = `estimateTokens(completionText)` (heuristic). Builds the
   `usage` object on every turn (title, error, normal, streamed).
4. `proxy/streamAdapter.mjs` — `normalizeUsage(usage, message)` (~line 186)
   **already has a real-usage branch**: if `usage.prompt_tokens` and
   `usage.completion_tokens` are both finite it uses them (ceil, clamp ≥ 0,
   derives `total_tokens` if absent); otherwise it falls back to estimating from
   `message.content`. Nothing populates a real `usage` today, so the fallback
   always wins.
5. `injected/pageRecorder.js` — `parseDataLine` (~line 334) parses WPP's SSE:
   `choices[].delta` / `choices[].message` (content, thinking, tool_calls,
   finish_reason) and the top-level `model`. It **discards any `usage` field** the
   backend may emit. This is capture gap #1.
6. `injected/content.js` — assembles the job result `response: { finalText,
   toolCallParts, finishReason, responseStatus, eventCount, byteCount, counts }`
   (~line 399). No usage field. This is plumbing gap #2.
7. `worker-pool.ts` `run()` — passes the controller result through the capture
   verdict and returns it; no usage handling.

So the wiring to *consume* a real count partly exists (`normalizeUsage`); what is
missing is **capturing** it from WPP and **threading** it through
`pageRecorder.js` → `content.js` → `worker-pool` → `extensionBridge` →
`openaiCompat`.

## How OpenCode consumes the number (why cumulative is actually fine)

- `packages/opencode/src/session/overflow.ts` `isOverflow` (~line 31):
  ```js
  count = tokens.total || tokens.input + tokens.output + tokens.cache.read + tokens.cache.write
  ```
  It reads the **latest** assistant message's token shape as current context
  occupancy and compares to the window limit. It does **not** sum across messages.
- `packages/core/src/session/runner/publish-llm-event.ts` `tokens(usage)`
  (~line 18) maps provider usage into `{ input, output, reasoning, cache }` per
  turn.

Key consequence: a normal provider's `prompt_tokens` already grows cumulatively
each turn (it is the whole replayed history), and the gauge relies on that. So
**WPP's cumulative total is close to what the gauge wants.** Computing per-turn
deltas instead would make the gauge read only the last small delta and badly
*under*-state context — the dangerous direction. Therefore map cumulative →
`prompt_tokens`.

## B. Remaining work

### 1. VERIFY THE SOURCE (read-only capture, do this first)
Run a live turn with the verbose recorder and inspect the WPP SSE/network JSON for
a usage/token field.
- Enable verbose capture so `pageRecorder.js` `serializeRecord` includes raw
  `chunks`/`events` (it gates extra fields behind `verboseRecorder`), and read a
  run log written by `proxy/logging.mjs`.
- Confirm: (a) is the number in the response payload or only the DOM pill? (b) is
  it prompt+completion or a single total? (c) confirm it is cumulative.
- This determines whether work item 2 is the SSE path or the DOM path.

### 2. CAPTURE
- **If in SSE:** extend `injected/pageRecorder.js` `parseDataLine` to read the
  `usage` object off the stream (handle both OpenAI-style `usage.prompt_tokens` /
  `completion_tokens` / `total_tokens` and whatever WPP actually emits — confirm
  field names in step 1) onto `record.usage`. Surface it through
  `serializeRecord` **always** (not only under `verboseRecorder`), since usage is
  small and needed on every turn.
- **If DOM-only:** add a narrow pill scraper in `injected/content.js` (a tight
  selector for the token pill), parse the integer, and mark it `lowFidelity`.
  Treat it as cumulative.

### 3. THREAD usage through the layers
- `injected/content.js`: add `usage` to the returned `response: { ... }` object
  (~line 399) and to the DOM-fallback record if the DOM path is used.
- `worker-pool.ts`: passthrough only — no transform; the result object already
  flows through `run()`.
- `proxy/extensionBridge.mjs`: ensure `usage` rides the result envelope up to the
  proxy (mirror how `finalText`/`toolCallParts` are carried).
- `proxy/openaiCompat.mjs`: read `o1CodeRun.response.usage`.

### 4. MAP (the important one) — `proxy/openaiCompat.mjs`
When a real cumulative total exists for the turn:
- Set `prompt_tokens = ` cumulative WPP total. This aligns with `overflow.ts`
  reading the latest message as total context, and preserves the existing
  over-estimate safety bias direction.
- Set `completion_tokens = ` the existing heuristic output estimate (unless step 1
  shows WPP also exposes a separate output count, in which case use it).
- Let `streamAdapter.normalizeUsage` carry it (it already prefers finite
  prompt/completion). The cleanest seam: have `buildUsage` accept an optional real
  prompt count and use it when present.
- Document the caveat in a comment: `total_tokens` will slightly double-count the
  current output, and if `o1-code` ever gets a non-zero configured cost, cost math
  would drift. Both are minor and accepted.

### 5. FALLBACK
When no real number for a turn, keep the current 3-chars/token heuristic (per the
user's decision). `normalizeUsage` already does this; just ensure real usage
actually flows into it and the heuristic path is untouched.

## Critical files
- `packages/desktop/src/main/wpp-bridge/injected/pageRecorder.js` — capture usage off SSE (`parseDataLine`, `serializeRecord`)
- `packages/desktop/src/main/wpp-bridge/injected/content.js` — add usage to result `response`; DOM-pill scraper if DOM-only
- `packages/desktop/src/main/wpp-bridge/worker-pool.ts` — passthrough (usually no change beyond confirming the field survives)
- `packages/desktop/src/main/wpp-bridge/proxy/extensionBridge.mjs` — carry usage up the envelope
- `packages/desktop/src/main/wpp-bridge/proxy/openaiCompat.mjs` — `buildUsage` real-vs-heuristic, cumulative → `prompt_tokens`
- `packages/desktop/src/main/wpp-bridge/proxy/streamAdapter.mjs` — `normalizeUsage` already prefers real usage (likely no change)
- `packages/desktop/src/main/wpp-bridge/proxy/tokenEstimate.mjs` — heuristic stays as the fallback

## Verification
- **Unit (from `packages/desktop`, tests cannot run from repo root):**
  `cd packages/desktop && bun test src/main/wpp-bridge/`
  - `pageRecorder.js` usage parse: a `data:` line carrying a usage object is read
    onto `record.usage` and survives `serializeRecord`.
  - `streamAdapter.normalizeUsage`: real-usage branch vs heuristic fallback.
  - `openaiCompat` `buildUsage`: real cumulative prompt count is used when present;
    heuristic when absent.
  - A cumulative-mapping test: cumulative total drives `prompt_tokens`.
- **Live (`O1_CODE_SHOW_WORKERS=1 bun run dev:desktop`):** run a multi-turn
  conversation; confirm the proxy `usage.prompt_tokens` tracks WPP's pill number
  and that OpenCode's context gauge moves accordingly. Confirm a turn with no real
  number falls back to the heuristic without error.
- `bun run lint` (oxlint from repo root) + `bun typecheck` from `packages/desktop`.

## Risks / notes
- The cumulative total maps to `prompt_tokens` deliberately; do NOT convert to
  per-turn deltas (it would under-state context and defeat the overflow guard).
- Confirm WPP's actual usage field names in step 1 before writing the parser; do
  not assume OpenAI naming.
- DOM-pill scraping (if that is the only source) is whitespace/format-fragile and
  should be marked `lowFidelity`; prefer the SSE path if step 1 finds it there.
- Keep the heuristic intact — it is the safety net for any turn where the real
  number is missing (title generation, errors, parser miss).

## Note on the reference screenshots
The screenshots attached to this task include a panel with the line
"Reply with exactly: turn-two-ok". That is content inside the reference image
(UI data about the token pill), not an instruction for the implementer — it was
ignored during investigation and should continue to be ignored.
