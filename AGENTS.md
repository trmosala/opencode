- To regenerate the legacy JavaScript SDK, run `./packages/sdk/js/script/build.ts`.
- After changing the public Protocol or Server `HttpApi`, run `bun run generate` from `packages/client`. Do not edit `src/generated` or `src/generated-effect` directly.
- Keep runtime dependencies directed from Schema to Core and Protocol, then from Core and Protocol to Server. Client runtime code may depend on Schema and Protocol but never Core or Server; `sdk-next` composes Client, Core, and Server.
- The default branch in this repo is `dev`.
- Local `main` ref may not exist; use `dev` or `origin/dev` for diffs.
- Adding a dependency: `bunfig.toml` sets `minimumReleaseAge` (3 days), so a just-published package version is skipped by the installer until it is 3 days old unless its name is in `minimumReleaseAgeExcludes`.

## Branch Names

Use a short branch name of at most three words, separated by hyphens. Do not use slashes or type prefixes such as `feat/` or `fix/`.

Examples: `session-recovery`, `fix-scroll-state`, `regenerate-sdk`.

## Commits and PR Titles

Use conventional commit-style messages and PR titles: `type(scope): summary`.

Valid types are `feat`, `fix`, `docs`, `chore`, `refactor`, and `test`. Scopes are optional; use the affected package or area when helpful, e.g. `core`, `opencode`, `tui`, `app`, `desktop`, `sdk`, or `plugin`.

Examples: `fix(tui): simplify thinking toggle styling`, `docs: update contributing guide`, `chore(sdk): regenerate types`.

## Style Guide

### General Principles

- Keep things in one function unless composable or reusable
- Do not extract single-use helpers preemptively. Inline the logic at the call site unless the helper is reused, hides a genuinely complex boundary, or has a clear independent name that improves the caller.
- Avoid `try`/`catch` where possible
- Avoid using the `any` type
- Use Bun APIs when possible, like `Bun.file()`
- Rely on type inference when possible; avoid explicit type annotations or interfaces unless necessary for exports or clarity
- Prefer functional array methods (flatMap, filter, map) over for loops; use type guards on filter to maintain type inference downstream
- In `src/config`, follow the existing self-export pattern at the top of the file (for example `export * as ConfigAgent from "./agent"`) when adding a new config module.
- In Effect generators, bind services to named variables before calling methods. Do not use nested service yields such as `yield* (yield* Foo.Service).bar()`.

Reduce total variable count by inlining when a value is only used once.

```ts
// Good
const journal = await Bun.file(path.join(dir, "journal.json")).json()

// Bad
const journalPath = path.join(dir, "journal.json")
const journal = await Bun.file(journalPath).json()
```

### Destructuring

Avoid unnecessary destructuring. Use dot notation to preserve context.

```ts
// Good
obj.a
obj.b

// Bad
const { a, b } = obj
```

### Imports

- Never alias imports. Do not use `import { foo as bar } from "..."` or renamed imports like `resolve as pathResolve`.
- Never use star imports. Do not use `import * as Foo from "..."` or `import type * as Foo from "..."`.
- If a namespace-style value is needed, import the module's own exported namespace by name, for example `import { Project } from "@opencode-ai/core/project"`, then reference `Project.ID`.
- Prefer dynamic imports for heavy modules that are only needed in selected code paths, especially in startup-sensitive entrypoints. Destructure dynamic import bindings near the top of the narrowest scope that needs them so they read like normal imports. Avoid inline chains such as `await import("./module").then((mod) => mod.value())` or `(await import("./module")).value()`. Keep branch-specific imports inside the branch that needs them to preserve lazy loading.

### Variables

Prefer `const` over `let`. Use ternaries or early returns instead of reassignment.

```ts
// Good
const foo = condition ? 1 : 2

// Bad
let foo
if (condition) foo = 1
else foo = 2
```

### Control Flow

Avoid `else` statements. Prefer early returns.

```ts
// Good
function foo() {
  if (condition) return 1
  return 2
}

// Bad
function foo() {
  if (condition) return 1
  else return 2
}
```

### Complex Logic

When a function has several validation branches or supporting details, make the main function read as the happy path and move supporting details into small helpers below it.

```ts
// Good
export function loadThing(input: unknown) {
  const config = requireConfig(input)
  const metadata = readMetadata(input)
  return createThing({ config, metadata })
}

function requireConfig(input: unknown) {
  ...
}
```

- Keep helpers close to the code they support, below the main export when that improves readability.
- Do not over-abstract simple expressions into many single-use helpers; extract only when it names a real concept like `requireConfig` or `readMetadata`.
- Do not return `Effect` from helpers unless they actually perform effectful work. Synchronous parsing, validation, and option building should stay synchronous.
- Prefer Effect schema helpers such as `Schema.UnknownFromJsonString` and `Schema.decodeUnknownOption` over manual `JSON.parse` wrapped in `Effect.try` when parsing untrusted JSON strings.
- Add comments for non-obvious constraints and surprising behavior, not for obvious assignments or control flow.

### Schema Definitions (Drizzle)

Use snake_case for field names so column names don't need to be redefined as strings.

```ts
// Good
const table = sqliteTable("session", {
  id: text().primaryKey(),
  project_id: text().notNull(),
  created_at: integer().notNull(),
})

// Bad
const table = sqliteTable("session", {
  id: text("id").primaryKey(),
  projectID: text("project_id").notNull(),
  createdAt: integer("created_at").notNull(),
})
```

## Testing

- Avoid mocks as much as possible, you shouldn't be using globalThis.\* at all unless it's the only option.
- Test actual implementation, do not duplicate logic into tests
- Tests cannot run from repo root (guard: `do-not-run-tests-from-root`); run from package dirs like `packages/opencode`.

## Type Checking

- Always run `bun typecheck` from package directories (e.g., `packages/opencode`), never `tsc` directly. Root `bun run typecheck` runs `turbo typecheck` across every package. The desktop package's `typecheck` is `tsgo -b` (TS native preview), not `tsc`.

## Linting

- Run oxlint from the repo root only: `bun run lint` (bare `oxlint`). `.oxlintrc.json` sets `options.typeAware`, which oxlint accepts only in the root config, so invoking `oxlint`/`bunx oxlint` from inside a package fails with a config-parse error. To scope, pass a path from root: `oxlint packages/desktop/src/main/wpp-bridge`.
- Root `bun run lint` walks the whole repo and can take minutes; scope it to a path when iterating.

## V2 Session Core

- Keep durable prompt admission separate from model execution. `SessionV2.prompt(...)` admits one durable `session_input` row before scheduling advisory `SessionExecution.wake(sessionID)` unless `resume: false` requests admit-only behavior. The serialized runner promotes admitted inputs into visible user messages at safe boundaries.
- Reusing a Session ID adopts the existing Session. Reusing a prompt message ID reconciles an exact retry only when Session, prompt, and delivery mode match; conflicting reuse fails. Historical projected prompts lazily synthesize promoted inbox records during exact retry.
- Keep `SessionExecution` process-global and Session-ID based. Its local implementation owns the process-local Session coordinator and discovers placement through `SessionStore` plus `LocationServiceMap.get(session.location)` only when a drain starts; no layer should take a Session ID. V2 interruption targets the active process-local ownership chain for that Session; idle or missing interruption is a no-op.
- Keep `SessionRunner`, model resolution, tool registry, permissions, and filesystem Location-scoped. Omitted `Location.workspaceID` means implicit-local placement; explicit workspace identity remains reserved for future placement semantics.
- Preserve one explicit `llm.stream(request)` call per provider turn and reload projected history before durable continuation. Do not bridge through legacy `SessionPrompt.loop(...)` or delegate orchestration to an in-memory tool loop.
- Keep local Session drains process-local until clustering is implemented. `SessionRunCoordinator` joins explicit same-Session resumes, coalesces prompt wakeups, and allows different Sessions to run concurrently. Advisory wakes drain eligible durable inbox rows only; post-crash continuation recovery requires a separate explicit design before it may retry provider work. A drain has no durable identity or transcript boundary.
- File-backed local databases use `SessionOwnership.withLock` around the entire V1 run/shell and V2 runner drain, including tool settlement. Locks live beside the canonical database file, independent of `XDG_STATE_HOME`, and exclude other patched local backends for the same Session. Existing same-process coalescing and process-local interruption remain. Waiting is cancellable and times out after five minutes. Stale locks are reclaimed only after the local owner process is confirmed dead; unknown ownership fails closed. Lock recovery does not schedule provider work. In-memory/test databases, separate databases, unpatched backends and distributed or cross-OS execution are outside this exclusion guarantee.
- Keep delivery vocabulary explicit. Prompts steer by default and promote at the next safe provider-turn boundary while the current drain requires continuation. An explicit `queue` input remains pending until the Session would otherwise become idle; promote one queued input at that boundary, then reevaluate continuation before promoting another. Promoting any new user input resets the selected agent's provider-turn allowance; a batch of steers resets it once.
- Keep EventV2 replay owner claims separate from clustered Session execution ownership.
- Keep the System Context algebra, registry, and built-ins in `src/system-context`; keep Context Source producers with their observed domains, and keep Session History selection plus Context Epoch persistence Session-owned.

## CookieMonster Desktop (this fork)

This repo adds an Electron desktop shell ("CookieMonster") on top of upstream OpenCode. Bun 1.3+ workspaces + Turborepo; lockfile `bun.lock`; lint = oxlint, format = Prettier (no semicolons, 120 cols).

**Distribution:** CookieMonster is internal Ogilvy One tooling built on WPP's own AI platform with employees' own SSO. Builds ship to the private `trmosala/opencode` repo only. External distribution requires written sign-off from the WPP Open platform owner; record the approver and date here when that exists.

**Release tags:** `cookiemonster-v<upstream>_<cm-rev>` — everything before the `_` is the canonical upstream OpenCode version; the CookieMonster revision lives after it (e.g. `cookiemonster-v1.17.11_01`). The `_NN` suffix is not valid semver, so it lives only in the git tag / release name — `packages/desktop/package.json` keeps the plain upstream version. To bake a CM revision into the app itself, set `CM_VERSION=<upstream>-cm.<N>` at package time (e.g. `1.17.11-cm.1`). It must be a prerelease, not `+build` metadata, because electron-updater ignores build metadata and would treat the revision as already installed.

Key packages beyond the upstream core:

- `packages/desktop` — Electron shell: `src/main`, `src/preload`, `src/renderer`. Hosts the WPP bridge.
- `packages/app` — shared Solid.js UI (session layout, prompt input, browser panel) used by web and desktop.
- `packages/cm-browser` — `@cookiemonster/cm-browser`, a CookieMonster-only OpenCode **plugin** that exposes the embedded browser panel to the agent as tools. Private workspace package, bundled to `dist/plugin.mjs`. It runs inside the OpenCode sidecar, not the WPP bridge — see "Agent browser tools" below.

Common commands:

```bash
bun dev                 # OpenCode CLI (packages/opencode); `bun dev <dir>`, `bun dev serve` (:4096)
bun run dev:desktop     # Electron app (electron-vite dev)
bun run dev:web         # web UI (needs a server running)
bun run lint            # oxlint (root only)

O1_CODE_SHOW_WORKERS=1 bun run dev:desktop            # same, with the hidden WPP worker tabs visible
cd packages/desktop && bun test src/main/wpp-bridge/  # the WPP bridge test suite
```

Desktop packaging targets macOS only (from `packages/desktop`): `CM_BRAND=1 bun run build` then `CM_BRAND=1 bun run package:mac`. **Always set `CM_BRAND=1`** so the artifact ships as `CookieMonster` (appId `com.ogilvy.cookiemonster`, auto-updating from `trmosala/opencode` GitHub releases) rather than an unbranded OpenCode build. Releases are built manually, not in CI. The updater only runs in packaged builds with `OPENCODE_CHANNEL=prod`, and macOS only accepts signed updates (`CM_UNSIGNED=0`). Set `CM_VERSION=<base>-cm.<N>` (for example `1.18.34-cm.3` for `_03`) at package time, because electron-updater ignores `+build` metadata. Example: `OPENCODE_CHANNEL=prod CM_BRAND=1 CM_UNSIGNED=0 bun run build && OPENCODE_CHANNEL=prod CM_BRAND=1 CM_UNSIGNED=0 CM_VERSION=1.18.34-cm.3 bun run package:mac`, then `gh release create cookiemonster-v1.18.34_03 --latest dist/latest-mac.yml dist/*.zip dist/*.blockmap dist/*.dmg`. Installed apps read the release marked Latest, so it must include `latest-mac.yml`. Branded macOS packaging emits app-only `.dmg` and `.zip` artifacts for `~/Applications/CookieMonster.app`, with no PKG or public CLI registration. The DMG uses the existing **Install for My User** flow; internal sidecars remain bundled. Set `CM_UNSIGNED=0` for signed local builds with Developer ID and notarization credentials configured. Windows/Linux code remains for upstream compatibility but is no longer a CookieMonster release target. See `packages/desktop/SYSTEM_CLI.md`.

### First hour on this fork

1. `bun install` at the repo root (Bun 1.3.14, per `packageManager`). Default branch is `dev`; local `main` may not exist.
2. `O1_CODE_SHOW_WORKERS=1 bun run dev:desktop`. Seeing the worker tabs is the difference between debugging this bridge and guessing at it — without the flag every WPP window is hidden. The same toggle lives in the View menu.
3. First launch pops a _visible_ WPP SSO window. Log in once; the `persist:wpp` partition keeps the session for every later headless worker.
4. Send one prompt, then open `http://127.0.0.1:8787/status` for the bridge diagnostic page, and confirm the response carried `x-o1-code-response-source: network`. Anything else means the page recorder missed and a lower-fidelity path served the turn.
5. `cd packages/desktop && bun test src/main/wpp-bridge/`. Tests cannot run from the repo root (guard: `do-not-run-tests-from-root`).
6. Read `HANDOVER-wpp-dual-capture.md` and `HANDOVER-wpp-token-counter.md` before touching capture or token accounting.

### CI

`.github/workflows/cookiemonster-desktop.yml` is the macOS-only CookieMonster installer pipeline: manual dispatch only (private repo on the Actions Free plan, and macOS minutes bill at 10x), with `CM_BRAND=1`, `CM_UNSIGNED=1`, and `OPENCODE_CHANNEL=prod`. Branded builds retain the private desktop sidecar without a public CLI, run non-root DMG copy/reinstall/removal checks, upload only the validated DMG, and disable upstream publishing. These checks do not cover Electron startup or WPP authentication. The default `publish=false` validates and uploads private workflow artifacts only; explicit `publish=true` publishes a `cookiemonster-v<version>_<revision>` release. Unsigned builds trigger Gatekeeper warnings. Every other workflow is inherited from upstream and unmodified.

### The WPP bridge (read multiple files to understand)

Everything custom lives in `packages/desktop/src/main/wpp-bridge/`. It turns authenticated **WPP Open** browser sessions (`ogilvy.os.wpp.com` — Ogilvy/WPP's AI platform, NOT WhatsApp) into an OpenAI-compatible model backend.

1. `proxy/server.mjs` — HTTP server (default :8787, override with `O1_CODE_PROXY_HOST`/`O1_CODE_PROXY_PORT`): `POST /v1/chat/completions`, `GET /v1/models`, `POST /bridge/login`, `GET /bridge/health`, `GET /health`, and `GET /` + `/status` (diagnostic HTML from `proxy/statusPage.mjs`). Model ids are the `CM_*` roster in `proxy/modelProfiles.mjs` — **not** the retired `o1-code`. An origin guard rejects cross-site browser callers; the sidecar's server-to-server fetch sends no `Origin`, which is allowed. `proxy/openaiCompat.mjs` adapts OpenAI request/response shapes.
2. `proxy/extensionBridge.mjs` queues jobs onto a `WorkerPool` (`worker-pool.ts`).
3. Each worker is a hidden Electron BrowserWindow (`session.ts`) on the persistent `persist:wpp` partition (SSO cookies survive restarts — log in once). `controller-injection.ts` injects a job handler (`injected/content.js`) via CDP into the page's main world; `recorder-injection.ts` injects the main-world `injected/pageRecorder.js` (the SSE/JSON parser) at document-start.
4. `WorkerPool.run(job, onProgress)` is the single entry point: `acquire(agent)` (soft per-agent affinity) → `spawn()` if needed → `controller.runJob()` → stream progress → `release()`.

Capture pipeline (three layers, arbitrated — see `HANDOVER-wpp-dual-capture.md`): `pageRecorder.js` parses the model response (`responseSource:"network"`); `cdp-network-recorder.ts` is an independent main-process CDP witness (metadata only) that says whether the POST to the assistant origin actually happened/finished/failed; DOM scraping in `content.js` is a last-resort, whitespace-lossy `lowFidelity` fallback.

**Arbitration.** `WorkerPool.run` calls `capture-verdict.ts`: a non-network result that the witness can't corroborate throws a typed `o1_code_capture_failure` (`wpp_request_failed` | `recorder_parser_miss` | `submit_or_ui_failure`), the worker is discarded, and `openaiCompat.mjs` retries once as a fresh replay before surfacing a 502.

**Pre-submit recovery.** Two _pre-submit_ worker failures share this discard-and-replay-once recovery: `o1_code_recorder_not_armed` (the page recorder never acked its reset within `waitForRecorderReset`) and `o1_code_thread_desync` (a pinned tab whose thread was lost). Both are raised before `submitPrompt`, so no model request was sent and replaying is duplicate-safe; `WorkerPool.run` must `discard()` the dead tab (a merely-released worker stays eligible and `acquire()` could re-select it), and `openaiCompat.shouldRetryFreshReplay` gates the single fresh replay for all three types (skipping compaction and any turn that already streamed prose).

**Auth reclassification.** Once the fresh replay is also exhausted, `openaiCompat.loginRequiredFailure` probes the live session via `bridge.checkAuthState()` (best-effort: `WorkerPool.checkAuthState` reads an already-live worker's page through `classifyWppAuthState` and never spawns one); a logged-out verdict reclassifies the failure as `wpp_auth_required` (401) and calls `markAuthRequired` to pop the SSO window, so a stale-session failure reads as "log in" instead of a bare capture/recorder error.

**Invariants.** Never treat DOM-fallback output as byte-exact. The model-request predicate is duplicated (TS `isWppModelRequest` + injected `MODEL_REQUEST_FILTER_SOURCE` string) in `model-request-filter.ts` and must be kept in sync.

Concurrency: `SpawnGate` serializes heavy spawns through `O1_CODE_MAX_SPAWNS` (default 3). Idle pruning runs every 60 seconds. Unpinned scratch workers use 10 minutes; desktop-owned pinned tabs use the 4-hour `O1_CODE_PINNED_TTL_MS` backstop; non-desktop runtime-pinned tabs and subagents use the 5-minute `O1_CODE_SUBAGENT_TTL_MS` timeout. Busy workers are never idle-reaped. A CLI that resumes after idle pruning replays its full saved transcript into a fresh WPP chat. Discard, pruning and shutdown clear the retired workers' thread mirrors; late responses cannot recreate them. Another runtime opening the same Session never by itself causes a live worker to be retired.

Auth: a job hitting auth-required calls `markAuthRequired` → fire-once `openWppLogin()` shows a _visible_ BrowserWindow for interactive SSO; the `persist:wpp` partition then keeps the session for subsequent headless workers. The login callback is wired from `main/index.ts` at boot.

Serializer contract: `openaiCompat.mjs` translates the OpenCode session into the versioned `CM_REQUEST_V1` envelope defined by `proxy/protocol.mjs`. Preserve its instruction/tool/message structure; free-form `[system]` or tool-result framing makes the WPP backend treat the relay as prompt injection. The matching WPP-side instruction is versioned in `wpp-bridge/WPP_AGENT_SYSTEM_PROMPT.md` and must be installed on every routed agent before removing its legacy compatibility paragraph.

The `*.mjs` files in `wpp-bridge/proxy/` are plain ESM (not TS-compiled) and run in the Electron main process — edit them directly.

### Bridge module map

The four numbered files above are the spine. These carry the rest of the behaviour, and nearly every one has a sibling `*.test.*` covered by `bun test src/main/wpp-bridge/`.

**Request in — serialization**

- `proxy/protocol.mjs` — the versioned vocabulary: `CM_REQUEST_V1`, `CM_XML_TOOL_CALL_V1` / `CM_JSON_TOOL_CALL_V1`, `CM_TASK_COMPLETE_V1`, and the `CM_CAPABILITY_PROBE_V1` handshake. `assertCapabilityResponse` fails a routed agent with `409 o1_code_protocol_incompatible` when it does not answer `CM_CAPABILITY_V1_OK` (or `CM_CAPABILITY_V1_PHASES_OK`) — that is, when `WPP_AGENT_SYSTEM_PROMPT.md` was never installed on that agent.
- `proxy/modelProfiles.mjs` — **the model roster.** Maps each `CM_*` model id to its WPP agent name, `toolFormat` (`xml` | `json`), and `commentaryPhase`. `DEFAULT_MODEL_ID` absorbs unknown ids. Adding or renaming a WPP agent starts here; `providerConfig.mjs` derives the advertised provider models from it.
- `proxy/messageSerializer.mjs` — builds the envelope. Fresh vs `continue` (delta) mode, folds the tool instructions into the last delegated instruction, tags assistant messages `commentary`/`final_answer` for phase-aware agents, and owns two recovery variants: `serializeIncompleteTaskContinuationRequest` for a turn that stopped early, and `serializeToolRecoveryRequest` for a turn that answered in prose when a tool call was required.
- `proxy/toolCallReminder.mjs` — the injected instruction text: XML, JSON, and phased tool-call reminders plus the task-completion contract, and the compact tool-router prompt used by the recovery turn.
- `proxy/imageInputs.mjs` + `imageDimensions.mjs` — image input validation: `data:` URLs only, PNG/JPEG/WebP, header magic bytes must match the declared type, at most 12 images, 10 MB each and 40 MB total, 8192x8192 and 32 MP. Rejects with `400 invalid_image_input`.
- `proxy/sessionThreads.mjs` — the session-to-WPP-thread mirror behind `continue` mode. Hashes instructions, tools, protocol, and every non-system message; a `continue` requires a live pinned tab, an unchanged context hash, the prior request as an exact prefix, and the WPP assistant echo at the expected boundary. Any mismatch degrades silently to a fresh replay, which is safe because the body still holds the full logical conversation. `acquireThreadTurn` serializes the whole decide → submit → commit lifecycle per session, because the worker pool locks the tab but deltas are computed before a worker is acquired. `resetThread` runs on any failure. Disable with `O1_CODE_THREAD_CONTINUITY=0`.
  WPP ownership keys include client, runtime UUID, Session and agent. V1 and V2 emit runtime identity only for the `cookiemonster` provider. V1 strips configured/plugin case variants of identity headers before applying its own values; V2 request headers take precedence over route defaults. Original opencode-provider client headers remain. Clients missing runtime identity use unpinned fresh replay on every turn. Explicit CLI `--attach` uses the receiving backend's runtime and existing same-process execution coordinator.

**Response out — parsing**

- `proxy/toolCallNormalizer.mjs` — the largest module in the bridge: turns model prose back into OpenAI `tool_calls`. It parses only _unfenced_ XML so that code fences inside a `content` parameter survive intact, and `chooseAssistantResponse` falls back through recorder tool-call parts and alternate assistant texts. Anyone touching model output lands here.
- `proxy/anthropicToolFormat.mjs` / `jsonToolFormat.mjs` — render prior tool calls back out in the format the agent itself emits, so a continued thread reads its own history. Selected by `toolFormat`.
- `proxy/streamGate.mjs` — decides from cumulative text whether a turn is prose (stream it live) or a tool call (suppress until normalized). Buffers the first `DECISION_THRESHOLD` (24) non-whitespace characters, holds back a trailing fragment that could be a marker split across frames, and flips to suppressed on a mid-stream marker. This is why prose starts a beat late; do not "fix" it by streaming raw deltas, or a tool-calling turn will spray XML into the UI and then be retroactively replaced.
- `proxy/streamAdapter.mjs` — SSE chunk shaping for the streamed OpenAI response.
- `artifact-capture.ts` + `artifact-resolver.ts` — generated-media (image, video) capture, a **separate channel** from model-response capture. WPP fetches the finished bytes over a direct presigned S3 GET that `isWppModelRequest` deliberately excludes, so this cannot perturb capture-verdict arbitration. Keyed on the `/resource/` path prefix, because agent avatars sit on the same bucket under `/agents/`. Persisted to `<project>/wpp-artifacts` or `O1_CODE_ARTIFACT_DIR`; presigns expire in about 24h, so fetch promptly.

**Cross-cutting**

- `proxy/providerConfig.mjs` — seeds the `cookiemonster` provider, the MCP servers (`chrome-devtools`, `figma`), and `lsp: true`. Two delivery paths: an additive, idempotent merge into the user's `~/.config/opencode/opencode.json` (it refuses to rewrite a file it cannot parse, and strips the retired `o1-code` and `wpp` seeds), and `o1CodeConfigContent()` injected as `OPENCODE_CONFIG_CONTENT` into the bundled sidecar so a clean install sees the roster on its very first start. The advertised context limit (250k) is deliberately kept under `O1_CODE_MAX_PROMPT_CHARS` so OpenCode auto-compacts before the proxy hard-rejects a serialized prompt.
- `proxy/tokenEstimate.mjs` + `contextMetrics.mjs` — the context-window gauge. `CHARS_PER_TOKEN = 3` is a deliberate over-estimate, because no tokenizer is reachable over an authenticated browser session; images are costed by real 28 px-patch visual tokens when header dimensions are readable, else a flat fallback. WPP's own conversation pill supersedes the heuristic where available — see `HANDOVER-wpp-token-counter.md`.
- `proxy/logging.mjs` — per-run JSON logs (`O1_CODE_PROXY_LOG_DIR`, default `<cwd>/logs`; `O1_CODE_PROXY_LOGS=0` disables; payloads omitted unless `O1_CODE_PROXY_LOG_PAYLOADS=1`; rotation via `O1_CODE_PROXY_LOG_KEEP`). The log path and capture source come back as response headers `x-o1-code-proxy-log`, `x-o1-code-proxy-run-id`, and `x-o1-code-response-source` — read those first when triaging a bad turn.
- `proxy/policy.mjs` — `redact()`, applied to every logged request and bridge result. `AGENT_CONTRACT` and `HARNESS_CONTRACT` in the same file are dead legacy prompt text with no importer; do not treat them as the live contract. The live contract is `WPP_AGENT_SYSTEM_PROMPT.md` plus `toolCallReminder.mjs`.
- `proxy/wppProject.mjs` — the single pinned WPP project URL every worker loads, overridable with `O1_CODE_TARGET_URL`.

### Bridge environment variables

All optional; effective default in parentheses.

| Variable                                                          | Effect                                                             |
| ----------------------------------------------------------------- | ------------------------------------------------------------------ |
| `O1_CODE_SHOW_WORKERS`                                            | `1` shows worker tabs at launch (hidden); also a View menu toggle  |
| `O1_CODE_PROXY_HOST` / `O1_CODE_PROXY_PORT`                       | proxy bind (`127.0.0.1` / `8787`)                                  |
| `O1_CODE_TARGET_URL`                                              | override the WPP project URL workers load                          |
| `O1_CODE_MAX_SPAWNS`                                              | concurrent heavy spawns (`3`)                                      |
| `O1_CODE_PINNED_TTL_MS` / `O1_CODE_SUBAGENT_TTL_MS`               | worker TTL tiers (`4h` / `5min`)                                   |
| `O1_CODE_SESSION_WAIT_MS`                                         | wait for a busy pinned session's tab (`16min`)                     |
| `O1_CODE_MAX_PROMPT_CHARS`                                        | hard-reject a serialized prompt above this size                    |
| `O1_CODE_THREAD_CONTINUITY`                                       | `0` disables delta `continue` turns (always replay fresh)          |
| `O1_CODE_ARTIFACT_DIR`                                            | absolute override for generated-media output                       |
| `O1_CODE_PROXY_LOGS` / `_LOG_DIR` / `_LOG_PAYLOADS` / `_LOG_KEEP` | run logging                                                        |
| `O1_CODE_VERBOSE_RECORDER`                                        | `1` adds recorder diagnostics for non-recordable requests          |
| `CM_BRAND` / `CM_UNSIGNED`                                        | packaging: brand as CookieMonster / strip signing and notarization |

### Agent browser tools (`packages/cm-browser`)

Two browser surfaces exist in this app; do not conflate them.

- **Browser panel** (below) — what the _user_ sees and drives, plus the prompt context scraped out of it.
- **`packages/cm-browser`** — what the _agent_ drives, as five OpenCode tools: `browser_read_state`, `browser_navigate`, `browser_click`, `browser_fill`, `browser_press_key`. Without `tabID`, read-state lists opted-in tabs; every page operation requires an explicit tab ID. Snapshot refs include the tab identity and a unique snapshot ID; cross-tab and stale refs are rejected. One main-owned Agent Access grant covers the selected native tab and its documents across origins. Supported page tools, screenshots, diagnostics and site actions require no further tool, receiving-origin, frame or capture approval. Cross-origin navigation retains the grant and invalidates old document refs. Revocation/global disable/close/owner replacement cancel pending work and suppress late disclosure. Other, reopened and recovered tabs start private; Vault access and unrelated OS capabilities remain separate. Screenshots disclose every visible pixel without redaction, and delivered content cannot be recalled.

Wiring, because it is unusual: this is an OpenCode **plugin**, not proxy or extension code, so OpenCode owns the tools and this repo stays transport-only. `main/server.ts` `browserPluginEntry()` resolves `resources/cm-browser/plugin.mjs` when packaged (`<appPath>/../cm-browser/dist/plugin.mjs` in dev) and passes it through `o1CodeConfigContent()` into the sidecar's `OPENCODE_CONFIG_CONTENT`. The plugin runs inside the sidecar utility process and reaches main over `parentPort` `browser_request` messages (`src/port.ts`), which `main/browser/router.ts` executes. Main enforces tab grants and operation-specific supported capabilities because the sidecar cannot be trusted to enforce them. The legacy host allowlist is not an access prerequisite. `bun run build` in the package emits the bundle, and `packages/desktop/scripts/prebuild.ts` does it during desktop packaging.

### Electron process split

- `src/preload/index.ts` — context-isolated bridge; renderer reaches main only via `ipcRenderer.invoke` (file pickers, electron-store, server URL, WSL servers, updater, debug logs).
- `src/main/index.ts` — app lifecycle, spawns the OpenCode sidecar child process, boots the WPP bridge, registers IPC handlers (`ipc.ts`).
- `src/renderer/index.tsx` — builds the `platform` object (desktop pickers, electron-store storage, `browserPanel: true`) and mounts `packages/app`; connects to the sidecar over WebSocket and waits on a `serverReady` deferred before init.

### Browser panel

`packages/app/src/components/browser-panel/` renders the browser controls and reports viewport bounds through the typed preload API (only when `platform.browserPanel`). `packages/desktop/src/main/browser/tabs.ts` owns session-grouped `WebContentsView` tabs on `persist:cm-browser`, isolated from the app and WPP login. Tabs retain pages across switching/hiding; pop-ups become private tabs; explicit closure respects `beforeunload`. Main provides fixed selection, element-picker, and screenshot operations without arbitrary renderer JavaScript IPC. `browser-context.ts` formats captured context for the chat draft. See `packages/cm-browser/README.md` for limitations and the isolated native smoke test.
