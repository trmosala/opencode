# Issue #20: SQLite lifetime-lock feasibility

This is an isolated experiment, not a production Session authority implementation. Run `node script/sqlite-lock-probe.mjs` from the repository root. It uses disposable databases, kills only its own child processes, waits for their exit and removes scratch files. A nonzero exit preserves failed safety assertions.

## Results on 2026-09-22

macOS arm64, Bun 1.3.14 / SQLite 3.51.0 and Node v25.9.0 / SQLite 3.53.4: 128 assertions, 122 passed and 6 failed. The earlier probe had 84 assertions and 2 failures. The additional cases test existing-file-only opening and unrelated descriptor closure while a transaction remains active.

| Case                                                                                   | Result                                                  |
| -------------------------------------------------------------------------------------- | ------------------------------------------------------- |
| Bun `{ readwrite: true, create: false }` on a missing path                             | Refused; no file created                                |
| Node file URI with `mode=rw` on a missing path                                         | Refused; no file created                                |
| Both existing-file-only openers against a live owner                                   | Contention reported                                     |
| Both existing-file-only openers after owned kill/exit                                  | Acquired                                                |
| Default opening of missing paths                                                       | Both runtimes created and acquired: 2 retained failures |
| Node owner, DELETE mode, unrelated open/close of the main database file in its process | Both external runtimes acquired: 2 new failures         |
| Node owner, WAL mode, unrelated open/close of the `-shm` file in its process           | Both external runtimes acquired: 2 new failures         |
| Bun owner under the tested descriptor-close cases                                      | External contenders remained blocked                    |

The owner still reported an active SQLite transaction immediately after each unrelated close. It had not committed, rolled back, closed its SQLite connection or exited. Transaction status therefore does not establish continued exclusion. This reproduces SQLite's documented [process-wide POSIX lock caveat](https://www.sqlite.org/howtocorrupt.html#_posix_advisory_locks_canceled_by_a_separate_thread_doing_close_). WAL changes which file carries the relevant locks; switching journal mode alone did not eliminate the demonstrated hazard.

The existing-file-only modes address the demonstrated default-create problem. They do not solve replacement/alias races or guarantee namespace/Session identity. The experiment's constant `probe` identity is intentionally not a production identity protocol.

## Consequences for task recovery

Do not activate the current candidate as Session execution authority. A design must prevent the demonstrated descriptor interference or isolate the lock holder, then test ownership loss and teardown. A dedicated holder process is a candidate to investigate, not an accepted solution: parent death, orphan prevention, pipe inheritance, acknowledgement, fencing and shutdown ordering would all need coverage.

Remaining tests include bundled Electron Node, Windows/Linux, hard-link/raw aliases, independently loaded SQLite libraries, provisioning/replacement races, long-duration behavior and the complete publication/admission/reconciliation integration. SIGSTOP is requested by the existing probe but stopped process state is not independently witnessed. Busy classification still uses error text. Passing Bun cases are limited evidence, not a general immunity claim.

The issue also leaves storage activation unresolved: a separate explicitly upgraded database namespace versus a coordinated upgrade of every writer. Old versions cannot be assumed to honor new ownership metadata. No existing storage has been migrated or activated, no transcript has been settled, and no tool/provider/publication has been replayed.

## Browser recovery validation

The independent `bun scripts/browser-smoke.ts --recovery` fixture passed from `packages/desktop` on macOS arm64 / Electron 44.3.0 / Chromium 152.0.7977.78. It killed its owned seed process and relaunched the disposable profile, verifying navigation history, selected index, Back/Forward, recently closed history, fresh private tab IDs, a locked vault, absent form/history state and zero POST requests. Failed restoration, redirects, HTTP 204, Stop, stale callbacks and malformed-store preservation passed. `bun test src/main/browser/tab-recovery.test.ts` passed 1 test / 26 expectations.

These results validate the browser slice only. Issue #20 remains open for interrupted-task ownership, settlement-only recovery, explicit continuation and the other documented integration gates.
