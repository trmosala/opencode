import { readFile } from "node:fs/promises"
import type { Context, Plugin } from "@opencode/plugin/promise/plugin"
import type { ToolContext } from "@opencode/plugin/promise/tool"
import type { OpenCodeEvent } from "@opencode/client"
import { Permission } from "@opencode/core/permission"
import { z } from "zod"
import { aeClient, aeProjection } from "./ae-client"

type LegacyContext = {
  sessionID: string
  abort: AbortSignal
  ask: (input: {
    permission: string
    patterns: string[]
    always: string[]
    metadata: Record<string, unknown>
  }) => Promise<void>
}
type Legacy = {
  server(
    input: { directory: string; client: ReturnType<typeof aeClient> },
    options: Record<string, unknown>,
  ): Promise<{
    tool: Record<
      string,
      {
        description: string
        args: z.ZodRawShape
        execute(
          input: unknown,
          context: LegacyContext,
        ): Promise<
          | string
          | {
              output: string
              title?: string
              metadata?: Record<string, unknown>
              attachments?: { url: string; mime: string; filename?: string }[]
            }
        >
      }
    >
    config(input: unknown): Promise<void>
    event(input: { event: unknown }): Promise<void>
    dispose(): Promise<void>
  }>
  checkPermissionConfig(config: unknown, name: string | null, options?: { configure: boolean }): unknown
}
const actions = z.record(z.string().regex(/^ae_[a-z_]+$/), z.enum(["allow", "ask", "deny"]))
const reads = [
  "ae_connections",
  "ae_inspect",
  "ae_render_list",
  "ae_render_status",
  "ae_render_result",
  "ae_diagnostics",
]

export default {
  id: "cm-ae",
  async setup(ctx) {
    const legacy: Legacy = await import(new URL("./plugin.mjs", import.meta.url).href)
    const permissions = actions.parse(
      JSON.parse(await readFile(new URL("./permissions.json", import.meta.url), "utf8")),
    )
    if (typeof legacy.server !== "function" || typeof legacy.checkPermissionConfig !== "function")
      throw new Error("Unsupported CookieMonster AE artifact")
    const config = { permission: permissions }
    legacy.checkPermissionConfig(config, null, { configure: true })
    const projection = aeProjection()
    const instance = await legacy.server(
      { directory: ctx.location.directory, client: aeClient(ctx, projection) },
      ctx.options,
    )
    const lifetime = new AbortController()
    const registrations: { dispose(): Promise<void> }[] = []
    let events: Promise<void> | undefined
    const dispose = async () => {
      lifetime.abort()
      projection.clear()
      await Promise.allSettled(registrations.map((item) => item.dispose()))
      try {
        await events
      } finally {
        await instance.dispose()
      }
    }
    try {
      if (Object.keys(instance.tool).sort().join() !== Object.keys(permissions).sort().join())
        throw new Error("Unsupported CookieMonster AE tool roster")
      await instance.config(config)
      registrations.push(
        await ctx.agent.transform((editor) => {
          editor.list().forEach((agent) => {
            agent.permissions = [
              ...Object.entries(permissions).map(([action, effect]) => ({ action, resource: "*", effect })),
              ...agent.permissions,
            ]
          })
        }),
      )
      registrations.push(
        await ctx.permission.hook("evaluate", (event) => {
          if (!Object.hasOwn(permissions, event.action)) return
          if (permissions[event.action] === "deny") event.effect = "deny"
          // Session-level allow cannot bypass the vendored client's mandatory mutation review.
          if ((permissions[event.action] === "ask" || !reads.includes(event.action)) && event.effect === "allow")
            event.effect = "ask"
        }),
      )
      registrations.push(
        await ctx.tool.transform((editor) => {
          Object.entries(instance.tool).forEach(([name, definition]) =>
            editor.add({
              name,
              description: definition.description,
              input: standard(z.object(definition.args).strict()),
              options: { codemode: false },
              async execute(input, context) {
                const info = await ctx.session.get({ sessionID: context.sessionID })
                if (info.location.directory !== ctx.location.directory)
                  throw new Error("AE session belongs to another workspace")
                const agent = (await ctx.agent.get({ agentID: context.agent })).data
                if (
                  Permission.evaluate(name, "*", [...agent.permissions, ...(info.permissions ?? [])]).effect === "deny"
                )
                  throw new Error(`AE tool denied by policy: ${name}`)
                context.signal.throwIfAborted()
                // Reads and pairing have no native approval callback; checkpoint listing needs its configured policy too.
                if (
                  reads.includes(name) ||
                  name === "ae_pair" ||
                  (name === "ae_checkpoints" &&
                    (!input ||
                      (input as { action?: string }).action === undefined ||
                      (input as { action?: string }).action === "list"))
                )
                  await assert(ctx, context, name, [name], { input })
                const output = await definition.execute(input, {
                  sessionID: context.sessionID,
                  abort: context.signal,
                  ask: (value) => assert(ctx, context, value.permission, value.patterns, value.metadata),
                })
                if (typeof output === "string") return { content: output }
                return {
                  content: [
                    { type: "text" as const, text: output.output },
                    ...(output.attachments ?? []).map((file) => ({
                      type: "file" as const,
                      uri: file.url,
                      mime: file.mime,
                      name: file.filename,
                    })),
                  ],
                  metadata: { ...output.metadata, ...(output.title ? { title: output.title } : {}) },
                }
              },
            }),
          )
        }),
      )
      events = (async () => {
        for await (const event of ctx.event.subscribe({
          types: [
            "session.deleted",
            "permission.asked",
            "permission.replied",
            "session.execution.failed",
            "session.text.delta",
            "session.reasoning.delta",
            "session.text.ended",
            "session.reasoning.ended",
          ],
          signal: lifetime.signal,
        })) {
          projection.event(event)
          if (event.type === "permission.asked") {
            // The public Asked event omits the request ID; use the authoritative pending roster.
            for (const request of await ctx.permission.list({ sessionID: event.data.sessionID }))
              await instance.event({
                event: {
                  type: event.type,
                  properties: { ...request, permission: request.action, patterns: request.resources },
                },
              })
            continue
          }
          const translated = legacyEvent(event)
          if (translated) await instance.event({ event: translated })
        }
      })().catch((error) => {
        if (!lifetime.signal.aborted) throw error
      })
      void events.catch((error) => console.error("CookieMonster AE event bridge failed", error))
      return dispose
    } catch (error) {
      await dispose()
      throw error
    }
  },
} satisfies Plugin

function assert(
  ctx: Context,
  context: ToolContext,
  action: string,
  resources: string[],
  metadata: Record<string, unknown>,
) {
  return ctx.permission.assert({
    sessionID: context.sessionID,
    agent: context.agent,
    action,
    resources,
    save: [],
    metadata,
    source: { type: "tool", messageID: context.messageID, id: context.id },
  })
}

export function legacyEvent(event: OpenCodeEvent) {
  if (event.type === "session.deleted") return { type: event.type, properties: { info: { id: event.data.sessionID } } }
  if (event.type === "permission.replied") return { type: event.type, properties: event.data }
  if (event.type === "session.execution.failed") return { type: "session.error", properties: event.data }
  return undefined
}

function standard<T extends z.ZodType>(schema: T) {
  return {
    "~standard": {
      version: 1 as const,
      vendor: "zod",
      validate(value: unknown) {
        const result = schema.safeParse(value)
        return result.success
          ? { value: result.data as z.output<T> }
          : { issues: result.error.issues.map((issue) => ({ message: issue.message, path: issue.path })) }
      },
      jsonSchema: {
        input: () => z.toJSONSchema(schema, { target: "draft-2020-12", io: "input" }) as Record<string, unknown>,
        output: () => z.toJSONSchema(schema, { target: "draft-2020-12", io: "output" }) as Record<string, unknown>,
      },
    },
  }
}
