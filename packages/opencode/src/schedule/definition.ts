import z from "zod"

export const instantPattern =
  "^[0-9]{4}-(?:0[1-9]|1[0-2])-(?:0[1-9]|[12][0-9]|3[01])T(?:[01][0-9]|2[0-3]):[0-5][0-9]:[0-5][0-9](?:[.][0-9]{1,3})?(?:Z|[+-](?:[01][0-9]|2[0-3]):[0-5][0-9])$"

export function epoch(value: string) {
  if (!new RegExp(instantPattern).test(value))
    throw new Error("Expected an ISO timestamp with seconds and a UTC offset")
  const date = new Date(0)
  date.setUTCFullYear(Number(value.slice(0, 4)), Number(value.slice(5, 7)) - 1, Number(value.slice(8, 10)))
  if (date.getUTCMonth() !== Number(value.slice(5, 7)) - 1) throw new Error("Invalid calendar date")
  return requireEpoch(Date.parse(value))
}

export function requireEpoch(value: number) {
  if (!Number.isSafeInteger(value) || Math.abs(value) > 8.64e15) throw new Error("Timestamp exceeds supported range")
  return value
}

const nonBlank = z.string().regex(/\S/)
const instant = z.string().refine((value) => {
  try {
    epoch(value)
    return true
  } catch {
    return false
  }
}, "Invalid ISO timestamp")

export const Definition = z
  .object({
    schemaVersion: z.literal(1),
    name: nonBlank.max(120),
    prompt: nonBlank.max(32768),
    execution: z.literal("while_app_running").default("while_app_running"),
    enabled: z.boolean().default(true),
    target: z.discriminatedUnion("type", [
      z.object({ type: z.literal("existing_session"), sessionID: z.string().regex(/^ses/) }).strict(),
      z
        .object({
          type: z.literal("new_session"),
          directory: z.string().regex(/^(?:\/|[A-Za-z]:[\\/]|\\\\)/),
          workspace: z.discriminatedUnion("type", [
            z.object({ type: z.literal("local") }).strict(),
            z.object({ type: z.literal("worktree"), baseRef: nonBlank }).strict(),
          ]),
          agent: nonBlank.optional(),
          model: z.object({ providerID: nonBlank, id: nonBlank, variant: nonBlank.optional() }).strict().optional(),
        })
        .strict(),
    ]),
    schedule: z.discriminatedUnion("type", [
      z.object({ type: z.literal("once"), at: instant }).strict(),
      z
        .object({ type: z.literal("interval"), everyMinutes: z.number().int().min(1).max(525600), startsAt: instant })
        .strict(),
      z
        .object({
          type: z.literal("calendar"),
          timezone: nonBlank.max(128).refine((value) => {
            if (value !== "UTC" && !value.includes("/")) return false
            try {
              new Intl.DateTimeFormat("en", { timeZone: value })
              return true
            } catch {
              return false
            }
          }, "Expected an IANA timezone"),
          time: z.string().regex(/^(?:[01][0-9]|2[0-3]):[0-5][0-9]$/),
          weekdays: z
            .array(z.enum(["mon", "tue", "wed", "thu", "fri", "sat", "sun"]))
            .min(1)
            .max(7)
            .refine((value) => new Set(value).size === value.length, "Duplicate weekday"),
        })
        .strict(),
    ]),
    misfire: z
      .discriminatedUnion("type", [
        z.object({ type: z.literal("skip") }).strict(),
        z.object({ type: z.literal("catch_up_once"), withinMinutes: z.number().int().min(1).max(1440) }).strict(),
      ])
      .default({ type: "catch_up_once", withinMinutes: 60 }),
    notification: z.enum(["all_runs", "failures_only"]).default("all_runs"),
    maxRuns: z.number().int().min(1).max(10000).optional(),
    endsAt: instant.optional(),
  })
  .strict()
  .superRefine((value, ctx) => {
    if (!value.endsAt || value.schedule.type === "calendar") return
    const first = epoch(value.schedule.type === "once" ? value.schedule.at : value.schedule.startsAt)
    if (epoch(value.endsAt) <= first)
      ctx.addIssue({ code: "custom", message: "endsAt must be later than the first occurrence" })
  })

export type Definition = z.output<typeof Definition>

/** Finds the first occurrence strictly after the supplied instant. */
export function next(definition: Definition, after: number): number | undefined {
  requireEpoch(after)
  const schedule = definition.schedule
  const result = (() => {
    if (schedule.type === "once") return epoch(schedule.at) > after ? epoch(schedule.at) : undefined
    if (schedule.type === "interval") {
      const anchor = epoch(schedule.startsAt)
      return requireEpoch(
        anchor +
          Math.max(0, Math.floor((after - anchor) / (schedule.everyMinutes * 60000)) + 1) *
            schedule.everyMinutes *
            60000,
      )
    }
    const format = new Intl.DateTimeFormat("en-GB", {
      timeZone: schedule.timezone,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      hourCycle: "h23",
    })
    const local = (at: number) => Object.fromEntries(format.formatToParts(at).map((part) => [part.type, part.value]))
    const start = local(after)
    const day = new Date(0)
    day.setUTCFullYear(Number(start.year), Number(start.month) - 1, Number(start.day))
    const weekdays = ["sun", "mon", "tue", "wed", "thu", "fri", "sat"]
    // Enumerate nearby timezone offsets, then verify the actual wall time. This skips
    // nonexistent times and selects only the first instant of a repeated time.
    for (let index = 0; index < 16; index++) {
      const date = new Date(requireEpoch(day.getTime() + index * 86400000))
      if (!schedule.weekdays.some((value) => value === weekdays[date.getUTCDay()])) continue
      const wall = requireEpoch(
        date.getTime() + Number(schedule.time.slice(0, 2)) * 3600000 + Number(schedule.time.slice(3)) * 60000,
      )
      const offsets = new Set(
        [-36, -12, 0, 12, 36].map((hours) => {
          const probe = requireEpoch(wall + hours * 3600000)
          const parts = local(probe)
          const observed = new Date(0)
          observed.setUTCFullYear(Number(parts.year), Number(parts.month) - 1, Number(parts.day))
          observed.setUTCHours(Number(parts.hour), Number(parts.minute), 0, 0)
          return observed.getTime() - probe
        }),
      )
      const candidates = [...offsets]
        .map((offset) => requireEpoch(wall - offset))
        .filter((at) => {
          const parts = local(at)
          return (
            Number(parts.year) === date.getUTCFullYear() &&
            Number(parts.month) === date.getUTCMonth() + 1 &&
            Number(parts.day) === date.getUTCDate() &&
            parts.hour + ":" + parts.minute === schedule.time
          )
        })
        .sort((a, b) => a - b)
      if (candidates[0] !== undefined && candidates[0] > after) return candidates[0]
    }
    throw new Error("No calendar occurrence within the supported search window")
  })()
  return result !== undefined && (!definition.endsAt || result < epoch(definition.endsAt)) ? result : undefined
}

export function latest(definition: Definition, cursor: number, now: number) {
  if (definition.schedule.type !== "interval") {
    let value = cursor
    let following = next(definition, value)
    // Calendar catch-up only needs the last two weeks, never a historical backlog.
    if (definition.schedule.type === "calendar" && now - value > 14 * 86400000) {
      value = next(definition, now - 14 * 86400000) ?? value
      following = next(definition, value)
    }
    while (following !== undefined && following <= now) {
      value = following
      following = next(definition, value)
    }
    return { at: value, following }
  }
  const minutes = definition.schedule.everyMinutes * 60000
  const ceiling = Math.min(now, definition.endsAt ? epoch(definition.endsAt) - 1 : now)
  const at = requireEpoch(cursor + Math.max(0, Math.floor((ceiling - cursor) / minutes)) * minutes)
  return { at, following: next(definition, at) }
}
