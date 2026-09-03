# CookieMonster embedded browser: product and architecture options

Research date: 2026-08-18

## Recommendation

It is worth making CookieMonster's embedded browser substantially more capable, but the target should be a **production agent browser workspace**, not a general-purpose consumer browser.

The valuable product is a browser that the user and agent can share: the user can log in and take over, the agent can inspect and act through a bounded tool contract, and every sensitive action remains attributable and permission-gated. Building Chrome-like product surfaces such as bookmarks, password management, extension installation, sync, multiple user profiles, privacy modes, or consumer browser settings would create a second product with little benefit to CookieMonster's core workflow.

This direction is technically feasible. CookieMonster already owns the difficult integration seams: a visible Chromium surface, durable signed-in state, session-scoped targeting, main-process policy enforcement, trusted CDP input, stale-reference rejection, and OpenCode tool permissions. The recommended implementation foundation is Electron's `WebContentsView` plus `webContents.debugger`/Chrome DevTools Protocol (CDP), while Microsoft Playwright MCP, Chrome DevTools for agents, Browser Use, and Stagehand serve as capability and reliability references.

Do not directly adopt a competing browser-agent runtime for the embedded panel. Doing so would either create a second browser/session outside CookieMonster or duplicate OpenCode's existing agent loop and weaken CookieMonster's current permission and session boundaries.

## The product boundary

### Consumer browser

A consumer browser owns the whole browsing product: omnibox/search behavior, bookmarks and history management, passwords and autofill, extensions, profiles and sync, privacy modes, downloads UI, browser settings, certificates, proxy configuration, update cadence, and broad arbitrary-web compatibility.

Electron explicitly says that it is not a web browser and warns that displaying arbitrary remote content is a severe security risk. Its security checklist places navigation, window creation, permission requests, sandboxing, Node isolation, IPC sender validation, and Electron/Chromium updates on the application developer. That makes a Chrome replacement both the wrong scope and a permanent security-maintenance obligation. [Electron security guidance](https://www.electronjs.org/docs/latest/tutorial/security)

### Production agent browser workspace

An agent browser needs a narrower but deeper contract:

- a user-visible, authenticated page that supports takeover;
- reliable semantic state, element identity, screenshots, and action feedback;
- navigation, history, tabs, popups, frames, dialogs, waits, scrolling, pointer/keyboard input, file transfer, and downloads;
- explicit policy for hosts, redirects, permissions, files, credentials, and consequential actions;
- session isolation, cancellation, audit history, and clear ownership when more than one agent is active;
- optional diagnostics such as console and network views, exposed separately from ordinary browsing actions.

That is a realistic extension of CookieMonster's current architecture and directly improves research, form-filling, Teams workflows, live-site inspection, visual QA, and authenticated troubleshooting.

## What CookieMonster already has

The browser is not just a panel. It is two connected CookieMonster-only layers:

1. The user-facing Electron panel mounts a sandboxed `<webview>`, persists the current URL, supports back/forward/reload, and can add a URL, selected content, or screenshot to the prompt. It registers the guest `webContents` against the OpenCode session after `dom-ready`. See [`browser-panel.tsx`](../../packages/app/src/components/browser-panel/browser-panel.tsx#L45).
2. The `@cookiemonster/cm-browser` plugin exposes five session-scoped tools: `browser_read_state`, `browser_navigate`, `browser_click`, `browser_fill`, and `browser_press_key`. Reads and mutations pass through OpenCode's permission system. See [`tools.ts`](../../packages/cm-browser/src/tools.ts#L68).
3. The sidecar sends correlated `browser_request` messages to Electron main, where the exact session's registered guest is resolved. Registration verifies that the target is a live `webview` belonging to the requesting renderer. See [`registry.ts`](../../packages/desktop/src/main/browser/registry.ts#L8) and [`server.ts`](../../packages/desktop/src/main/server.ts#L61).
4. Electron main owns the authoritative host allowlist. The driver attaches `webContents.debugger`, captures page state, rejects stale refs, and dispatches trusted mouse and keyboard events through CDP. See [`allowlist.ts`](../../packages/desktop/src/main/browser/allowlist.ts#L1) and [`driver.ts`](../../packages/desktop/src/main/browser/driver.ts#L47).

This is a strong architecture seed. It preserves a crucial boundary that generic MCP servers do not provide automatically: the model does not choose an arbitrary browser target or gain raw CDP access; CookieMonster routes a typed operation to the view owned by that OpenCode session.

The present implementation is still a small browser controller:

- snapshots are top-document DOM text, capped at 200 interactive elements and 12,000 visible-text characters, with no iframe or shadow-root traversal ([`snapshot.ts`](../../packages/desktop/src/main/browser/snapshot.ts#L1));
- the action set has no semantic waits, scroll, hover, selection, dialogs, upload/download, tabs, screenshots for the agent, console, or network tools;
- actions settle for a fixed 100 ms and timeouts race the operation without cancelling it ([`driver.ts`](../../packages/desktop/src/main/browser/driver.ts#L133), [`router.ts`](../../packages/desktop/src/main/browser/router.ts#L11));
- navigation is checked before dispatch, but the final redirected URL is not revalidated before its state is returned ([`router.ts`](../../packages/desktop/src/main/browser/router.ts#L17));
- password inputs are currently included by the interactive selector and their values can be used as element text ([`snapshot.ts`](../../packages/desktop/src/main/browser/snapshot.ts#L21));
- the UI uses `<webview>`, which Electron does not recommend and does not guarantee will remain available ([Electron web embeds](https://www.electronjs.org/docs/latest/tutorial/web-embeds)).

The first work should therefore harden the boundary, not add a large tool catalogue on top of it.

## Feasibility: Electron and CDP

Electron's `webContents.debugger` is an official main-process transport for CDP. It can attach to a specific `webContents`, receive protocol events, and send commands to that target without exposing a machine-wide remote-debugging port. [Electron Debugger API](https://www.electronjs.org/docs/latest/api/debugger/)

CDP already exposes the primitives a task browser needs:

- the Accessibility domain can return full or partial accessibility trees with stable node identities while enabled ([CDP Accessibility](https://chromedevtools.github.io/devtools-protocol/tot/Accessibility/));
- the Input domain supports mouse, keyboard, touch, drag, and gesture dispatch ([CDP Input](https://chromedevtools.github.io/devtools-protocol/tot/Input/));
- the Page domain covers navigation, history, lifecycle events, dialogs, screenshots, frame trees, and file chooser interception ([CDP Page](https://chromedevtools.github.io/devtools-protocol/tot/Page/));
- the Network domain exposes requests, responses, bodies, headers, timing, cookies, and cache control ([CDP Network](https://chromedevtools.github.io/devtools-protocol/1-3/Network/)).

CookieMonster already uses this exact transport for mouse/keyboard control. Expanding it is technically straightforward; making it reliable and safe is the real work.

There are two platform cautions:

1. Electron discourages `<webview>` because Chromium's underlying architecture can affect its stability, navigation, and event routing. Electron describes `WebContentsView` as the embedded option with the greatest control, but it is positioned by the main process rather than participating in the renderer DOM. A migration therefore needs a renderer-to-main bounds/layout channel. [Electron web embeds](https://www.electronjs.org/docs/latest/tutorial/web-embeds) and [`WebContentsView`](https://www.electronjs.org/docs/latest/api/web-contents-view)
2. CDP tip-of-tree changes frequently and does not guarantee backward compatibility; stable protocol 1.3 is a smaller subset. CookieMonster must treat the Electron-bundled Chromium version as the compatibility boundary and test the exact protocol commands used on every Electron upgrade. [CDP version guidance](https://chromedevtools.github.io/devtools-protocol/)

## Existing projects to reference

| Project                                                                             | What it has already solved                                                                                                                                                                                                                                                                                                                          | Direct adoption for the embedded panel                                                                                                                                                                                                                                                                                                                                                                                                                                              | Recommended use                                                                                                                                                                                                                                                                                                                                                                               |
| ----------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| [Microsoft Playwright MCP](https://github.com/microsoft/playwright-mcp)             | Accessibility snapshots and refs; reliable locator actions; tabs; history; waits; dialogs; hover; drag/drop; uploads; screenshots; console/network; storage; isolated or persistent profiles; connection to an existing browser via CDP or a Chrome extension. Its documented interaction loop is snapshot → ref-based action → refreshed snapshot. | **No, not initially.** It normally owns a Playwright browser or connects to a browser-level CDP endpoint. Playwright officially calls `connectOverCDP` lower fidelity than its native protocol, and exposing Electron's remote-debugging endpoint would broaden access beyond the one registered guest. Playwright MCP also states that it is not a security boundary. [Playwright CDP connection](https://playwright.dev/docs/api/class-browsertype#browser-type-connect-over-cdp) | Best behavioural benchmark for tool names, accessibility snapshots, waits, action completion, output bounding, and regression tests. Prototype its core only if it can attach to one adopted Electron target without weakening isolation.                                                                                                                                                     |
| [Chrome DevTools for agents](https://github.com/ChromeDevTools/chrome-devtools-mcp) | A broad CDP/Puppeteer surface: click, drag, fill, forms, dialogs, hover, upload, tabs, waits, screenshots, accessibility snapshots, console, network, Lighthouse, traces, screencasts, memory diagnostics, and extensions. It has experimental per-page routing for shared servers.                                                                 | **No for the embedded runtime.** The project officially supports Chrome and Chrome for Testing, not Electron. Its raw diagnostic surface is also much broader than normal users or agents should receive.                                                                                                                                                                                                                                                                           | Use its [tool catalogue](https://github.com/ChromeDevTools/chrome-devtools-mcp#tools) and automatic-wait behaviour as a completeness checklist. Consider it separately for an external developer/debug browser, not the signed-in embedded workspace.                                                                                                                                         |
| [Browser Use](https://github.com/browser-use/browser-use)                           | A full Python browser-agent framework, persistent sessions, direct browser actions, screenshots, profiles, CDP connection, custom tools, recordings/traces, local and hosted browsers, and a production/cloud model.                                                                                                                                | **No.** It owns browser orchestration and much of the LLM agent loop, adds a Python runtime, and would duplicate OpenCode's tool/model loop. Its hosted path also changes the data and authentication boundary.                                                                                                                                                                                                                                                                     | Reference its persistent action lifecycle, recovery, recordings, profile management, and production evaluation. Its own guidance distinguishes embedding the Python library from one-off CLI use.                                                                                                                                                                                             |
| [Stagehand](https://github.com/browserbase/stagehand)                               | TypeScript/Python browser automation combining deterministic page APIs with model-assisted `act`, `observe`, `extract`, and multi-step agents; typed extraction; candidate-action preview; local and hosted operation.                                                                                                                              | **Not wholesale.** The model-assisted methods introduce a second orchestration/model layer beside OpenCode. Its page/context abstractions assume Stagehand owns or connects to the browser environment.                                                                                                                                                                                                                                                                             | Strong library-level reference for separating `observe` from `act`, previewing safety-sensitive actions, typed extraction, compact page understanding, and caching repeatable actions. [Stagehand quickstart](https://docs.stagehand.dev/v3/first-steps/quickstart), [`observe`](https://docs.stagehand.dev/v3/basics/observe), and [`extract`](https://docs.stagehand.dev/v3/basics/extract) |

All four demonstrate that the agent-browser layer has already been built successfully in several forms. None combines CookieMonster's exact product properties: an Electron-embedded view shared live with the user, adopted from an OpenCode session, controlled through a CookieMonster plugin, and constrained by main-process policy. That integration is CookieMonster's differentiation, not a reason to replace it with a generic MCP server.

## Recommended target architecture

Keep the current boundary and deepen it:

```text
OpenCode session
  -> CookieMonster browser tools and permission prompts
    -> typed, session-scoped BrowserWorkspace operations
      -> main-process policy and audit boundary
        -> one or more main-owned WebContentsView targets
          -> Electron APIs + versioned CDP adapter
```

The important architectural change is to promote the current one-view registry into a `BrowserWorkspace` owned by a session. A workspace would own target IDs, active target, tab ancestry, navigation policy, pending operations, downloads, and an event/audit stream. Tool calls would continue to use opaque snapshot refs and stable target IDs; they would never accept raw `webContents` IDs, selectors, JavaScript, or arbitrary CDP methods.

Use an accessibility-first snapshot rather than the current selector scan. Keep screenshots as supporting evidence, not the primary action coordinate system. Map accessible nodes back to DOM/backend node identities, attach bounded geometry, and issue a new snapshot generation after any material page change. This retains stale-ref safety while covering more real-world controls, frames, and dynamic content.

Separate ordinary task tools from diagnostics:

- **Task tools:** read/snapshot, navigate/history, click, hover, scroll, fill/type, select, keys, waits, dialogs, tabs, screenshot, upload, download.
- **Diagnostic tools (opt-in):** console, request list/details, trace, performance, DOM inspection.
- **Intentionally absent from normal tools:** arbitrary JavaScript, raw cookies/storage, unrestricted local-file reads, arbitrary CDP, extension installation, password export, or unrestricted network interception.

## Phased delivery

### Phase 0 — make the existing boundary safe and deterministic

Do this before expanding the allowlist or action surface:

1. Exclude password/secret fields and values from snapshots, fingerprints, logs, errors, and permission metadata.
2. Enforce navigation policy in main across initial navigation, redirects, in-page navigation, popup creation, and the final state returned to the agent.
3. Add real cancellation/operation ownership so a timed-out action cannot finish later against a reused target.
4. Replace fixed 100 ms settling with lifecycle/DOM/action-specific waits and explicit timeout reasons.
5. Add an always-visible agent-control indicator, per-action audit entries, and user stop/takeover.
6. Add main-process security hooks for the embedded session: permission request/check handlers, `will-attach-webview` validation while `<webview>` remains, popup policy, and strict IPC sender validation. Electron's security guidance explicitly requires these controls for remote content. [Electron security checklist](https://www.electronjs.org/docs/latest/tutorial/security#checklist-security-recommendations)
7. Define a `WebContentsView` migration seam before browser behaviour becomes more coupled to the renderer `<webview>` element.

Exit criterion: the existing five tools pass adversarial tests for secrets, redirects, session crossover, detached targets, timeout cancellation, permission denial, and page-triggered navigation.

### Phase 1 — reliable single-page task browser

Add the capabilities that remove most current workflow failures:

- accessibility-first snapshots with frames and open shadow roots;
- screenshot, scroll, hover, select option, type versus replace-fill, and common pointer variants;
- explicit waits for URL, load state, text present/absent, element state, and quiet periods;
- JavaScript dialogs and file chooser handling;
- controlled uploads from explicitly approved workspace files and downloads to a managed artifact directory;
- action results that report what changed and why an action failed.

Use Playwright MCP as the acceptance-contract reference. Do not expose its `evaluate` equivalent.

### Phase 2 — session-owned browser workspace

Migrate to main-owned `WebContentsView` targets and add tabs/popups:

- stable opaque target IDs and a user-visible tab strip;
- explicit active target plus tool-level target selection;
- popup adoption only after policy evaluation;
- parent/child OpenCode session rules, avoiding implicit inheritance of a signed-in browser;
- per-target cancellation, crash recovery, history, and lifecycle state;
- user takeover that pauses the agent rather than racing it.

Use Chrome DevTools for agents' page routing as a reference, but keep routing mandatory and session-scoped rather than experimental or globally shared.

### Phase 3 — diagnostics and repeatable workflows

Add separately permissioned console/network inspection, trace capture, and structured extraction. Record action trajectories and create a focused evaluation suite for Teams, local development, authenticated research, uploads/downloads, redirects, and recovery.

Only after those evaluations should CookieMonster consider higher-level repeatable workflow primitives. Stagehand's `observe` → validate → `act` pattern is valuable here: a consequential action can be proposed, displayed to the user, approved, and then executed against the same still-valid target.

## Principal risks

### Remote content and prompt injection

Page content is untrusted input to the model. A webpage can instruct the agent to disclose data or take actions unrelated to the user's request. Host allowlists do not solve this. The tool layer needs clear provenance in snapshots, strict separation between observed content and system instructions, scoped permissions, and confirmation for external communication, purchases, deletions, credential entry, uploads, or access changes.

### Credentials and signed-in sessions

The shared authenticated session is the feature and the largest blast radius. Snapshot redaction must be structural rather than keyword-based. Cookies, authorization headers, password values, tokens, local storage, and network bodies must not enter ordinary model context. A broader diagnostic mode must be explicit, visible, and time-bounded.

### Target and session confusion

Tabs, popups, sub-agents, and concurrent actions create opportunities for the right action to hit the wrong page. Every operation needs `(OpenCode session, workspace, target, snapshot generation)` identity, and the main process must validate all four immediately before dispatch.

### Browser lifecycle and compatibility

CDP detaches when the target closes or DevTools is invoked. Electron/Chromium upgrades can change protocol behaviour, page security assumptions, and `<webview>` stability. Keep the CDP adapter small, version/capability tested, and covered by packaged-desktop smoke tests, not only unit tests.

### Tool and context growth

Large tool catalogues and full accessibility trees consume context and reduce model reliability. Playwright MCP itself now highlights smaller CLI/skill surfaces as more token-efficient for coding agents. CookieMonster should expose a compact default tool set, use bounded or searchable snapshots, and load diagnostics only when requested. [Playwright MCP](https://github.com/microsoft/playwright-mcp)

## Decision

Proceed, but name and scope it as a **shared agent browser workspace**.

The near-term investment should be Phase 0 plus a small Phase 1 tracer bullet: secure snapshots, redirect-safe/cancellable execution, accessibility state, semantic waits, screenshots, scroll/hover, and one controlled upload/download flow. That tranche proves whether the shared embedded session materially improves real CookieMonster tasks without committing to a consumer browser or a wholesale framework adoption.

The default technical choice is:

- retain CookieMonster's OpenCode plugin and main-process policy boundary;
- migrate the visual surface from `<webview>` to `WebContentsView` before deep multi-tab investment;
- implement a narrow, typed Electron/CDP adapter;
- use Playwright MCP as the behaviour/test benchmark;
- use Chrome DevTools for agents as the capability/diagnostic checklist;
- use Stagehand and Browser Use as higher-level reliability and workflow references;
- do not add a second autonomous agent loop or expose generic JavaScript/CDP access.
