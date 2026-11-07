import { isSessionNotFoundError, OpenCode } from "@opencode/client"
import { dirname } from "node:path"
import type { OpenCodeEvent, SessionInfo, SessionMessageInfo } from "@opencode/client"
import type { Context } from "@opencode/plugin/promise/plugin"
import { z } from "zod"

const model = z.object({ providerID: z.string(), id: z.string(), variant: z.string().optional() })
const part = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("text"),
    text: z.string(),
    synthetic: z.boolean().optional(),
    metadata: z.record(z.string(), z.unknown()).optional(),
  }),
  z.object({ type: z.literal("file"), url: z.string(), mime: z.string(), filename: z.string().optional() }),
])
type Request = {
  path?: { id?: string; sessionID?: string; messageID?: string; permissionID?: string }
  query?: { directory?: string; limit?: number; before?: string }
  body?: unknown
  url?: string
  signal?: AbortSignal
}

// Only the audited V1 surface used by the pinned AE artifact is exposed, with V2 admission semantics.
export function aeClient(ctx: Context, projection: ReturnType<typeof aeProjection>) {
  const transport = () => {
    const url = process.env.CM_V2_FEATURE_URL
    const password = process.env.CM_V2_FEATURE_PASSWORD
    if (!url || !password) throw new Error("CookieMonster V2 transport is unavailable")
    return { url, headers: { authorization: `Basic ${Buffer.from(`opencode:${password}`).toString("base64")}` } }
  }
  const client = () => {
    const connection = transport()
    return OpenCode.make({ baseUrl: connection.url, headers: connection.headers })
  }
  const options = (input: Request) => {
    if (input.query?.directory && input.query.directory !== ctx.location.directory)
      throw new Error("AE request belongs to another workspace")
    return { signal: input.signal }
  }
  const session = async (input: Request) => {
    const sessionID = z
      .string()
      .min(1)
      .parse(input.path?.id ?? input.path?.sessionID)
    const info = await client().session.get({ sessionID }, options(input))
    if (info.location.directory !== ctx.location.directory) throw new Error("AE session belongs to another workspace")
    return info
  }
  const raw = async (input: Request, method: "GET" | "POST") => {
    const connection = transport()
    options(input)
    if (!/^\/skill\/(catalog|validate|review|create|manage|select)$/.test(input.url ?? ""))
      throw new Error("Unsupported AE legacy route")
    const url = new URL(input.url!, connection.url)
    url.searchParams.set("directory", ctx.location.directory)
    const response = await fetch(url, {
      method,
      headers: { ...connection.headers, "content-type": "application/json" },
      ...(method === "POST" ? { body: JSON.stringify(input.body) } : {}),
      signal: input.signal,
    })
    const data: unknown = await response.json()
    return response.ok ? { data, response } : { error: data, response }
  }
  return {
    session: {
      async get(input: Request) {
        // Preserve the V1 404 envelope used to retire a deleted panel conversation.
        return session(input).then(
          (info) => ({ data: legacySession(info) }),
          (error: unknown) => {
            if (isSessionNotFoundError(error)) return { response: new Response(null, { status: 404 }) }
            throw error
          },
        )
      },
      async create(input: Request) {
        const body = z.object({ title: z.string() }).parse(input.body)
        return {
          data: legacySession(
            await ctx.session.create(
              {
                ...body,
                location: { directory: ctx.location.directory },
                permissions: [{ action: "question", resource: "*", effect: "deny" }],
              },
              options(input),
            ),
          ),
        }
      },
      async update(input: Request) {
        const info = await session(input)
        await ctx.session.update(
          { sessionID: info.id, ...z.object({ title: z.string() }).parse(input.body) },
          options(input),
        )
        return { data: true }
      },
      async status(input: Request) {
        return { data: await client().session.active(options(input)) }
      },
      async messages(input: Request) {
        const info = await session(input)
        const page = await client().message.list(
          {
            sessionID: info.id,
            order: "desc",
            limit: input.query?.limit ?? 60,
            ...(input.query?.before ? { cursor: input.query.before } : {}),
          },
          options(input),
        )
        return {
          data: legacyMessages(
            projection.apply(page.data, info.id),
            info.id,
            page.data.some((message) => message.type === "skill") ? (await ctx.skill.list()).data : [],
          ),
          response: new Response(null, {
            headers: page.cursor.next ? { "x-next-cursor": page.cursor.next } : {},
          }),
        }
      },
      async message(input: Request) {
        const info = await session(input)
        const messageID = z.string().min(1).parse(input.path?.messageID)
        const value = await client().session.message.get({ sessionID: info.id, messageID }, options(input))
        return { data: legacyMessages([value], info.id)[0] }
      },
      async abort(input: Request) {
        const info = await session(input)
        // Interrupt stops the owner, then cancel admitted queued inputs so Stop cannot wake later work.
        await ctx.session.interrupt({ sessionID: info.id }, options(input))
        const pending = await client().session.inbox.list({ sessionID: info.id }, options(input))
        await Promise.all(
          pending.map((item) =>
            client().session.inbox.cancel({ sessionID: info.id, inboxID: item.id }, options(input)),
          ),
        )
        return { data: true }
      },
      async promptAsync(input: Request) {
        const info = await session(input)
        const body = z
          .object({
            system: z.string(),
            parts: z.array(part),
            model: z.object({ providerID: z.string(), modelID: z.string() }).optional(),
            variant: z.string().optional(),
            tools: z.object({ question: z.literal(false) }),
          })
          .parse(input.body)
        await ctx.session.update(
          {
            sessionID: info.id,
            permissions: [
              ...(info.permissions ?? []).filter((rule) => rule.action !== "question" || rule.resource !== "*"),
              { action: "question", resource: "*", effect: "deny" },
            ],
          },
          options(input),
        )
        if (body.model)
          await ctx.session.switchModel(
            {
              sessionID: info.id,
              model: {
                providerID: body.model.providerID,
                id: body.model.modelID,
                variant: body.variant,
              },
            },
            options(input),
          )
        await ctx.session.instructions.entry.put(
          {
            sessionID: info.id,
            key: "cm-ae-context",
            value: [
              body.system,
              ...body.parts.flatMap((item) => (item.type === "text" && item.synthetic ? [item.text] : [])),
            ].join("\n"),
          },
          options(input),
        )
        const selected = body.parts.flatMap((item) =>
          item.type === "text" && item.metadata?.cmSkill ? [item.metadata.cmSkill] : [],
        )
        if (selected.length) {
          const result = await raw({ ...input, url: "/skill/select", body: { sessionID: info.id, selected } }, "POST")
          if ("error" in result) throw new Error("AE selected skill could not be validated")
        }
        return {
          data: await ctx.session.prompt(
            {
              sessionID: info.id,
              text: body.parts
                .flatMap((item) => (item.type === "text" && !item.synthetic ? [item.text] : []))
                .join("\n"),
              files: body.parts.flatMap((item) =>
                item.type === "file" ? [{ uri: item.url, name: item.filename }] : [],
              ),
              delivery: "steer",
            },
            options(input),
          ),
        }
      },
    },
    provider: {
      async list(input: Request) {
        const [providers, models] = await Promise.all([
          ctx.provider.list({}, options(input)),
          ctx.model.list({}, options(input)),
        ])
        return {
          data: {
            connected: providers.data.map((provider) => provider.id),
            all: providers.data.map((provider) => ({
              ...provider,
              models: Object.fromEntries(
                models.data
                  .filter((item) => item.enabled && item.providerID === provider.id)
                  .map((item) => [
                    item.id,
                    {
                      ...item,
                      variants: Object.fromEntries(item.variants.map((variant) => [variant.id, variant])),
                    },
                  ]),
              ),
            })),
          },
        }
      },
    },
    async postSessionIdPermissionsPermissionId(input: Request) {
      const info = await session(input)
      await ctx.permission.reply(
        {
          sessionID: info.id,
          requestID: z.string().parse(input.path?.permissionID),
          decision: z.object({ response: z.enum(["once", "reject"]) }).parse(input.body).response,
        },
        options(input),
      )
      return { data: true }
    },
    _client: {
      get: (input: Request) => raw(input, "GET"),
      async post(input: Request) {
        if (input.url !== "/api/session/{sessionID}/model") return raw(input, "POST")
        const info = await session(input)
        await ctx.session.switchModel({ sessionID: info.id, ...z.object({ model }).parse(input.body) }, options(input))
        return { data: true }
      },
    },
  }
}

function legacySession(info: SessionInfo) {
  return { ...info, directory: info.location.directory }
}

// V2 projections are the source of truth, including partial streamed content and tool attachments.
export function legacyMessages(
  messages: readonly SessionMessageInfo[],
  sessionID: string,
  skills: readonly { id: string; path: string }[] = [],
) {
  const ordered = [...messages].sort((a, b) => a.id.localeCompare(b.id))
  return ordered
    .map((message, index) => {
      if (message.type === "skill") {
        const skill = skills.find((item) => item.id === message.skill)
        return skill
          ? {
              info: {
                id: message.id,
                sessionID,
                role: "assistant",
                time: { ...message.time, completed: message.time.created },
              },
              parts: [
                {
                  type: "tool",
                  id: message.id,
                  tool: "skill",
                  state: { status: "completed", metadata: { name: message.name, dir: dirname(skill.path) } },
                },
              ],
            }
          : undefined
      }
      if (message.type !== "assistant" && message.type !== "user") return undefined
      return {
        info: {
          id: message.id,
          sessionID,
          role: message.type,
          time: message.time,
          ...(message.type === "assistant"
            ? {
                error: message.error ? { data: { message: message.error.message } } : undefined,
                parentID: ordered.slice(0, index).findLast((item) => item.type === "user")?.id,
              }
            : {}),
        },
        parts:
          message.type === "user"
            ? [
                { type: "text", text: message.text, id: `${message.id}:text` },
                ...(message.files ?? []).map((file, index) => ({
                  type: "file",
                  id: `${message.id}:file:${index}`,
                  url: `data:${file.mime};base64,${file.data}`,
                  mime: file.mime,
                  filename: file.name,
                })),
              ]
            : message.content.map((item, index) =>
                item.type !== "tool"
                  ? { ...item, id: `${message.id}:${index}` }
                  : {
                      type: "tool",
                      id: item.id,
                      tool: item.name,
                      state: {
                        ...item.state,
                        ...(item.state.status === "completed" || item.state.status === "error"
                          ? {
                              ...(item.name === "skill"
                                ? { metadata: { ...item.state.metadata, dir: item.state.metadata?.directory } }
                                : {}),
                              output:
                                item.state.content
                                  ?.flatMap((content) => (content.type === "text" ? [content.text] : []))
                                  .join("\n") ?? "",
                              attachments: item.state.content?.flatMap((content) =>
                                content.type === "file"
                                  ? [{ url: content.uri, mime: content.mime, filename: content.name }]
                                  : [],
                              ),
                            }
                          : {}),
                      },
                    },
              ),
      }
    })
    .filter((message) => message !== undefined)
}

// V2 text/reasoning deltas are ephemeral; the polling AE panel also needs the live projection.
export function aeProjection() {
  const live = new Map<
    string,
    { sessionID: string; content: Map<string, { ordinal: number; type: "text" | "reasoning"; text: string }> }
  >()
  return {
    clear() {
      live.clear()
    },
    event(event: OpenCodeEvent) {
      if (event.type === "session.deleted") {
        live.forEach((message, id) => {
          if (message.sessionID === event.data.sessionID) live.delete(id)
        })
        return
      }
      if (
        event.type !== "session.text.delta" &&
        event.type !== "session.reasoning.delta" &&
        event.type !== "session.text.ended" &&
        event.type !== "session.reasoning.ended"
      )
        return
      const data = event.data
      if (data.ordinal > 128) return
      if (!live.has(data.assistantMessageID)) {
        if (live.size >= 60) live.delete(live.keys().next().value!)
        live.set(data.assistantMessageID, { sessionID: data.sessionID, content: new Map() })
      }
      const message = live.get(data.assistantMessageID)!
      const type = event.type.startsWith("session.text.") ? "text" : "reasoning"
      const key = `${type}:${data.ordinal}`
      const remaining =
        400000 - [...message.content].reduce((total, [id, part]) => total + (id === key ? 0 : part.text.length), 0)
      message.content.set(key, {
        type,
        ordinal: data.ordinal,
        text: ("delta" in data ? (message.content.get(key)?.text ?? "") + data.delta : data.text).slice(
          0,
          Math.min(64000, remaining),
        ),
      })
    },
    apply(messages: readonly SessionMessageInfo[], sessionID: string): readonly SessionMessageInfo[] {
      return messages.map((message) => {
        const current = live.get(message.id)
        if (message.type !== "assistant" || !current || current.sessionID !== sessionID) return message
        const content = [...message.content]
        current.content.forEach((part) => {
          const index = content.flatMap((stored, index) => (stored.type === part.type ? [index] : []))[part.ordinal]
          const stored = content[index]
          if (
            !stored ||
            ((stored.type === "text" || stored.type === "reasoning") && stored.text.length < part.text.length)
          )
            content[index ?? content.length] = { type: part.type, text: part.text }
        })
        if (
          message.time.completed &&
          [...current.content.values()].every((part) => {
            const stored = message.content.filter((stored) => stored.type === part.type)[part.ordinal]
            return (
              stored && (stored.type === "text" || stored.type === "reasoning") && stored.text.startsWith(part.text)
            )
          })
        )
          live.delete(message.id)
        return { ...message, content: content.filter((part) => part !== undefined) }
      })
    },
  }
}
