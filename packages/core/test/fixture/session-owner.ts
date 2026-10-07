import { Effect } from "effect"
import { SessionOwnership } from "../../src/session/ownership"

console.log("waiting")
await Effect.runPromise(
  SessionOwnership.withLock(
    Effect.gen(function* () {
      console.log("owned")
      if (process.argv[4] === "hold") yield* Effect.promise(() => Bun.stdin.text())
    }),
    process.argv[3],
    process.argv[2],
  ),
)
