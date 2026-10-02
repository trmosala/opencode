# Agent Access must cover the entire browser tab

Date: 2026-10-02
Status: Diagnosis and product requirement for the agent handling browser gaps. No implementation changes made for this handoff.

## User requirement

The user explicitly requested:

> Agent Access should give it the entire the entire tab, nothing gated or restricted.

Treat the Agent Access toggle as authorization to read and operate the entire selected tab, including embedded documents and cross-origin content. Do not require separate frame approvals, receiving-origin approvals, or screenshot approvals within that authorized tab. Do not silently omit content because it is embedded, nested, sandboxed, clipped, transformed, or hosted on another origin.

Implement this as a coherent tab-level access contract across browser tools and the main-process enforcement layer. Include iframe content, shadow DOM, screenshots, and interactions with embedded controls. The user expects the agent to work with the same page they can see and operate.

Preserve tab identity, revocation, and checks that prevent acting on the wrong or stale target. Those checks should support reliable operation without introducing additional permission gates inside a tab that has Agent Access enabled. Do not infer authorization for other tabs from access to this tab.

## Confirmed failure

In the CookieMonster dev session `Lets try and do my time`, the user authorized the Teams and WorkBook tabs and asked the agent to use calendar events for the week of 28 September through 4 October 2026.

The agent could read the WorkBook timesheet rows. After clicking Calendar in Teams, it repeatedly read only the Teams navigation/header and asked the user to open the calendar manually.

The recorded `browser_click` error was:

```text
Browser operation interrupted or unavailable. (unavailable)
```

Four subsequent Teams reads returned the shell without calendar events. The returned list of eligible direct frames was empty. These reads were not truncated.

Live inspection through Windows accessibility and a screenshot confirmed that the correct calendar week was already open. Outlook reported 26 loaded events. Its document was embedded in Teams:

- Top document: `https://teams.cloud.microsoft/`
- Embedded calendar: `https://outlook.office.com/hosted/calendar/view/week`
- Accessibility owner ID: `cacheable-iframe:5966c135-e05f-4ce0-81e0-e138fe8e9583`

This establishes a gap between the visible page and the content exposed to the agent. It is not evidence that the calendar failed to load or that a different model would solve the problem.

## Relevant implementation

The running dev instance comes from `D:/Workarea/CookieMonster/teams-login`, branch `teams-login`. That worktree contains the separate long Microsoft login redirect fix. The main checkout is `D:/Workarea/CookieMonster/opencode`, where another agent has ongoing browser changes. Coordinate with that work before editing.

Relevant repository paths:

- `packages/desktop/src/main/browser/snapshot.ts`: the DOM walker explicitly ignores `iframe`, `object`, and `embed`. Top-document reads cannot include the embedded Outlook calendar.
- `packages/desktop/src/main/browser/frames.ts`: frame discovery accepts only narrowly eligible direct HTTP(S) frames. It rejects sandbox/srcdoc frames and several geometry, containment, clipping, overlap, and ancestry conditions. Nested frames are excluded. Child reads require separate authority.
- `packages/cm-browser/src/tools.ts`: `browser_read_state` describes separate approval for the exact top and receiving origins. Child interactions are limited to separately approved native single-select operations. Screenshot access also has separate approval and native consent.
- `packages/desktop/src/main/browser/router.ts`: dispatch, authority checks, follow-up reads, and frame discovery. Multiple exceptions collapse into the same generic `unavailable` response.
- `packages/desktop/src/main/browser/driver.ts`: click dispatch followed by settling and a refreshed page snapshot.
- `packages/desktop/src/main/browser/registry.ts` and `tabs.ts`: tab consent, ownership, lifecycle, and revocation.

The exact frame eligibility condition that excluded this Outlook document has not been isolated. The tool trace exposes no exclusion reason. The click error also does not establish whether dispatch failed or a later check/read failed. Calendar was open when inspected afterward.

## Required behavior and validation

1. With Agent Access enabled on the Teams tab, a read exposes the embedded Outlook calendar and its events without another approval prompt. Include enough frame identity to route subsequent interactions correctly.
2. The agent can operate calendar navigation, event controls, scrolling, and embedded inputs through the same tab authorization. Cover nested and cross-origin documents rather than adding a Teams-only bypass.
3. Screenshots and other browser observation tools follow the same tab-level authorization. Avoid a separate permission sequence for each way of observing the authorized tab.
4. Report action dispatch and follow-up observation separately when an action takes effect but the returned snapshot fails. Give the agent a recovery path that does not blindly repeat an action that may already have happened.
5. Make snapshot omissions and failures diagnosable. An empty frame list must not imply that the page has no embedded content when discovery excluded it.
6. Verify revocation stops access, stale refs cannot target replacement content, and a tab's authorization does not grant access to unrelated tabs.
7. Validate against the actual authenticated Teams calendar in the dev instance, plus fixtures for embedded/nested content and page transitions. Confirm that the calendar events visible to the user are also available to the agent.

Do not enter or submit timesheets as part of validating this browser fix. The current request is to document and fix browser access behavior.

## Evidence location

The local dev transcript is in the read-only inspected database:

```text
C:/Users/TiisetsoMosala/.local/share/opencode/opencode-dev.db
session: ses_f03def34dffecENXJGaB4fMoU7
Teams tab: ecefda6d-5b29-498b-b8ce-a5fe59ccf7b2
WorkBook tab: d77b32b9-be47-4732-a298-0df9a6039307
```

The `part` table stores tool state as JSON in `data`. Inspect only the relevant browser tool calls; the session also contains private chat/calendar information that is unnecessary for this diagnosis.
