import { randomUUID } from "node:crypto"
import type { Hooks } from "@opencode-ai/plugin"
import { Cause, Effect, Exit } from "effect"
import { EffectBridge } from "@/effect/bridge"
import type { Tool } from "./tool"

type Hook = NonNullable<Hooks["task.execute.scope"]>

export function runTaskScope<A, E, R>(options: {
  parentSessionID: string
  childSessionID: string
  browserTabIDs: readonly string[]
  abort: AbortSignal
  ask: Tool.Context["ask"]
  acquire: (input: Parameters<Hook>[0], output: Parameters<Hook>[1]) => Effect.Effect<unknown>
  run: Effect.Effect<A, E, R>
  cancel: Effect.Effect<void>
}) {
  return Effect.gen(function* () {
    const bridge = yield* EffectBridge.make()
    return yield* Effect.acquireUseRelease(
      Effect.sync(() => ({
        executionID: randomUUID(),
        controller: new AbortController(),
        finalizers: [] as Array<() => Promise<void>>,
        acknowledged: false,
        closed: false,
      })),
      (state) => {
        const abort = AbortSignal.any([options.abort, state.controller.signal])
        return Effect.gen(function* () {
          if (abort.aborted) return yield* Effect.interrupt
          yield* options.acquire(
            {
              executionID: state.executionID,
              parentSessionID: options.parentSessionID,
              childSessionID: options.childSessionID,
              browserTabIDs: Object.freeze([...options.browserTabIDs]),
              abort,
              ask: (permission) => bridge.promise(options.ask(permission).pipe(Effect.raceFirst(interrupted(abort)))),
            },
            {
              defer(cleanup) {
                if (state.closed) throw new Error("Task scope already closed")
                state.finalizers.push(cleanup)
              },
              acknowledge() {
                if (state.closed || abort.aborted) throw new Error("Task scope already closed")
                if (!state.finalizers.length) throw new Error("Task scope requires cleanup before acknowledgement")
                state.acknowledged = true
              },
            },
          )
          if (abort.aborted) return yield* Effect.interrupt
          if (!state.acknowledged) {
            return yield* Effect.die(new Error("Browser task scope was not acknowledged by a plugin"))
          }
          return yield* options.run
        }).pipe(Effect.raceFirst(interrupted(abort)))
      },
      (state, exit) =>
        Effect.gen(function* () {
          state.closed = true
          state.controller.abort()
          // Collect exits so a failed cancellation or finalizer cannot skip the others.
          const cancelled = yield* (Exit.isFailure(exit) ? options.cancel : Effect.void).pipe(
            Effect.timeout("20 seconds"),
            Effect.exit,
          )
          const cleaned = yield* Effect.forEach([...state.finalizers].reverse(), (cleanup) =>
            Effect.promise(cleanup).pipe(Effect.timeout("20 seconds"), Effect.exit),
          )
          const failures = [cancelled, ...cleaned].filter(Exit.isFailure)
          if (failures.length) {
            yield* Effect.failCause(
              failures.reduce<Cause.Cause<E | Cause.TimeoutError>>(
                (cause, failure) => Cause.combine(cause, failure.cause),
                Exit.isFailure(exit) ? exit.cause : Cause.empty,
              ),
            )
          }
        }),
    )
  })
}

function interrupted(signal: AbortSignal) {
  return Effect.callback<never>((resume) => {
    const abort = () => resume(Effect.interrupt)
    signal.addEventListener("abort", abort, { once: true })
    if (signal.aborted) abort()
    return Effect.sync(() => signal.removeEventListener("abort", abort))
  })
}
