# Scheduling contract

[schedule.schema.json](./schedule.schema.json) defines the parameters a model writes and the local scheduler reads. The desktop sidecar implements this contract in `packages/opencode/src/schedule`, with the `schedule` tool as its management interface. It starts with the desktop's local server and stops with it. It does not run while the app is closed.

The model must supply `schemaVersion`, `name`, `prompt`, `target` and `schedule`. Optional settings control pausing, missed occurrences, notifications and limits. Unknown fields are rejected at every object level.

| Parameter                        | Meaning                                                                                                   |
| -------------------------------- | --------------------------------------------------------------------------------------------------------- |
| `target.type = existing_session` | Queue each occurrence in a resolved existing session with its current context, location, agent and model. |
| `target.type = new_session`      | Create an independent session per occurrence in the specified local directory or a fresh Git worktree.    |
| `schedule.type = once`           | Run at one timestamp with an explicit UTC offset.                                                         |
| `schedule.type = interval`       | Run at a fixed interval from a persistent timestamp anchor.                                               |
| `schedule.type = calendar`       | Run at a local time on selected weekdays in an IANA timezone.                                             |
| `enabled`                        | Admit future occurrences when true.                                                                       |
| `misfire`                        | Skip missed occurrences or catch up only the latest within a bounded window.                              |
| `notification`                   | Notify for all runs or only failures and requests for attention.                                          |
| `maxRuns`                        | Limit occurrences that successfully admit a prompt, including ones whose execution later fails.           |
| `endsAt`                         | Stop admitting prompts at this instant. Existing admitted prompts remain intact.                          |

## Validation and normalization

Use a JSON Schema Draft 2020-12 validator with `date-time` format assertion enabled. JSON Schema defaults are annotations: validation alone does not insert them. After validating a create request, the scheduler applies these defaults once and persists the normalized definition:

- `execution`: `while_app_running`
- `enabled`: `true`
- `misfire`: `{ "type": "catch_up_once", "withinMinutes": 60 }`
- `notification`: `all_runs`
- For new sessions, omitted `agent` and `model` resolve to the selected/default values at save time.

The scheduler also validates facts that JSON Schema cannot establish. Resolve the target session on the owning local server; validate timezone IDs, directory availability, Git refs and repositories, and explicit model/agent availability. Retain the existing session ID validator's `ses` prefix compatibility; a matching string alone does not establish that a session exists. Use filesystem and Git APIs or argument arrays for paths and refs, never shell interpolation.

A new one-time schedule must point to a future instant. If provided, `endsAt` must be later than `once.at` or `interval.startsAt`; a calendar definition must have a future occurrence before it. On a later update, preserve consumed occurrences and the run count, and calculate the next eligible occurrence under the new definition. On resume, apply the saved misfire policy, subject to `endsAt` and `maxRuns`. Paused time does not move an interval's anchor.

Calendar weekdays and times belong to the specified timezone. Skip nonexistent wall-clock times during DST transitions. If a time repeats, use its first instant and record only one occurrence. Interval schedules use elapsed minutes and do not change with DST. Calendar creation starts with the next occurrence after save time; it does not synthesize historical runs.

## Scheduler-owned records and execution

Keep the schedule ID, revision, creation/update times, next occurrence, run count and lifecycle status outside the model-authored definition. A normalized definition is read-only to execution; updates go through the schedule management interface, validate again and increment the revision. Pause/delete takes effect before the next prompt admission. Completion of a one-time schedule or exhaustion of a limit is scheduler-owned status, independent of `enabled`.

For each due occurrence, persist a record with a unique `(scheduleID, scheduledAt)` key, a snapshot of the definition/revision, and stable session and prompt IDs before admission. A new-session occurrence reuses its saved session ID on admission retry. Atomically claim due occurrences and reserve run-limit capacity. An exact admission retry uses the same prompt, delivery mode and message ID; never replace an existing occurrence's payload after editing a schedule.

Allow only one unfinished occurrence per schedule, including queued work and work awaiting sign-in or approval. Mark later due occurrences skipped while it is unfinished; do not build a backlog. For missed time after startup, resume or wake from sleep, apply `misfire` before dispatch, and advance the cursor across skipped occurrences. A skipped or admitted one-time occurrence is consumed permanently.

The current desktop uses the legacy prompt runner. Its scheduler owns the persistent waiting queue and claims an idle session runner before admitting a prompt. It retains the session's current agent and model, and does not steer an active turn. A V2 implementation must instead use `delivery: "queue"` and the durable Session input path. New-session occurrences capture the calling session's selected agent and model when saved, and use a fresh session with ordinary permissions on each run. Prompt admission is counted separately from completion. A successful run requires a completed assistant response with `finish: "stop"` whose parent is the occurrence's exact prompt ID. Interruption, provider failure, truncation, or steering to another prompt requires attention.

After a restart, reconcile saved session and prompt IDs against durable messages. Retry only a record with no admitted prompt. A completed matching assistant receipt reconciles completion without replay. Any admitted but unfinished or uncertain execution requires attention. The legacy implementation conservatively does not re-wake admitted prompts after restart. It does not change V2 drain or provider recovery behavior.

Execution retains normal session permissions and browser grants. Expired WPP authentication or a request for approval becomes a visible need for attention. The schedule cannot grant access, change permissions, bypass sign-in or automatically retry a partially executed task.

WPP schedules check the bridge's live sign-in status before admission. Missing or inconclusive authentication retains the occurrence in `awaiting_auth` and opens the existing sign-in window once. A confirmed sign-in allows the same saved occurrence to run on a later tick, even if its original catch-up window has passed. Explicit pause, deletion or `endsAt` still prevents admission. An authentication failure after execution begins requires review rather than automatic replay.

The store is `<data>/scheduling/schedules.json`, saved through a synced temporary file and atomic replacement. A process lock prevents concurrent writers. An unreadable or corrupt store prevents scheduler startup without overwriting saved work. Worktrees use persisted occurrence ownership, a resolved commit and a deterministic path under `<data>/scheduled-worktrees`. They are retained, with a maximum of 100 retained worktrees; cleanup is manual. No source files or generated artifacts are automatically deleted.

The `schedule` tool supports `create`, `list`, `update`, `pause`, `resume`, `delete` and `acknowledge`. Create/update validates the complete definition. List returns schedules and the most recent 100 occurrences; complete history stays on disk. Acknowledge takes an occurrence ID requiring attention and releases it after review without replaying it. Management writes require the normal `schedule` permission. Sign-in and execution failures use the existing session notification and WPP sign-in controls; completed runs use the runner's ordinary notifications.

Conditional stop instructions belong to the prompt. The model must call an explicit schedule management tool to pause the schedule; prose such as "the build finished" is not itself a scheduler command. The dispatch context supplies the scheduler-owned schedule ID for that tool. `maxRuns` and `endsAt` provide deterministic limits even if the model does not stop itself.

## Examples

- [Build follow-up](./examples/build-follow-up.json): the same chat every ten minutes, capped at twelve admitted occurrences.
- [Weekday review](./examples/weekday-review.json): a new session and worktree at 09:00 Johannesburg time on weekdays.
- [One-time reminder](./examples/one-time-reminder.json): return to an existing chat at a specified instant.

Example session IDs and dates are placeholders. Replace IDs with resolved sessions and timestamps with the user's intended future dates before saving. A worktree `baseRef` uses the locally available ref at dispatch; fetching it is a separate operation.
