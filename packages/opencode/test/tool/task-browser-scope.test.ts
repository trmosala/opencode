import { describe, expect, test } from "bun:test"
import type { Hooks } from "@opencode-ai/plugin"
import { Database } from "@opencode-ai/core/database/database"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { ModelV2 } from "@opencode-ai/core/model"
import { ProviderV2 } from "@opencode-ai/core/provider"
import { SessionProjector } from "@opencode-ai/core/session/projector"
import { Cause, Deferred, Effect, Exit, Fiber, Schema } from "effect"
import { Agent } from "@/agent/agent"
import { BackgroundJob } from "@/background/job"
import { Config } from "@/config/config"
import { RuntimeFlags } from "@/effect/runtime-flags"
import { Plugin } from "@/plugin"
import { Provider } from "@/provider/provider"
import { MessageID, PartID, SessionID } from "@/session/schema"
import { Session } from "@/session/session"
import { ToolJsonSchema } from "@/tool/json-schema"
import { Parameters, TaskTool, type TaskPromptOps } from "@/tool/task"
import { Truncate } from "@/tool/truncate"
import { testEffect } from "../lib/effect"

const it = testEffect(
  LayerNode.compile(
    LayerNode.group([
      Agent.node,
      BackgroundJob.node,
      Config.node,
      Database.node,
      Plugin.node,
      Provider.node,
      RuntimeFlags.node,
      Session.node,
      SessionProjector.node,
      Truncate.node,
    ]),
    [[RuntimeFlags.node, RuntimeFlags.layer({ experimentalBackgroundSubagents: true })]],
  ),
)

const model = {
  providerID: ProviderV2.ID.make("test"),
  modelID: ModelV2.ID.make("test-model"),
}
const config = {
  provider: {
    test: {
      name: "Test",
      npm: "@ai-sdk/openai-compatible",
      models: { "test-model": { name: "Test Model", limit: { context: 100000, output: 10000 } } },
      options: { apiKey: "test-key", baseURL: "http://localhost:1/v1" },
    },
  },
}
const params = { description: "inspect delegated tab", prompt: "inspect page", subagent_type: "general" }
type Hook = NonNullable<Hooks["task.execute.scope"]>

const setup = Effect.fn("TaskBrowserScopeTest.setup")(function* (hook?: Hook) {
  const sessions = yield* Session.Service
  const plugins = yield* Plugin.Service
  const hooks = yield* plugins.list()
  if (hook) {
    const entry = { "task.execute.scope": hook }
    yield* Effect.acquireRelease(
      Effect.sync(() => hooks.push(entry)),
      () =>
        Effect.sync(() => {
          hooks.splice(hooks.indexOf(entry), 1)
        }),
    )
  }
  const parent = yield* sessions.create({ title: "Parent" })
  const user = yield* sessions.updateMessage({
    id: MessageID.ascending(),
    sessionID: parent.id,
    role: "user",
    agent: "build",
    model,
    time: { created: Date.now() },
  })
  const assistant = yield* sessions.updateMessage({
    id: MessageID.ascending(),
    sessionID: parent.id,
    parentID: user.id,
    role: "assistant",
    agent: "build",
    mode: "build",
    ...model,
    cost: 0,
    path: { cwd: ".", root: "." },
    time: { created: Date.now() },
    tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
  })
  const tool = yield* TaskTool
  const def = yield* tool.init()
  const prompted: SessionID[] = []
  const cancelled: SessionID[] = []
  const promptOps: TaskPromptOps = {
    cancel: (sessionID) =>
      Effect.sync(() => {
        cancelled.push(sessionID)
      }),
    resolvePromptParts: (text) => Effect.succeed([{ type: "text", text }]),
    prompt: (input) =>
      Effect.sync(() => {
        prompted.push(input.sessionID)
        const messageID = MessageID.ascending()
        return {
          info: { ...assistant, id: messageID, sessionID: input.sessionID },
          parts: [
            {
              id: PartID.ascending(),
              messageID,
              sessionID: input.sessionID,
              type: "text",
              text: "scoped result",
            },
          ],
        }
      }),
  }
  const ctx = {
    sessionID: parent.id,
    messageID: assistant.id,
    agent: "build",
    abort: new AbortController().signal,
    extra: { promptOps },
    messages: [],
    metadata: () => Effect.void,
    ask: () => Effect.void,
  }
  return { sessions, parent, def, ctx, promptOps, prompted, cancelled }
})

describe("built-in browser-scoped task", () => {
  test("schema rejects invalid, duplicate and oversized tab IDs", () => {
    const decode = Schema.decodeUnknownSync(Parameters)
    for (const browser_tab_ids of [
      [],
      ["one", "one"],
      [""],
      ["bad id"],
      ["https://example.com"],
      ["a".repeat(129)],
      Array.from({ length: 17 }, (_, index) => `tab-${index}`),
      "one",
      null,
      [1],
    ]) {
      expect(() => decode({ ...params, browser_tab_ids })).toThrow()
    }
    const browser_tab_ids = Array.from({ length: 16 }, (_, index) => `tab-${index}`)
    expect(decode({ ...params, browser_tab_ids }).browser_tab_ids).toEqual(browser_tab_ids)
    expect(decode(params).browser_tab_ids).toBeUndefined()
    const schema = ToolJsonSchema.fromSchema(Parameters)
    expect(schema).toMatchObject({
      properties: {
        browser_tab_ids: {
          type: "array",
          minItems: 1,
          maxItems: 16,
          uniqueItems: true,
          items: { type: "string", pattern: "^[A-Za-z0-9_-]{1,128}$" },
        },
      },
    })
  })

  it.instance(
    "foreground schema advertises tab IDs when background is disabled",
    () =>
      Effect.gen(function* () {
        const flags = yield* RuntimeFlags.Service
        const tool = yield* TaskTool.pipe(
          Effect.provideService(RuntimeFlags.Service, { ...flags, experimentalBackgroundSubagents: false }),
        )
        const def = yield* tool.init()
        expect(def.jsonSchema).toBeDefined()
        expect(def.jsonSchema).toMatchObject({
          properties: { browser_tab_ids: { minItems: 1, maxItems: 16, uniqueItems: true } },
        })
      }),
    { config },
  )

  it.instance(
    "rejects background or task_id before creating a child",
    () =>
      Effect.gen(function* () {
        const call = yield* setup()
        for (const extra of [{ background: true }, { task_id: "ses_missing" }, { task_id: "" }]) {
          const exit = yield* call.def
            .execute({ ...params, browser_tab_ids: ["one"], ...extra }, call.ctx)
            .pipe(Effect.exit)
          if (Exit.isSuccess(exit)) throw new Error("expected failure")
          expect(Cause.pretty(exit.cause)).toContain("new foreground task without task_id")
        }
        expect(yield* call.sessions.children(call.parent.id)).toEqual([])
        expect(call.prompted).toEqual([])
      }),
    { config },
  )

  it.instance(
    "grants before prompt, awaits cleanup, and never registers a background job",
    () =>
      Effect.gen(function* () {
        const jobs = yield* BackgroundJob.Service
        const calls: string[] = []
        const identities: Parameters<Hook>[0][] = []
        const ready = yield* Deferred.make<void>()
        const finish = yield* Deferred.make<void>()
        const call = yield* setup(async (input, output) => {
          identities.push(input)
          output.defer(async () => {
            calls.push("cleanup")
          })
          calls.push("grant")
          output.acknowledge()
        })
        const prompt = call.promptOps.prompt.bind(call.promptOps)
        call.promptOps.prompt = (input) =>
          Effect.gen(function* () {
            expect(calls).toEqual(["grant"])
            expect(identities[0]?.childSessionID).toBe(input.sessionID)
            expect((yield* call.sessions.get(input.sessionID).pipe(Effect.orDie)).parentID).toBe(call.parent.id)
            expect(yield* jobs.get(input.sessionID)).toBeUndefined()
            calls.push("prompt")
            yield* Deferred.succeed(ready, undefined)
            yield* Deferred.await(finish)
            return yield* prompt(input)
          })
        const fiber = yield* call.def.execute({ ...params, browser_tab_ids: ["one"] }, call.ctx).pipe(Effect.forkChild)
        yield* Deferred.await(ready)
        expect(yield* jobs.list()).toEqual([])
        yield* Deferred.succeed(finish, undefined)
        const result = yield* Fiber.join(fiber)
        expect(result.output).toContain("scoped result")
        expect(calls).toEqual(["grant", "prompt", "cleanup"])
        expect(call.cancelled).toEqual([])
        expect(result.metadata).not.toHaveProperty("executionID")
        expect(result.metadata).not.toHaveProperty("browserTabIDs")
        expect(result.metadata).not.toHaveProperty("background")
        expect(identities[0]?.parentSessionID).toBe(call.parent.id)
      }),
    { config },
  )

  it.instance(
    "fails closed when no plugin acknowledges",
    () =>
      Effect.gen(function* () {
        const call = yield* setup()
        const exit = yield* call.def.execute({ ...params, browser_tab_ids: ["one"] }, call.ctx).pipe(Effect.exit)
        if (Exit.isSuccess(exit)) throw new Error("expected failure")
        expect(Cause.pretty(exit.cause)).toContain("not acknowledged")
        expect(call.prompted).toEqual([])
        const child = (yield* call.sessions.children(call.parent.id))[0]
        expect(call.cancelled).toEqual([child?.id])
      }),
    { config },
  )

  it.instance(
    "pre-abort cancels the fresh child without acquiring",
    () =>
      Effect.gen(function* () {
        const call = yield* setup(async () => {
          throw new Error("must not acquire")
        })
        const exit = yield* call.def
          .execute({ ...params, browser_tab_ids: ["one"] }, { ...call.ctx, abort: AbortSignal.abort() })
          .pipe(Effect.exit)
        expect(Exit.hasInterrupts(exit)).toBe(true)
        const child = (yield* call.sessions.children(call.parent.id))[0]
        expect(child).toBeDefined()
        expect(call.cancelled).toEqual([child?.id])
        expect(call.prompted).toEqual([])
      }),
    { config },
  )
})
