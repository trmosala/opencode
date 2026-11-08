export * as Server from "./server"

import type { ServerOptions } from "@opencode/server/options"
import { ServerProcess } from "@opencode/server/process"
import { isAllowedRequestOrigin } from "@opencode/server/cors"
import { Effect, Exit, Scope } from "effect"
import { HttpServerRequest, HttpServerResponse } from "effect/http"
import { OpenCode } from "@opencode/client"
import { Extensions } from "./extensions"
import { openScheduler } from "./scheduler"
import z from "zod"
import { featuresRpc } from "./features-rpc"

export type ListenOptions = {
  hostname: string
  port: number
  password: string
  database: string
  config?: ServerOptions["config"]
}

export async function listen(input: ListenOptions) {
  const scope = Effect.runSync(Scope.make())
  const extensions = new Extensions(input.password)
  const config = z
    .object({ plugin: z.array(z.unknown()).optional() })
    .loose()
    .parse(JSON.parse(input.config?.content ?? "{}"))
  config.plugin = [
    ...(config.plugin ?? []),
    [
      process.env.CM_V2_FEATURE_PLUGIN ?? new URL("./features-plugin", import.meta.url).href,
      { configDirectory: input.config?.directory, project: input.config?.project !== false },
    ],
  ]
  const server = await Effect.runPromise(
    ServerProcess.start<never, never>(
      {
        hostname: input.hostname,
        port: input.port,
        password: input.password,
        database: { path: input.database },
        config: { ...input.config, content: JSON.stringify(config) },
        app: { name: "desktop", version: "2.2.5", channel: "stable" },
        fs: { filewatcher: true, fff: false },
      },
      undefined,
      (app) =>
        Effect.gen(function* () {
          const request = yield* HttpServerRequest.HttpServerRequest
          if (!isAllowedRequestOrigin(request.headers.origin, request.headers.host))
            return HttpServerResponse.empty({ status: 403 })
          const extension = extensions.handle(request)
          if (extension) return yield* extension
          return yield* app
        }),
    ).pipe(
      Scope.provide(scope),
      Effect.onExit((exit) => (Exit.isFailure(exit) ? Scope.close(scope, exit) : Effect.void)),
    ),
  )
  if (!("port" in server.address)) throw new Error("Expected a TCP sidecar listener")
  const url = `http://${input.hostname.includes(":") ? `[${input.hostname}]` : input.hostname}:${server.address.port}`
  const deadline = Date.now() + 240_000
  await (async () => {
    while (Date.now() < deadline) {
      const response = await fetch(`${url}/api/experimental/migration/v1`, {
        headers: { authorization: `Basic ${Buffer.from(`opencode:${input.password}`).toString("base64")}` },
        signal: AbortSignal.timeout(5000),
      })
      if (!response.ok) throw new Error(`V1 history migration status failed: ${response.status}`)
      const status = z.object({ status: z.string(), error: z.string().optional() }).parse(await response.json())
      if (status.status === "completed") return
      if (status.status === "error") throw new Error(`V1 history migration failed: ${status.error}`)
      await new Promise((resolve) => setTimeout(resolve, 50))
    }
    throw new Error("V1 history migration did not complete within four minutes")
  })().catch(async (error) => {
    await Effect.runPromise(Scope.close(scope, Exit.void))
    throw error
  })
  const client = OpenCode.make({
    baseUrl: url,
    headers: { authorization: `Basic ${Buffer.from(`opencode:${input.password}`).toString("base64")}` },
  })
  extensions.initialize(client, input.config?.directory, input.config?.project !== false)
  process.env.CM_V2_FEATURE_URL = url
  process.env.CM_V2_FEATURE_PASSWORD = input.password
  await openScheduler(client, async (item) => {
    await client.rpc(featuresRpc).notify(
      {
        sessionID: item.sessionID,
        name: item.definition.name,
        state: item.state,
        detail: item.detail ?? "Scheduled run completed",
      },
      { location: { directory: item.directory } },
    )
  })
    .then((scheduler) => {
      extensions.scheduler = scheduler
      scheduler.start()
    })
    .catch((error) => {
      extensions.schedulerError = error
      console.error("CM scheduler unavailable", error)
    })
  let stopping: Promise<void> | undefined
  return {
    address: server.address,
    stop: () =>
      (stopping ??= (async () => {
        await extensions.scheduler?.close()
        await Effect.runPromise(Scope.close(scope, Exit.void))
      })()),
  }
}
