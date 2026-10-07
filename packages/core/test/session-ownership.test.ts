import { expect, test } from "bun:test"
import { join } from "node:path"
import { Deferred, Effect, Exit, Fiber } from "effect"
import { tmpdir } from "./fixture/tmpdir"
import { SessionOwnership } from "../src/session/ownership"
import { SessionRunCoordinator } from "../src/session/run-coordinator"

test("full runs serialize competing owners, coalesce resumes and allow different sessions", async () => {
  await using tmp = await tmpdir()
  const filename = join(tmp.path, "sessions.db")
  await Bun.write(filename, "")
  await Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        const entered = yield* Deferred.make<void>()
        const release = yield* Deferred.make<void>()
        const calls: string[] = []
        const first = yield* SessionRunCoordinator.make<string, never>({
          drain: (id) =>
            SessionOwnership.withLock(
              Effect.gen(function* () {
                calls.push(`first:${id}`)
                yield* Deferred.succeed(entered, undefined)
                yield* Deferred.await(release)
              }),
              id,
              filename,
            ),
        })
        const second = yield* SessionRunCoordinator.make<string, never>({
          drain: (id) =>
            SessionOwnership.withLock(
              Effect.sync(() => {
                calls.push(`second:${id}`)
              }),
              id,
              filename,
            ),
        })
        const owner = yield* Effect.forkChild(first.run("same"))
        yield* Deferred.await(entered)
        const joined = yield* Effect.forkChild(first.run("same"))
        const waiting = yield* Effect.forkChild(second.run("same"))
        yield* second.run("other")
        expect(calls).toEqual(["first:same", "second:other"])
        yield* Deferred.succeed(release, undefined)
        yield* Fiber.join(owner)
        yield* Fiber.join(joined)
        yield* Fiber.join(waiting)
        expect(calls).toEqual(["first:same", "second:other", "second:same"])
      }),
    ),
  )
})

test("interruption, waiting cancellation and failure release ownership", async () => {
  await using tmp = await tmpdir()
  const filename = join(tmp.path, "sessions.db")
  await Bun.write(filename, "")
  await Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        const entered = yield* Deferred.make<void>()
        const owner = yield* Effect.forkChild(
          SessionOwnership.withLock(
            Deferred.succeed(entered, undefined).pipe(Effect.andThen(Effect.never)),
            "same",
            filename,
          ),
        )
        yield* Deferred.await(entered)
        const waiting = yield* Effect.forkChild(SessionOwnership.withLock(Effect.void, "same", filename))
        yield* Effect.sleep("20 millis")
        yield* Fiber.interrupt(waiting)
        yield* Fiber.interrupt(owner)
        const failed = yield* Effect.exit(SessionOwnership.withLock(Effect.fail("failure"), "same", filename))
        expect(Exit.isFailure(failed)).toBe(true)
        yield* SessionOwnership.withLock(Effect.void, "same", filename)
      }),
    ),
  )
})

test("independent processes cannot execute the same saved session concurrently", async () => {
  await using tmp = await tmpdir()
  const filename = join(tmp.path, "sessions.db")
  await Bun.write(filename, "")
  const fixture = join(import.meta.dir, "fixture", "session-owner.ts")
  const first = Bun.spawn([process.execPath, fixture, filename, "same", "hold"], {
    stdin: "pipe",
    stdout: "pipe",
    stderr: "pipe",
  })
  const reader = first.stdout.getReader()
  let received = ""
  while (!received.includes("owned")) {
    const chunk = await reader.read()
    if (chunk.done) throw new Error("First process exited without ownership")
    received += new TextDecoder().decode(chunk.value)
  }
  const second = Bun.spawn([process.execPath, fixture, filename, "same"], { stdout: "pipe", stderr: "pipe" })
  try {
    const contender = second.stdout.getReader()
    const announced = await contender.read()
    expect(new TextDecoder().decode(announced.value)).toContain("waiting")
    expect(second.exitCode).toBeNull()
    const pending = contender.read()
    expect(await Promise.race([pending.then(() => true), Bun.sleep(100).then(() => false)])).toBe(false)
    first.stdin.end()
    expect(await first.exited).toBe(0)
    const acquired = await pending
    expect(new TextDecoder().decode(acquired.value)).toContain("owned")
    expect(await second.exited).toBe(0)
  } finally {
    first.kill()
    second.kill()
  }
})
