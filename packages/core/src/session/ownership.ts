export * as SessionOwnership from "./ownership"

import { realpath } from "node:fs/promises"
import { dirname, join } from "node:path"
import { Effect } from "effect"
import { Flock } from "../util/flock"

/** Local file-backed databases share exclusion across V1/V2 backends for the full provider/tool drain. */
export function withLock<A, E, R>(work: Effect.Effect<A, E, R>, sessionID: string, filename?: string) {
  if (!filename || filename === ":memory:") return work
  return Effect.scoped(
    Effect.gen(function* () {
      const file = yield* Effect.promise(() => realpath(filename))
      yield* Effect.acquireRelease(
        Effect.promise((signal) =>
          Flock.acquire(JSON.stringify([process.platform === "win32" ? file.toLowerCase() : file, sessionID]), {
            dir: join(dirname(file), ".opencode-session-locks"),
            signal,
            protectLiveOwner: true,
          }),
        ),
        (lease) => Effect.promise(() => lease.release()),
        { interruptible: true },
      )
      return yield* work
    }),
  )
}
