import { timingSafeEqual } from "node:crypto"
import { isAbsolute, resolve } from "node:path"
import { Effect } from "effect"
import { ByteSize } from "effect"
import { HttpIncomingMessage, HttpServerRequest, HttpServerResponse } from "effect/http"
import type { OpenCodeClient } from "@opencode/client"
import z from "zod"
import type { Scheduler } from "../../opencode/src/schedule/engine"
import { manageSchedule } from "./scheduler"
import { ManagedSkills } from "./skills"
import { resetWorktree } from "./worktree"

const selection = z.object({ name: z.string(), source: z.string(), revision: z.string() })
const draft = z
  .object({
    name: z.string(),
    description: z.string(),
    instructions: z.string(),
    scope: z.enum(["workspace", "global"]),
  })
  .strict()
const management = z
  .object({
    action: z.enum(["read", "review", "apply"]),
    selected: selection,
    operation: z.enum(["edit", "delete"]).optional(),
    draft: draft.optional(),
    token: z.string().optional(),
  })
  .strict()
const schedule = z
  .object({
    action: z.enum(["create", "update", "pause", "resume", "delete", "acknowledge"]),
    id: z.string().optional(),
    definition: z.unknown().optional(),
  })
  .strict()

export class Extensions {
  scheduler?: Scheduler
  schedulerError?: unknown
  skills?: ManagedSkills
  client?: OpenCodeClient
  constructor(readonly password: string) {}

  initialize(client: OpenCodeClient, configDirectory?: string, project = true) {
    this.client = client
    this.skills = new ManagedSkills(client, configDirectory, project)
  }

  handle(request: HttpServerRequest.HttpServerRequest) {
    const url = new URL(request.url, "http://localhost")
    if (
      url.pathname !== "/schedule" &&
      url.pathname !== "/worktree/reset" &&
      !/^\/skill\/(catalog|validate|review|create|manage|select)$/.test(url.pathname)
    )
      return undefined
    return Effect.gen({ self: this }, function* () {
      const expected = Buffer.from(`Basic ${Buffer.from(`opencode:${this.password}`).toString("base64")}`)
      const actual = Buffer.from(request.headers.authorization ?? "")
      if (actual.length !== expected.length || !timingSafeEqual(actual, expected))
        return HttpServerResponse.jsonUnsafe({ message: "Authentication required" }, { status: 401 })
      if (request.method !== "GET" && request.method !== "POST")
        return HttpServerResponse.jsonUnsafe({ message: "Method not allowed" }, { status: 405 })
      const body =
        request.method === "POST"
          ? yield* request.json.pipe(Effect.provideService(HttpIncomingMessage.MaxBodySize, ByteSize.kibibytes(128)))
          : undefined
      return yield* Effect.tryPromise({
        try: async () => {
          if (url.pathname === "/schedule") {
            if (!this.scheduler)
              return HttpServerResponse.jsonUnsafe(
                {
                  message: `Scheduler unavailable: ${this.schedulerError instanceof Error ? this.schedulerError.message : "starting"}`,
                },
                { status: 503 },
              )
            const data = await manageSchedule(
              this.scheduler,
              request.method === "GET" ? { action: "list" } : schedule.parse(body),
            )
            return HttpServerResponse.jsonUnsafe(data)
          }
          if (!this.skills)
            return HttpServerResponse.jsonUnsafe({ message: "Managed skills unavailable" }, { status: 503 })
          const workspace = url.searchParams.get("directory") ?? request.headers["x-opencode-directory"]
          if (!workspace || !isAbsolute(workspace)) throw new Error("An absolute workspace directory is required")
          const directory = resolve(workspace)
          if (url.pathname === "/worktree/reset" && request.method === "POST") {
            if (!this.client) throw new Error("Runtime unavailable")
            const input = z.object({ directory: z.string() }).strict().parse(body)
            if (!isAbsolute(input.directory)) throw new Error("An absolute worktree directory is required")
            return HttpServerResponse.jsonUnsafe(await resetWorktree(this.client, directory, input.directory))
          }
          if (url.pathname === "/skill/catalog" && request.method === "GET")
            return HttpServerResponse.jsonUnsafe(await this.skills.catalog(directory))
          if (request.method !== "POST")
            return HttpServerResponse.jsonUnsafe({ message: "Method not allowed" }, { status: 405 })
          if (url.pathname === "/skill/validate")
            return HttpServerResponse.jsonUnsafe(await this.skills.validate(directory, selection.parse(body)))
          if (url.pathname === "/skill/review")
            return HttpServerResponse.jsonUnsafe(await this.skills.review(directory, draft.parse(body)))
          if (url.pathname === "/skill/create")
            return HttpServerResponse.jsonUnsafe(
              await this.skills.create(directory, draft.extend({ token: z.string() }).parse(body)),
            )
          if (url.pathname === "/skill/manage")
            return HttpServerResponse.jsonUnsafe(await this.skills.manage(directory, management.parse(body)))
          if (url.pathname === "/skill/select")
            return HttpServerResponse.jsonUnsafe(
              await this.skills.select(
                directory,
                z
                  .object({ sessionID: z.string(), selected: z.array(selection).max(100) })
                  .strict()
                  .parse(body),
              ),
            )
          return HttpServerResponse.jsonUnsafe({ message: "Method not allowed" }, { status: 405 })
        },
        catch: (error) => error,
      }).pipe(
        Effect.catch((error) =>
          Effect.succeed(
            HttpServerResponse.jsonUnsafe(
              {
                message:
                  error instanceof Error ||
                  (error && typeof error === "object" && "message" in error && typeof error.message === "string")
                    ? error.message
                    : String(error),
              },
              { status: 400 },
            ),
          ),
        ),
      )
    }).pipe(
      Effect.catch(() =>
        Effect.succeed(HttpServerResponse.jsonUnsafe({ message: "Invalid request body" }, { status: 400 })),
      ),
    )
  }
}
