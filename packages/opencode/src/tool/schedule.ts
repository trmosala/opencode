import { Effect, Schema } from "effect"
import { Tool } from "./tool"
import { Definition } from "../schedule/definition"

const Parameters = Schema.Struct({
  action: Schema.Literals(["create", "list", "update", "pause", "resume", "delete", "acknowledge"]),
  id: Schema.optional(Schema.String),
  definition: Schema.optional(Schema.Unknown),
})

export const ScheduleTool = Tool.define<typeof Parameters, {}, never>(
  "schedule",
  Effect.succeed({
    description:
      "Manage durable CookieMonster tasks while the desktop is running. Create/update requires a full definition: schemaVersion=1, name, prompt, target={type:existing_session,sessionID} or {type:new_session,directory,workspace:{type:local}|{type:worktree,baseRef},agent?,model?:{providerID,id,variant?}}, schedule={type:once,at}|{type:interval,everyMinutes,startsAt}|{type:calendar,timezone,time:HH:mm,weekdays:[mon..sun]}, optional enabled, misfire={type:skip}|{type:catch_up_once,withinMinutes}, notification=all_runs|failures_only, maxRuns<=10000, endsAt. ISO timestamps require seconds and a UTC offset. Existing-session tasks wait until idle. WPP sign-in retains pending work. List includes occurrence history and attention states. Pause a schedule explicitly when a prompt's stop condition is satisfied. Permission approval remains required for scheduled actions; creating a schedule grants no other permissions.",
    parameters: Parameters,
    execute: (input: Schema.Schema.Type<typeof Parameters>, ctx) =>
      Effect.gen(function* () {
        if (input.action !== "list")
          yield* ctx.ask({
            permission: "schedule",
            patterns: [input.id ?? "create"],
            always: ["*"],
            metadata: { action: input.action },
          })
        const { getScheduler } = yield* Effect.promise(() => import("../schedule/runtime"))
        const scheduler = getScheduler()
        const result = yield* Effect.promise(async () => {
          if (input.action === "list") {
            const state = await scheduler.list()
            return { ...state, occurrences: state.occurrences.slice(-100), totalOccurrences: state.occurrences.length }
          }
          const definition =
            input.action === "create" || input.action === "update" ? Definition.parse(input.definition) : undefined
          const user = ctx.messages.findLast((message) => message.info.role === "user")?.info
          const selected =
            definition?.target.type === "new_session"
              ? {
                  ...definition,
                  target: {
                    ...definition.target,
                    agent: definition.target.agent ?? ctx.agent,
                    model:
                      definition.target.model ??
                      (user?.role === "user"
                        ? {
                            providerID: user.model.providerID,
                            id: user.model.modelID,
                            variant: user.model.variant,
                          }
                        : undefined),
                  },
                }
              : definition
          if (input.action === "create") return scheduler.put(selected)
          if (!input.id) throw new Error("Schedule id is required")
          if (input.action === "acknowledge") return scheduler.acknowledge(input.id)
          if (input.action === "update") return scheduler.put(selected, input.id)
          if (input.action === "delete") return scheduler.remove(input.id)
          return scheduler.pause(input.id, input.action === "resume")
        })
        return {
          title: "Schedule " + input.action,
          output: JSON.stringify(result ?? { deleted: input.id }, null, 2),
          metadata: {},
        }
      }),
  }),
)
