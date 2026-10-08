import { Schema } from "effect"
import { HttpApi, HttpApiEndpoint, HttpApiGroup, OpenApi } from "effect/unstable/httpapi"
import { InvalidRequestError, ServiceUnavailableError } from "../errors"
import { Authorization } from "../middleware/authorization"
import { SchemaErrorMiddleware } from "../middleware/schema-error"

export const ScheduleApi = HttpApi.make("scheduling")
  .add(
    HttpApiGroup.make("schedule").add(
      HttpApiEndpoint.get("list", "/schedule", {
        success: Schema.Struct({
          version: Schema.Literal(1),
          schedules: Schema.Array(Schema.Unknown),
          occurrences: Schema.Array(Schema.Unknown),
          totalOccurrences: Schema.Number,
        }),
        error: ServiceUnavailableError,
      }).annotate(OpenApi.Identifier, "schedule.list"),
      HttpApiEndpoint.post("manage", "/schedule", {
        payload: Schema.Struct({
          action: Schema.Literals(["create", "update", "pause", "resume", "delete", "acknowledge"]),
          id: Schema.optional(Schema.String),
          definition: Schema.optional(Schema.Unknown),
        }),
        success: Schema.Unknown,
        error: [InvalidRequestError, ServiceUnavailableError],
      }).annotate(OpenApi.Identifier, "schedule.manage"),
    ),
  )
  .middleware(SchemaErrorMiddleware)
  .middleware(Authorization)
