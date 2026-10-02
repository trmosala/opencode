import { describe, expect } from "bun:test"
import type { Hooks } from "@opencode-ai/plugin"
import { Cause, Deferred, Effect, Exit, Fiber, Layer } from "effect"
import { runTaskScope } from "../../src/tool/task-scope"
import { testEffect } from "../lib/effect"

const it = testEffect(Layer.empty)
type Hook = NonNullable<Hooks["task.execute.scope"]>

function scope(
  hook?: Hook,
  options: {
    abort?: AbortSignal
    run?: Effect.Effect<string, Error>
    cancel?: Effect.Effect<void>
    ask?: () => Effect.Effect<void>
  } = {},
) {
  return runTaskScope({
    parentSessionID: "parent",
    childSessionID: "child",
    browserTabIDs: ["tab-1"],
    abort: options.abort ?? new AbortController().signal,
    ask: options.ask ?? (() => Effect.void),
    acquire: (input, output) =>
      Effect.promise(async () => {
        await hook?.(input, output)
      }),
    run: options.run ?? Effect.succeed("done"),
    cancel: options.cancel ?? Effect.void,
  })
}

describe("task execution scope", () => {
  it.live("acknowledges before prompt and awaits reverse-order cleanup", () =>
    Effect.gen(function* () {
      const calls: string[] = []
      const ids: string[] = []
      const hook: Hook = async (input, output) => {
        expect(input.parentSessionID).toBe("parent")
        expect(input.childSessionID).toBe("child")
        expect(input.browserTabIDs).toEqual(["tab-1"])
        expect(Object.isFrozen(input.browserTabIDs)).toBe(true)
        expect(input.executionID).toMatch(/^[a-f0-9-]{36}$/)
        ids.push(input.executionID)
        output.defer(async () => {
          calls.push("first")
        })
        output.defer(async () => {
          calls.push("second")
        })
        calls.push("grant")
        output.acknowledge()
      }
      const run = Effect.sync(() => {
        calls.push("prompt")
        return "done"
      })
      expect(yield* scope(hook, { run })).toBe("done")
      expect(calls).toEqual(["grant", "prompt", "second", "first"])
      yield* scope(hook)
      expect(ids[0]).not.toBe(ids[1])
    }),
  )

  it.live("fails closed without a hook, acknowledgement, or registered cleanup", () =>
    Effect.gen(function* () {
      const hooks: Array<Hook | undefined> = [
        undefined,
        async (_input, output) => {
          output.defer(async () => {})
        },
        async (_input, output) => {
          output.acknowledge()
        },
      ]
      for (const hook of hooks) {
        const calls: string[] = []
        const exit = yield* scope(hook, {
          run: Effect.sync(() => {
            calls.push("prompt")
            return "bad"
          }),
          cancel: Effect.sync(() => {
            calls.push("cancel")
          }),
        }).pipe(Effect.exit)
        expect(Exit.isFailure(exit)).toBe(true)
        expect(calls).toEqual(["cancel"])
      }
    }),
  )

  it.live("cleans partial acquisition and preserves all cleanup failures", () =>
    Effect.gen(function* () {
      const calls: string[] = []
      const exit = yield* scope(
        async (_input, output) => {
          output.defer(async () => {
            calls.push("first")
            throw new Error("first cleanup")
          })
          output.defer(async () => {
            calls.push("second")
            throw new Error("second cleanup")
          })
          throw new Error("grant failed")
        },
        {
          cancel: Effect.die(new Error("cancel failed")),
        },
      ).pipe(Effect.exit)
      expect(calls).toEqual(["second", "first"])
      expect(Exit.isFailure(exit)).toBe(true)
      if (Exit.isSuccess(exit)) throw new Error("expected failure")
      const errors = Cause.pretty(exit.cause)
      for (const message of ["grant failed", "first cleanup", "second cleanup", "cancel failed"]) {
        expect(errors).toContain(message)
      }
    }),
  )

  it.live("cleans on prompt failure and does not hide cleanup failure after success", () =>
    Effect.gen(function* () {
      for (const failPrompt of [true, false]) {
        const calls: string[] = []
        const exit = yield* scope(
          async (_input, output) => {
            output.defer(async () => {
              calls.push("cleanup")
              throw new Error("revoke failed")
            })
            output.acknowledge()
          },
          {
            run: failPrompt ? Effect.fail(new Error("prompt failed")) : Effect.succeed("done"),
            cancel: Effect.sync(() => {
              calls.push("cancel")
            }),
          },
        ).pipe(Effect.exit)
        expect(calls).toEqual(failPrompt ? ["cancel", "cleanup"] : ["cleanup"])
        if (Exit.isSuccess(exit)) throw new Error("expected failure")
        expect(Cause.pretty(exit.cause)).toContain("revoke failed")
        if (failPrompt) expect(Cause.pretty(exit.cause)).toContain("prompt failed")
      }
    }),
  )

  it.live("pre-abort cancels the child without acquiring or prompting", () =>
    Effect.gen(function* () {
      const calls: string[] = []
      const exit = yield* scope(
        async () => {
          calls.push("grant")
        },
        {
          abort: AbortSignal.abort(),
          run: Effect.sync(() => {
            calls.push("prompt")
            return "bad"
          }),
          cancel: Effect.sync(() => {
            calls.push("cancel")
          }),
        },
      ).pipe(Effect.exit)
      expect(Exit.hasInterrupts(exit)).toBe(true)
      expect(calls).toEqual(["cancel"])
    }),
  )

  for (const phase of ["grant", "prompt"] as const) {
    for (const mode of ["abort", "interrupt"] as const) {
      it.live(`${mode} during ${phase} cancels and revokes with the hook signal aborted`, () =>
        Effect.gen(function* () {
          const ready = Promise.withResolvers<void>()
          const controller = new AbortController()
          const calls: string[] = []
          const fiber = yield* scope(
            async (input, output) => {
              output.defer(async () => {
                expect(input.abort.aborted).toBe(true)
                calls.push("cleanup")
              })
              if (phase === "grant") {
                ready.resolve()
                await new Promise<void>((resolve) =>
                  input.abort.addEventListener("abort", () => resolve(), { once: true }),
                )
                return
              }
              output.acknowledge()
            },
            {
              abort: controller.signal,
              run: Effect.sync(() => {
                ready.resolve()
              }).pipe(Effect.andThen(Effect.never)),
              cancel: Effect.sync(() => {
                calls.push("cancel")
              }),
            },
          ).pipe(Effect.forkChild)
          yield* Effect.promise(() => ready.promise)
          if (mode === "abort") controller.abort()
          if (mode === "interrupt") yield* Fiber.interrupt(fiber)
          const exit = yield* Fiber.await(fiber)
          expect(Exit.hasInterrupts(exit)).toBe(true)
          expect(calls).toEqual(["cancel", "cleanup"])
        }),
      )
    }
  }

  it.live(
    "times out stuck cleanup and still runs remaining finalizers",
    () =>
      Effect.gen(function* () {
        const calls: string[] = []
        const exit = yield* scope(async (_input, output) => {
          output.defer(async () => {
            calls.push("remaining")
          })
          output.defer(() => new Promise<void>(() => {}))
          output.acknowledge()
        }).pipe(Effect.exit)
        expect(calls).toEqual(["remaining"])
        if (Exit.isSuccess(exit)) throw new Error("expected timeout")
        expect(Cause.pretty(exit.cause)).toContain("TimeoutError")
      }),
    30_000,
  )

  it.live("awaits cleanup before completing the scope", () =>
    Effect.gen(function* () {
      const entered = Promise.withResolvers<void>()
      const release = Promise.withResolvers<void>()
      const completed = yield* Deferred.make<void>()
      const fiber = yield* scope(async (_input, output) => {
        output.defer(async () => {
          entered.resolve()
          await release.promise
        })
        output.acknowledge()
      }).pipe(
        Effect.tap(() => Deferred.succeed(completed, undefined)),
        Effect.forkChild,
      )
      yield* Effect.promise(() => entered.promise)
      expect(yield* Deferred.isDone(completed)).toBe(false)
      release.resolve()
      expect(yield* Fiber.join(fiber)).toBe("done")
    }),
  )
})
