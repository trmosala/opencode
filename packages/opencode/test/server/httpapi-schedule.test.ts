import { NodeHttpServer, NodeServices } from "@effect/platform-node"
import { describe, expect } from "bun:test"
import { Context, Effect, Layer, Option, Schema } from "effect"
import { HttpClient, HttpClientRequest, HttpRouter } from "effect/unstable/http"
import { HttpApiBuilder } from "effect/unstable/httpapi"
import { Scheduler } from "../../src/schedule/engine"
import { Definition } from "../../src/schedule/definition"
import { ServerAuth } from "../../src/server/auth"
import { ScheduleApi } from "../../src/server/routes/instance/httpapi/groups/schedule"
import { scheduleHandlersFor } from "../../src/server/routes/instance/httpapi/handlers/schedule"
import { authorizationLayer } from "../../src/server/routes/instance/httpapi/middleware/authorization"
import { schemaErrorLayer } from "../../src/server/routes/instance/httpapi/middleware/schema-error"
import { tmpdirScoped } from "../fixture/fixture"
import { testEffect } from "../lib/effect"

const definition = {
  schemaVersion: 1,
  name: "Review changes",
  prompt: "Summarize the recent changes.",
  target: { type: "existing_session", sessionID: "ses_example" },
  schedule: { type: "once", at: "2030-10-08T09:00:00Z" },
}

function routes(load: () => Promise<Scheduler>, password?: string) {
  return HttpRouter.serve(
    HttpApiBuilder.layer(ScheduleApi).pipe(
      Layer.provide(scheduleHandlersFor(load)),
      Layer.provide([authorizationLayer, schemaErrorLayer]),
      // This standalone route group requires no instance context.
      // oxlint-disable-next-line typescript-eslint/no-unsafe-type-assertion
      HttpRouter.provideRequest(Layer.succeedContext(Context.empty() as Context.Context<unknown>)),
    ),
    { disableListenLog: true, disableLogger: true },
  ).pipe(
    Layer.provideMerge(NodeHttpServer.layerTest),
    Layer.provide(ServerAuth.Config.configLayer({ password: Option.fromNullishOr(password), username: "opencode" })),
  )
}

const live = Layer.unwrap(
  Effect.gen(function* () {
    const tmp = yield* tmpdirScoped()
    const scheduler = yield* Effect.acquireRelease(
      Effect.promise(() =>
        new Scheduler(tmp + "/schedules.json", {
          normalize: async (value) => ({
            definition: { ...Definition.parse(value), endsAt: undefined },
            directory: tmp,
          }),
          authenticate: async () => true,
          requestLogin: async () => {},
          reconcile: async () => "absent",
          execute: async () => ({ state: "completed" }),
          notify: async () => {},
        }).open(),
      ),
      (service) => Effect.promise(() => service.close()),
    )
    return routes(async () => scheduler)
  }),
)
const it = testEffect(live.pipe(Layer.provide(NodeServices.layer)))
const protectedIt = testEffect(
  routes(async () => {
    throw new Error("Unavailable")
  }, "schedule-test"),
)
const unavailableIt = testEffect(
  routes(async () => {
    throw new Error("Unavailable")
  }),
)

describe("schedule HttpApi", () => {
  it.live("creates, edits, pauses, resumes and deletes a durable task", () =>
    Effect.gen(function* () {
      const create = yield* HttpClientRequest.post("/schedule").pipe(
        HttpClientRequest.bodyJsonUnsafe({ action: "create", definition }),
        HttpClient.execute,
      )
      expect(create.status).toBe(200)
      const saved = yield* create.json
      expect(saved).toMatchObject({ revision: 1, definition: { name: definition.name, enabled: true } })
      const id = Schema.decodeUnknownSync(Schema.Struct({ id: Schema.String }))(saved).id
      for (const action of ["pause", "resume"] as const) {
        const response = yield* HttpClientRequest.post("/schedule").pipe(
          HttpClientRequest.bodyJsonUnsafe({ action, id }),
          HttpClient.execute,
        )
        expect(response.status).toBe(200)
        expect(yield* response.json).toMatchObject({ definition: { enabled: action === "resume" } })
      }
      const edit = yield* HttpClientRequest.post("/schedule").pipe(
        HttpClientRequest.bodyJsonUnsafe({ action: "update", id, definition: { ...definition, name: "Edited task" } }),
        HttpClient.execute,
      )
      expect(edit.status).toBe(200)
      expect(yield* edit.json).toMatchObject({ id, revision: 4, definition: { name: "Edited task" } })
      const remove = yield* HttpClientRequest.post("/schedule").pipe(
        HttpClientRequest.bodyJsonUnsafe({ action: "delete", id }),
        HttpClient.execute,
      )
      expect(remove.status).toBe(200)
      const list = yield* HttpClient.get("/schedule")
      expect(yield* list.json).toMatchObject({
        totalOccurrences: 0,
        occurrences: [],
        schedules: [{ id, deleted: true }],
      })
    }),
  )
  it.live("rejects malformed definitions and missing identifiers", () =>
    Effect.gen(function* () {
      const invalid = yield* HttpClientRequest.post("/schedule").pipe(
        HttpClientRequest.bodyJsonUnsafe({ action: "create", definition: { ...definition, prompt: " " } }),
        HttpClient.execute,
      )
      expect(invalid.status).toBe(400)
      expect(yield* invalid.json).toMatchObject({ _tag: "InvalidRequestError" })
      const missing = yield* HttpClientRequest.post("/schedule").pipe(
        HttpClientRequest.bodyJsonUnsafe({ action: "pause" }),
        HttpClient.execute,
      )
      expect(missing.status).toBe(400)
      const unknown = yield* HttpClientRequest.post("/schedule").pipe(
        HttpClientRequest.bodyJsonUnsafe({ action: "run-now" }),
        HttpClient.execute,
      )
      expect(unknown.status).toBe(400)
    }),
  )
  protectedIt.live("requires server authorization for reads and writes", () =>
    Effect.gen(function* () {
      const list = yield* HttpClient.get("/schedule")
      expect(list.status).toBe(401)
      const create = yield* HttpClientRequest.post("/schedule").pipe(
        HttpClientRequest.bodyJsonUnsafe({ action: "create", definition }),
        HttpClient.execute,
      )
      expect(create.status).toBe(401)
    }),
  )
  unavailableIt.live("reports desktop scheduling as unavailable without starting it", () =>
    Effect.gen(function* () {
      const list = yield* HttpClient.get("/schedule")
      expect(list.status).toBe(503)
      expect(yield* list.json).toMatchObject({ _tag: "ServiceUnavailableError", service: "scheduling" })
    }),
  )
})
