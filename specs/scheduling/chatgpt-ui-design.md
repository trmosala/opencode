# Scheduling side panel — CM3

Status: **implemented locally**. `chatgpt-ui-design.html` remains the original sample-data design reference; the production UI is integrated into CM3.

## Placement and ownership

Scheduling is a **420 px right-side panel**, not a dashboard or primary page. Keep the CM3 left sidebar (New task, Scheduled, Projects) and the active conversation and composer visible when it opens. Scheduled opens the panel; close restores the conversation and its unsent draft. `/scheduled` remains a fallback/deep link, not the primary CM3 experience.

`packages/app/src/components/scheduling-panel.tsx` owns the scheduling client, server-scoped cache, list, detail, inline editor, history, loading and errors, unsaved drafts, focus and cleanup. It exports `SchedulingProvider`, `SchedulingPanel`, `useScheduling` and an optional hook for session hosts. The host calls the module and coordinates the right region.

The provider sits inside the shared command context in `app.tsx`. `layout-new.tsx` mounts the panel beside route content; the sidebar and palette call `open()` without navigation. It works on home, draft and session views. The CM3 `/scheduled` deep link opens the panel on home; the legacy interface retains its existing Scheduling page. While Scheduling is open, the review/files/browser panel and its header tabs remain mounted but hidden and inert. Closing restores the previous selection and invoking focus. Narrow screens use a side sheet.

## Panel flow

Header: Scheduling, New task, Close. Tasks and Run history tabs. Tasks show name, cadence, next run and text status; select a row for full detail with Back, Edit, Pause/Resume and Delete. Detail includes instructions, project, timing and recent run outcomes. History shows run status, date, and an Open conversation action when available. Provide inline loading, empty, unavailable and retry/error states without removing cached content.

New and Edit replace panel content with an **inline editor**, never a centered modal or full-page manager. Cancel/Back returns to the prior panel view. Fields: name, instructions, project; once, interval, or weekdays with time and timezone; notifications; collapsed Advanced containing local/worktree and model. Validate in place, preserve an unsaved scheduling draft on navigation or close, and ask before discarding dirty changes. State: “Tasks run while CookieMonster is open.”

## Data and interaction

The existing `/schedule` API and schema are reused. `createSchedulingClient` accepts optional cancellation signals. Server selection follows the active session, draft tab or home project. Server changes cancel requests and ignore stale results. Polling runs every ten seconds only while the panel and document are visible, stopping on close or unmount. Cached data stays visible on refresh failure. Closing or changing server preserves each server's draft; cancelling a dirty editor or deleting a task requires explicit confirmation. Editing preserves schema fields that are not exposed by the form, including model variant and precise timestamps. Focus moves into the panel after palette dismissal. Escape closes it without interrupting the conversation.

## Validation

Nine production Chrome integration tests passed: deep-link opening, retained composer/review state, inline draft and failed-save recovery, task/run actions, cached errors and polling cleanup, command-palette focus/Escape, discard/delete confirmation, schema preservation, and server isolation with stale responses. App and E2E typechecks, three scheduling client tests, production build, scoped module lint and diff checks passed.

The required production navigation benchmark passed before and after session integration. Composer first/stable timings changed from 119.3/130.8 ms to 134.2/153.1 ms; selected-session first/stable timings changed from 165.2/200.7 ms to 184.6/226.0 ms. These are single samples and do not establish a sustained performance regression.

Integration tests use a mock scheduling backend. Native Electron panel restoration, live WPP authentication recovery and scheduled model dispatch have not been verified here. No packaging, release, merge or changes to the separate issue #70 runtime work were performed.
