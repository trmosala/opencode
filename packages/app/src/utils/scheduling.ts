import { Schema } from "effect"
import type { ServerConnection } from "@/context/server"
import { authTokenFromCredentials } from "./server"

const Model = Schema.Struct({ providerID: Schema.String, id: Schema.String, variant: Schema.optional(Schema.String) })
const Definition = Schema.Struct({
  schemaVersion: Schema.Literal(1),
  name: Schema.String,
  prompt: Schema.String,
  execution: Schema.Literal("while_app_running"),
  enabled: Schema.Boolean,
  target: Schema.Union([
    Schema.Struct({ type: Schema.Literal("existing_session"), sessionID: Schema.String }),
    Schema.Struct({
      type: Schema.Literal("new_session"),
      directory: Schema.String,
      workspace: Schema.Union([
        Schema.Struct({ type: Schema.Literal("local") }),
        Schema.Struct({ type: Schema.Literal("worktree"), baseRef: Schema.String }),
      ]),
      agent: Schema.optional(Schema.String),
      model: Schema.optional(Model),
    }),
  ]),
  schedule: Schema.Union([
    Schema.Struct({ type: Schema.Literal("once"), at: Schema.String }),
    Schema.Struct({ type: Schema.Literal("interval"), everyMinutes: Schema.Number, startsAt: Schema.String }),
    Schema.Struct({
      type: Schema.Literal("calendar"),
      timezone: Schema.String,
      time: Schema.String,
      weekdays: Schema.Array(Schema.Literals(["mon", "tue", "wed", "thu", "fri", "sat", "sun"])),
    }),
  ]),
  misfire: Schema.Union([
    Schema.Struct({ type: Schema.Literal("skip") }),
    Schema.Struct({ type: Schema.Literal("catch_up_once"), withinMinutes: Schema.Number }),
  ]),
  notification: Schema.Literals(["all_runs", "failures_only"]),
  maxRuns: Schema.optional(Schema.Number),
  endsAt: Schema.optional(Schema.String),
})

const Saved = Schema.Struct({
  id: Schema.String,
  revision: Schema.Number,
  definition: Definition,
  directory: Schema.String,
  next: Schema.optional(Schema.Number),
  runs: Schema.Number,
  deleted: Schema.Boolean,
})
const Occurrence = Schema.Struct({
  id: Schema.String,
  scheduleID: Schema.String,
  at: Schema.Number,
  definition: Definition,
  sessionID: Schema.String,
  directory: Schema.optional(Schema.String),
  admitted: Schema.Boolean,
  state: Schema.Literals(["pending", "awaiting_auth", "dispatching", "running", "completed", "attention", "skipped"]),
  detail: Schema.optional(Schema.String),
})
const State = Schema.Struct({
  schedules: Schema.Array(Saved),
  occurrences: Schema.Array(Occurrence),
  totalOccurrences: Schema.Number,
})

export type ScheduleDefinition = typeof Definition.Type
export type ScheduledTask = typeof Saved.Type
export type ScheduledRun = typeof Occurrence.Type

export class SchedulingError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message)
  }
}

export function createSchedulingClient(
  server: ServerConnection.HttpBase,
  fetcher: (input: RequestInfo | URL, init?: RequestInit) => Promise<Response> = fetch,
) {
  const request = async (body?: {
    action: "create" | "update" | "pause" | "resume" | "delete" | "acknowledge"
    id?: string
    definition?: ScheduleDefinition
  }) => {
    const response = await fetcher(new URL("schedule", server.url.replace(/\/?$/, "/")), {
      method: body ? "POST" : "GET",
      headers: {
        ...(body ? { "Content-Type": "application/json" } : {}),
        ...(server.password
          ? {
              Authorization: `Basic ${authTokenFromCredentials({ username: server.username, password: server.password })}`,
            }
          : {}),
      },
      ...(body ? { body: JSON.stringify(body) } : {}),
    })
    const data: unknown = await response.json().catch(() => undefined)
    if (!response.ok) {
      const detail = data && typeof data === "object" && "data" in data ? data.data : data
      const message =
        detail && typeof detail === "object" && "message" in detail && typeof detail.message === "string"
          ? detail.message
          : response.statusText
      throw new SchedulingError(response.status, message)
    }
    return data
  }
  return {
    list: async () => Schema.decodeUnknownSync(State)(await request()),
    manage: (body: NonNullable<Parameters<typeof request>[0]>) => request(body),
  }
}

export const weekdays = ["mon", "tue", "wed", "thu", "fri", "sat", "sun"] as const

export function localDateTime(instant: number) {
  const date = new Date(instant)
  return new Date(instant - date.getTimezoneOffset() * 60000).toISOString().slice(0, 16)
}

export function scheduleInstant(value: string, original?: string) {
  if (original && localDateTime(Date.parse(original)) === value) return original
  return new Date(value).toISOString()
}
