import path from "node:path"
import { stat } from "node:fs/promises"
import { execFile } from "node:child_process"
import { promisify } from "node:util"
import { Effect, Option } from "effect"
import { eq } from "drizzle-orm"
import { Global } from "@opencode-ai/core/global"
import { Database } from "@opencode-ai/core/database/database"
import { SessionTable } from "@opencode-ai/core/session/sql"
import { ProviderV2 } from "@opencode-ai/core/provider"
import { ModelV2 } from "@opencode-ai/core/model"
import { Session } from "../session/session"
import { SessionPrompt } from "../session/prompt"
import { SessionID, MessageID } from "../session/schema"
import { Agent } from "../agent/agent"
import { Provider } from "../provider/provider"
import { InstanceStore } from "../project/instance-store"
import { AppRuntime } from "../effect/app-runtime"
import { GlobalBus } from "../bus/global"
import { Definition } from "./definition"
import { Busy, Scheduler, type Occurrence } from "./engine"
import { prepareWorktree } from "./worktree"

const git = promisify(execFile)
let current: Scheduler | undefined
let opening: Promise<Scheduler> | undefined
let failure: unknown
const bridge = () =>
  "http://" + (process.env.O1_CODE_PROXY_HOST ?? "127.0.0.1") + ":" + (process.env.O1_CODE_PROXY_PORT ?? "8787")

function inDirectory<A, E, R>(directory: string, effect: Effect.Effect<A, E, R>) {
  return InstanceStore.Service.use((store) => store.provide({ directory }, effect))
}

const sessionRow = (id: string) =>
  AppRuntime.runPromise(
    Database.Service.use((database) =>
      database.db
        .select()
        .from(SessionTable)
        .where(eq(SessionTable.id, SessionID.make(id)))
        .get()
        .pipe(Effect.orDie),
    ),
  )

async function normalize(definition: Definition) {
  if (definition.target.type === "existing_session") {
    const row = await sessionRow(definition.target.sessionID)
    if (!row) throw new Error("Target session does not exist on this local server")
    return { definition, directory: row.directory }
  }
  if (!(await stat(definition.target.directory)).isDirectory()) throw new Error("Target is not a directory")
  if (definition.target.workspace.type === "worktree") {
    await git("git", [
      "-C",
      definition.target.directory,
      "rev-parse",
      "--verify",
      "--end-of-options",
      definition.target.workspace.baseRef + "^{commit}",
    ])
  }
  const target = definition.target
  const resolved = await AppRuntime.runPromise(
    inDirectory(
      target.directory,
      Effect.gen(function* () {
        const agents = yield* Agent.Service
        const providers = yield* Provider.Service
        const agent = target.agent ?? (yield* agents.defaultAgent())
        if (!(yield* agents.get(agent))) return yield* Effect.die("Scheduled agent does not exist")
        const model =
          target.model ??
          (yield* providers
            .defaultModel()
            .pipe(Effect.map((value) => ({ providerID: value.providerID, id: value.modelID, variant: undefined }))))
        const available = yield* providers.getModel(ProviderV2.ID.make(model.providerID), ModelV2.ID.make(model.id))
        if (model.variant && !available.variants?.[model.variant])
          return yield* Effect.die("Scheduled model variant does not exist")
        return { ...definition, target: { ...target, agent, model } }
      }),
    ),
  )
  return { definition: Definition.parse(resolved), directory: target.directory }
}

async function authenticate(item: Occurrence) {
  const row = item.definition.target.type === "existing_session" ? await sessionRow(item.sessionID) : undefined
  const model = item.definition.target.type === "new_session" ? item.definition.target.model : row?.model
  const providerID =
    model?.providerID ??
    (
      await AppRuntime.runPromise(
        inDirectory(
          item.directory!,
          Provider.Service.use((providers) => providers.defaultModel()),
        ),
      )
    ).providerID
  if (providerID !== "cookiemonster") return true
  const response = await fetch(bridge() + "/bridge/auth", { signal: AbortSignal.timeout(15000) }).catch(() => undefined)
  if (!response) return false
  if (!response.ok) return false
  const state: unknown = await response.json().catch(() => undefined)
  return !!state && typeof state === "object" && "status" in state && state.status === "signed-in"
}

async function reconcile(item: Occurrence) {
  const row = await sessionRow(item.sessionID)
  if (!row) return "absent" as const
  const messages = await AppRuntime.runPromise(
    inDirectory(
      row.directory,
      Session.Service.use((sessions) => sessions.messages({ sessionID: SessionID.make(item.sessionID) })),
    ),
  )
  const prompt = messages.find((value) => value.info.id === item.promptID)
  if (!prompt) return "absent" as const
  const assistant = messages.findLast(
    (value) => value.info.role === "assistant" && value.info.parentID === item.promptID,
  )
  if (
    assistant?.info.role === "assistant" &&
    !assistant.info.error &&
    assistant.info.time.completed &&
    assistant.info.finish === "stop" &&
    !assistant.parts.some((part) => part.type === "tool" && part.state.status !== "completed")
  )
    return "completed" as const
  return "uncertain" as const
}

async function execute(item: Occurrence, admitted: () => Promise<void>, persist: () => Promise<void>) {
  const target = item.definition.target
  if (target.type === "new_session" && target.workspace.type === "worktree") {
    await prepareWorktree(
      item,
      path.join(Global.Path.data, "scheduled-worktrees"),
      (await getScheduler().list()).occurrences.filter((value) => value.worktree).length,
      persist,
    )
  }
  const row = await sessionRow(item.sessionID)
  if (target.type === "new_session" && row && row.metadata?.scheduleOccurrence !== item.id)
    throw new Error("Session ownership does not match this occurrence")
  if (target.type === "new_session" && !row) {
    await AppRuntime.runPromise(
      inDirectory(
        item.directory!,
        Session.Service.use((sessions) =>
          sessions.create({
            id: SessionID.make(item.sessionID),
            title: item.definition.name,
            agent: target.agent,
            model: target.model
              ? {
                  providerID: ProviderV2.ID.make(target.model.providerID),
                  id: ModelV2.ID.make(target.model.id),
                  variant: target.model.variant,
                }
              : undefined,
            metadata: { scheduleOccurrence: item.id, scheduleID: item.scheduleID },
          }),
        ),
      ),
    )
  }
  const result = await AppRuntime.runPromise(
    inDirectory(
      item.directory!,
      SessionPrompt.Service.use((prompts) =>
        prompts.scheduled(
          {
            sessionID: SessionID.make(item.sessionID),
            messageID: MessageID.make(item.promptID),
            parts: [
              {
                type: "text",
                text: "Scheduled task " + item.scheduleID + " (occurrence " + item.id + ").\n" + item.definition.prompt,
              },
            ],
            ...(target.type === "new_session"
              ? {
                  agent: target.agent,
                  model: target.model
                    ? {
                        providerID: ProviderV2.ID.make(target.model.providerID),
                        modelID: ModelV2.ID.make(target.model.id),
                      }
                    : undefined,
                  variant: target.model?.variant,
                }
              : {}),
          },
          admitted,
        ),
      ),
    ),
  )
  if (Option.isNone(result)) throw new Busy("Waiting for the target session to become idle")
  const message = result.value
  const completed =
    message.info.role === "assistant" &&
    message.info.parentID === item.promptID &&
    !message.info.error &&
    !!message.info.time.completed &&
    message.info.finish === "stop" &&
    !message.parts.some((part) => part.type === "tool" && part.state.status !== "completed")
  return {
    state: completed ? ("completed" as const) : ("attention" as const),
    assistantID: message.info.id,
    detail: completed ? undefined : "Execution stopped, failed, or was steered by new input; review the session",
  }
}

export function getScheduler() {
  if (!current)
    throw new Error(
      failure instanceof Error
        ? "Scheduler unavailable: " + failure.message
        : "Scheduling is available in a running CookieMonster desktop sidecar",
    )
  return current
}

export async function startScheduler() {
  if (process.env.OPENCODE_CLIENT !== "desktop") return undefined
  if (current) return current
  opening ??= new Scheduler(path.join(Global.Path.data, "scheduling", "schedules.json"), {
    normalize,
    authenticate,
    reconcile,
    execute,
    requestLogin: async () => {
      const response = await fetch(bridge() + "/bridge/login", { method: "POST", signal: AbortSignal.timeout(15000) })
      if (!response.ok) throw new Error("Could not open WPP sign-in")
    },
    notify: async (item) => {
      if (item.state === "completed") return
      GlobalBus.emit("event", {
        directory: item.directory,
        payload: {
          type: "session.error",
          properties: {
            sessionID: item.sessionID,
            error: {
              name: "UnknownError",
              data: {
                message:
                  item.definition.name +
                  ": " +
                  (item.detail ?? "Scheduled run completed") +
                  ". Use the schedule tool to view run history.",
              },
            },
          },
        },
      })
    },
  })
    .open()
    .then((scheduler) => {
      failure = undefined
      current = scheduler
      scheduler.start()
      return scheduler
    })
    .catch((error) => {
      failure = error
      opening = undefined
      throw error
    })
  return opening
}

export async function stopScheduler() {
  const scheduler = current
  current = undefined
  opening = undefined
  await scheduler?.close()
}
