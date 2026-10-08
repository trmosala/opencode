import { describe, expect, test } from "bun:test"
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { Definition, epoch, next } from "../../src/schedule/definition"
import { Busy, Scheduler, State, type Adapter } from "../../src/schedule/engine"

const start = Date.parse("2026-10-08T08:00:00Z")
const definition = (schedule: unknown = { type: "interval", startsAt: "2026-10-08T08:01:00Z", everyMinutes: 1 }) => ({
  schemaVersion: 1,
  name: "Build follow-up",
  prompt: "Check the build",
  target: { type: "existing_session", sessionID: "ses_example" },
  schedule,
})

async function fixture() {
  const directory = await mkdtemp(path.join(os.tmpdir(), "cm-scheduler-"))
  const control = { now: start, signedIn: false, login: 0, executed: [] as string[], notifications: [] as string[] }
  const receipts = new Map<string, "absent" | "admitted" | "completed" | "uncertain">()
  const adapter: Adapter = {
    normalize: async (value) => ({ definition: value, directory }),
    authenticate: async () => control.signedIn,
    requestLogin: async () => {
      control.login++
    },
    reconcile: async (item) => receipts.get(item.promptID) ?? "absent",
    execute: async (item, admitted) => {
      control.executed.push(item.promptID)
      receipts.set(item.promptID, "admitted")
      await admitted()
      receipts.set(item.promptID, "completed")
      return { state: "completed", assistantID: "msg_assistant" }
    },
    notify: async (item) => {
      control.notifications.push(item.state)
    },
  }
  const file = path.join(directory, "schedules.json")
  const engine = await new Scheduler(file, adapter, () => control.now).open()
  return {
    directory,
    control,
    adapter,
    engine,
    file,
    receipts,
    cleanup: async () => {
      await engine.close()
      await rm(directory, { recursive: true, force: true })
    },
  }
}

describe("schedule validation and occurrence calculations", () => {
  test("normalizes defaults and rejects unknown fields throughout the definition", () => {
    const value = Definition.parse(definition())
    expect(value.enabled).toBe(true)
    expect(value.misfire).toEqual({ type: "catch_up_once", withinMinutes: 60 })
    expect(() => Definition.parse({ ...definition(), surprise: true })).toThrow()
    expect(() =>
      Definition.parse({
        ...definition(),
        target: { type: "existing_session", sessionID: "ses_example", permission: "allow" },
      }),
    ).toThrow()
    expect(() =>
      Definition.parse({ ...definition(), schedule: { type: "once", at: "2026-10-08T09:00:00Z", unknown: 1 } }),
    ).toThrow()
  })

  test.each([
    "2026-02-29T12:00:00Z",
    "2026-04-31T12:00:00Z",
    "2026-12-31T23:59:60Z",
    "2026-01-01T12:00:00.1234Z",
    "2026-01-01T12:00:00",
    "2026-01-01T12:00:00+24:00",
  ])("rejects invalid instant %s", (value) => {
    expect(() => epoch(value)).toThrow()
    expect(() => Definition.parse(definition({ type: "once", at: value }))).toThrow()
  })

  test.each(["0000-02-29T00:00:00Z", "2024-02-29T12:00:00.001Z", "2026-10-08T09:00:00+02:00"])(
    "accepts valid instant %s",
    (value) => {
      expect(epoch(value)).toBe(Date.parse(value))
    },
  )

  test("bounds intervals and run counters", () => {
    expect(() => Definition.parse({ ...definition(), maxRuns: 10001 })).toThrow()
    expect(() =>
      Definition.parse(definition({ type: "interval", everyMinutes: 1e300, startsAt: "2026-10-08T08:00:00Z" })),
    ).toThrow()
    expect(() => Definition.parse({ ...definition(), endsAt: "2026-10-08T08:00:00Z" })).toThrow()
    expect(() => next(Definition.parse(definition()), 8.64e15)).toThrow()
  })

  test("interval anchors survive elapsed time and offsets", () => {
    const value = Definition.parse(
      definition({ type: "interval", everyMinutes: 10, startsAt: "2026-10-08T10:00:00+02:00" }),
    )
    expect(next(value, start)).toBe(start + 10 * 60000)
    expect(next(value, start + 25 * 60000)).toBe(start + 30 * 60000)
  })

  test("calendar handles Johannesburg and rejects timezone abbreviations", () => {
    const value = Definition.parse(
      definition({ type: "calendar", timezone: "Africa/Johannesburg", time: "09:00", weekdays: ["thu"] }),
    )
    expect(next(value, Date.parse("2026-10-07T08:00:00Z"))).toBe(Date.parse("2026-10-08T07:00:00Z"))
    expect(() =>
      Definition.parse(definition({ type: "calendar", timezone: "EST", time: "09:00", weekdays: ["thu"] })),
    ).toThrow()
    expect(() =>
      Definition.parse(definition({ type: "calendar", timezone: "UTC", time: "09:00", weekdays: ["thu", "thu"] })),
    ).toThrow()
  })

  test("DST gaps are skipped and repeated times run only at their first instant", () => {
    const spring = Definition.parse(
      definition({ type: "calendar", timezone: "America/New_York", time: "02:30", weekdays: ["sun"] }),
    )
    expect(next(spring, Date.parse("2026-03-07T12:00:00Z"))).toBe(Date.parse("2026-03-15T06:30:00Z"))
    const autumn = Definition.parse(
      definition({ type: "calendar", timezone: "America/New_York", time: "01:30", weekdays: ["sun"] }),
    )
    expect(next(autumn, Date.parse("2026-10-31T12:00:00Z"))).toBe(Date.parse("2026-11-01T05:30:00Z"))
    expect(next(autumn, Date.parse("2026-11-01T05:45:00Z"))).toBe(Date.parse("2026-11-08T06:30:00Z"))
  })
})

describe("persistent scheduler", () => {
  test("retains an auth-blocked occurrence across restart and submits it exactly once", async () => {
    const context = await fixture()
    try {
      await context.engine.put(definition())
      context.control.now += 60000
      await context.engine.tick()
      const pending = (await context.engine.list()).occurrences[0]
      expect(pending.state).toBe("awaiting_auth")
      expect(context.control.login).toBe(1)
      expect(context.control.executed).toHaveLength(0)
      expect((await context.engine.list()).schedules[0].runs).toBe(0)
      context.control.now += 2 * 86400000
      await context.engine.tick()
      expect((await context.engine.list()).occurrences).toHaveLength(1)
      expect(context.control.login).toBe(1)
      await context.engine.close()
      const resumed = await new Scheduler(context.file, context.adapter, () => context.control.now).open()
      try {
        context.control.signedIn = true
        await resumed.tick()
        await resumed.tick()
        const result = await resumed.list()
        expect(result.occurrences[0].id).toBe(pending.id)
        expect(result.occurrences[0].promptID).toBe(pending.promptID)
        expect({ state: result.occurrences[0].state, detail: result.occurrences[0].detail }).toEqual({
          state: "completed",
          detail: undefined,
        })
        expect(result.schedules[0].runs).toBe(1)
        expect(context.control.executed).toEqual([pending.promptID])
      } finally {
        await resumed.close()
      }
    } finally {
      await context.cleanup()
    }
  })

  test("pause and delete prevent admission of retained auth-blocked tasks", async () => {
    const context = await fixture()
    try {
      const saved = await context.engine.put(definition())
      context.control.now += 60000
      await context.engine.tick()
      await context.engine.pause(saved.id)
      context.control.signedIn = true
      await context.engine.tick()
      expect(context.control.executed).toHaveLength(0)
      await context.engine.pause(saved.id, true)
      await context.engine.remove(saved.id)
      await context.engine.tick()
      expect(context.control.executed).toHaveLength(0)
    } finally {
      await context.cleanup()
    }
  })

  test("freezes pending prompts across definition edits", async () => {
    const context = await fixture()
    try {
      const saved = await context.engine.put(definition())
      context.control.now += 60000
      await context.engine.tick()
      await context.engine.put({ ...definition(), prompt: "Different instruction" }, saved.id)
      expect((await context.engine.list()).occurrences[0].definition.prompt).toBe("Check the build")
      context.control.signedIn = true
      await context.engine.tick()
      expect(context.control.executed).toHaveLength(1)
    } finally {
      await context.cleanup()
    }
  })

  test("busy sessions keep one pending occurrence without incrementing run count", async () => {
    const context = await fixture()
    try {
      context.control.signedIn = true
      context.adapter.execute = async () => {
        throw new Busy("busy")
      }
      await context.engine.put(definition())
      context.control.now += 60000
      await context.engine.tick()
      context.control.now += 10 * 60000
      await context.engine.tick()
      expect((await context.engine.list()).occurrences).toHaveLength(1)
      expect((await context.engine.list()).occurrences[0].state).toBe("pending")
      expect((await context.engine.list()).schedules[0].runs).toBe(0)
    } finally {
      await context.cleanup()
    }
  })

  test("catches up only the latest missed occurrence and respects maxRuns", async () => {
    const context = await fixture()
    try {
      context.control.signedIn = true
      await context.engine.put({ ...definition(), maxRuns: 1 })
      context.control.now += 10 * 60000
      await context.engine.tick()
      await context.engine.tick()
      expect((await context.engine.list()).occurrences[0].at).toBe(context.control.now)
      context.control.now += 60000
      await context.engine.tick()
      expect(context.control.executed).toHaveLength(1)
      expect((await context.engine.list()).schedules[0].next).toBeUndefined()
    } finally {
      await context.cleanup()
    }
  })

  test("skip misfires are consumed and endsAt prevents late admission", async () => {
    const context = await fixture()
    try {
      const saved = await context.engine.put({
        ...definition({ type: "once", at: "2026-10-08T08:01:00Z" }),
        misfire: { type: "skip" },
      })
      context.control.now += 120000
      await context.engine.tick()
      expect((await context.engine.list()).occurrences[0].state).toBe("skipped")
      await context.engine.tick()
      expect((await context.engine.list()).occurrences).toHaveLength(1)
      expect((await context.engine.list()).schedules.find((value) => value.id === saved.id)?.next).toBeUndefined()
    } finally {
      await context.cleanup()
    }
  })

  test("reconciles completed and ambiguous admissions durably without provider replay", async () => {
    const context = await fixture()
    try {
      await context.engine.put(definition())
      context.control.now += 60000
      await context.engine.tick()
      await context.engine.close()
      const stored = State.parse(JSON.parse(await readFile(context.file, "utf8")))
      stored.occurrences[0].state = "dispatching"
      const occurrence = stored.occurrences[0]
      context.receipts.set(occurrence.promptID, "uncertain")
      await writeFile(context.file, JSON.stringify(stored))
      const resumed = await new Scheduler(context.file, context.adapter, () => context.control.now).open()
      try {
        context.control.signedIn = true
        await resumed.tick()
        const data = await resumed.list()
        expect(data.occurrences[0].state).toBe("attention")
        expect(data.schedules[0].runs).toBe(1)
        expect(context.control.executed).toHaveLength(0)
      } finally {
        await resumed.close()
      }
      const completed = State.parse(JSON.parse(await readFile(context.file, "utf8")))
      completed.occurrences[0].state = "running"
      await writeFile(context.file, JSON.stringify(completed))
      context.receipts.set(occurrence.promptID, "completed")
      const finished = await new Scheduler(context.file, context.adapter, () => context.control.now).open()
      try {
        expect((await finished.list()).occurrences[0].state).toBe("completed")
        expect((await finished.list()).schedules[0].runs).toBe(1)
      } finally {
        await finished.close()
      }
    } finally {
      await context.cleanup()
    }
  })

  test("refuses a second live writer and rejects corrupt persistence", async () => {
    const context = await fixture()
    try {
      await expect(new Scheduler(context.file, context.adapter).open()).rejects.toThrow("already owns")
      await context.engine.close()
      await writeFile(context.file, "{broken")
      await expect(new Scheduler(context.file, context.adapter).open()).rejects.toThrow()
    } finally {
      await context.cleanup()
    }
  })

  test("a long run does not block a different schedule from becoming due", async () => {
    const context = await fixture()
    const started = Promise.withResolvers<void>()
    const finish = Promise.withResolvers<void>()
    let running: Promise<void> | undefined
    try {
      context.control.signedIn = true
      context.adapter.execute = async (item, admitted) => {
        context.control.executed.push(item.promptID)
        await admitted()
        if (item.definition.name === "Slow") {
          started.resolve()
          await finish.promise
        }
        return { state: "completed" }
      }
      await context.engine.put({ ...definition({ type: "once", at: "2026-10-08T08:01:00Z" }), name: "Slow" })
      await context.engine.put({ ...definition({ type: "once", at: "2026-10-08T08:02:00Z" }), name: "Fast" })
      context.control.now += 60000
      running = context.engine.tick()
      await started.promise
      context.control.now += 60000
      await context.engine.tick()
      expect(context.control.executed).toHaveLength(2)
      expect((await context.engine.list()).occurrences.find((value) => value.definition.name === "Fast")?.state).toBe(
        "completed",
      )
    } finally {
      finish.resolve()
      await running
      await context.cleanup()
    }
  })

  test("partial execution stays for review until explicitly acknowledged", async () => {
    const context = await fixture()
    try {
      context.control.signedIn = true
      context.adapter.execute = async (_item, admitted) => {
        await admitted()
        throw new Error("Interrupted provider")
      }
      await context.engine.put(definition())
      context.control.now += 60000
      await context.engine.tick()
      const occurrence = (await context.engine.list()).occurrences[0]
      expect(occurrence.state).toBe("attention")
      expect((await context.engine.list()).schedules[0].runs).toBe(1)
      context.control.now += 60000
      await context.engine.tick()
      expect((await context.engine.list()).occurrences).toHaveLength(1)
      await context.engine.acknowledge(occurrence.id)
      expect((await context.engine.list()).occurrences[0].state).toBe("skipped")
    } finally {
      await context.cleanup()
    }
  })

  test("endsAt prevents admission of a task held for sign-in", async () => {
    const context = await fixture()
    try {
      await context.engine.put({ ...definition(), endsAt: "2026-10-08T08:03:00Z" })
      context.control.now += 60000
      await context.engine.tick()
      expect((await context.engine.list()).occurrences[0].state).toBe("awaiting_auth")
      context.control.now += 120000
      context.control.signedIn = true
      await context.engine.tick()
      expect((await context.engine.list()).occurrences[0].state).toBe("skipped")
      expect(context.control.executed).toHaveLength(0)
    } finally {
      await context.cleanup()
    }
  })
})
