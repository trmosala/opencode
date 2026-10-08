import { Effect, Schema } from "effect"
import { HttpApiBuilder } from "effect/unstable/httpapi"
import type { Scheduler } from "@/schedule/engine"
import { InvalidRequestError, ServiceUnavailableError } from "../errors"
import { ScheduleApi } from "../groups/schedule"

// Resolve the process-owned scheduler at request time. HTTP requests never start
// another scheduler or acquire a second store lock.
export function scheduleHandlersFor(load: () => Promise<Scheduler>) {
  const scheduler = () =>
    Effect.tryPromise({
      try: load,
      catch: () =>
        new ServiceUnavailableError({
          message: "Scheduling is unavailable. Open CookieMonster desktop to manage scheduled tasks.",
          service: "scheduling",
        }),
    })
  return HttpApiBuilder.group(ScheduleApi, "schedule", (handlers) =>
    handlers
      .handle("list", () =>
        Effect.gen(function* () {
          const service = yield* scheduler()
          const state = yield* Effect.promise(() => service.list())
          return {
            ...state,
            schedules: state.schedules.map(json),
            occurrences: state.occurrences.slice(-100).map(json),
            totalOccurrences: state.occurrences.length,
          }
        }),
      )
      .handle("manage", ({ payload }) =>
        Effect.gen(function* () {
          const service = yield* scheduler()
          return yield* Effect.tryPromise({
            try: async () => {
              if (payload.action === "create") return service.put(payload.definition)
              if (!payload.id) throw new Error("Schedule id is required")
              if (payload.action === "update") return service.put(payload.definition, payload.id)
              if (payload.action === "acknowledge") return service.acknowledge(payload.id)
              if (payload.action === "delete") {
                await service.remove(payload.id)
                return { deleted: payload.id }
              }
              return service.pause(payload.id, payload.action === "resume")
            },
            catch: (error) =>
              new InvalidRequestError({ message: error instanceof Error ? error.message : String(error) }),
          }).pipe(Effect.map(json))
        }),
      ),
  )
}

export const scheduleHandlers = scheduleHandlersFor(async () => {
  const { getScheduler } = await import("@/schedule/runtime")
  return getScheduler()
})

function json(value: unknown) {
  // Domain records may contain explicit undefined optional fields. Normalize
  // them to their persisted JSON representation before HttpApi validates output.
  return Schema.decodeUnknownSync(Schema.UnknownFromJsonString)(JSON.stringify(value))
}
