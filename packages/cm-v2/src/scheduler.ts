import path from "node:path"
import { stat } from "node:fs/promises"
import { Global } from "@opencode/util/global"
import { execFile } from "node:child_process"
import { promisify } from "node:util"
import type { OpenCodeClient, SessionMessageInfo } from "@opencode/client"
import { Scheduler, Busy, type Occurrence } from "../../opencode/src/schedule/engine"
import { Definition } from "../../opencode/src/schedule/definition"
import { scheduleRuntimeRpc } from "./features-rpc"
import { prepareWorktree } from "../../opencode/src/schedule/worktree"

const git = promisify(execFile)
const bridge = () =>
  `http://${process.env.O1_CODE_PROXY_HOST ?? "127.0.0.1"}:${process.env.O1_CODE_PROXY_PORT ?? "8787"}`

export async function openScheduler(client: OpenCodeClient, notify: (item: Occurrence) => Promise<void>) {
  const session = async (id: string) =>
    client.session.get({ sessionID: id }).catch((error: unknown) => {
      if (error && typeof error === "object" && "_tag" in error && error._tag === "SessionNotFoundError")
        return undefined
      throw error
    })
  const history = async (sessionID: string) => {
    const messages: SessionMessageInfo[] = []
    let cursor: string | undefined
    do {
      const page = await client.message.list({
        sessionID,
        limit: 100,
        ...(cursor ? { cursor } : { order: "asc" as const }),
      })
      messages.push(...page.data)
      cursor = page.data.length ? (page.cursor.next ?? undefined) : undefined
    } while (cursor)
    return messages
  }
  const receipt = async (item: Occurrence) => {
    if (!(await session(item.sessionID))) return { state: "absent" as const }
    const messages = await history(item.sessionID)
    const index = messages.findIndex((message) => message.id === item.promptID && message.type === "user")
    if (index < 0) {
      const inbox = await client.session.inbox.list({ sessionID: item.sessionID })
      return { state: inbox.some((entry) => entry.id === item.promptID) ? ("admitted" as const) : ("absent" as const) }
    }
    // V2 assistants have no parentID. Bound the result by the next user input.
    const tail = messages.slice(index + 1)
    const next = tail.findIndex((message) => message.type === "user")
    const turn = next < 0 ? tail : tail.slice(0, next)
    const assistant = turn.findLast((message) => message.type === "assistant")
    const completed =
      assistant?.type === "assistant" &&
      !assistant.error &&
      !!assistant.time.completed &&
      assistant.finish === "stop" &&
      !assistant.content.some((part) => part.type === "tool" && part.state.status !== "completed")
    return { state: completed ? ("completed" as const) : ("uncertain" as const), assistantID: assistant?.id }
  }
  const scheduler: Scheduler = await new Scheduler(path.join(Global.Path.data, "scheduling/schedules.json"), {
    normalize: async (definition) => {
      if (definition.target.type === "existing_session") {
        const row = await session(definition.target.sessionID)
        if (!row) throw new Error("Target session does not exist on this local server")
        return { definition, directory: row.location.directory }
      }
      const target = definition.target
      if (!(await stat(target.directory)).isDirectory()) throw new Error("Target is not a directory")
      if (target.workspace.type === "worktree")
        await git("git", [
          "-C",
          target.directory,
          "rev-parse",
          "--verify",
          "--end-of-options",
          target.workspace.baseRef + "^{commit}",
        ])
      const location = { directory: target.directory }
      const resolved = await client
        .rpc(scheduleRuntimeRpc)
        .defaults({ agent: target.agent, model: target.model }, { location })
      return {
        definition: Definition.parse({ ...definition, target: { ...target, ...resolved } }),
        directory: target.directory,
      }
    },
    authenticate: async (item) => {
      const row = item.definition.target.type === "existing_session" ? await session(item.sessionID) : undefined
      const model =
        item.definition.target.type === "new_session"
          ? item.definition.target.model
          : (row?.model ??
            (
              await client
                .rpc(scheduleRuntimeRpc)
                .defaults({ agent: row?.agent }, { location: { directory: item.directory } })
            ).model)
      if (model?.providerID !== "cookiemonster") return true
      const response = await fetch(bridge() + "/bridge/auth", { signal: AbortSignal.timeout(15000) }).catch(
        () => undefined,
      )
      if (!response?.ok) return false
      const state: unknown = await response.json()
      return !!state && typeof state === "object" && "status" in state && state.status === "signed-in"
    },
    requestLogin: async () => {
      const response = await fetch(bridge() + "/bridge/login", { method: "POST", signal: AbortSignal.timeout(15000) })
      if (!response.ok) throw new Error("Could not open WPP sign-in")
    },
    reconcile: async (item) => (await receipt(item)).state,
    execute: async (item, authorize, persist) => {
      const target = item.definition.target
      if (target.type === "new_session" && target.workspace.type === "worktree")
        await prepareWorktree(
          item,
          path.join(Global.Path.data, "scheduled-worktrees"),
          (await scheduler.list()).occurrences.filter((value) => value.worktree).length,
          persist,
        )
      const row = await session(item.sessionID)
      if (target.type === "new_session" && row && row.metadata?.scheduleOccurrence !== item.id)
        throw new Error("Session ownership does not match this occurrence")
      if (target.type === "new_session" && !row)
        await client.session.create({
          id: item.sessionID,
          location: { directory: item.directory! },
          title: item.definition.name,
          agent: target.agent,
          model: target.model,
          metadata: { scheduleOccurrence: item.id, scheduleID: item.scheduleID },
        })
      if ((await client.session.active())[item.sessionID])
        throw new Busy("Waiting for the target session to become idle")
      const prompt = {
        sessionID: item.sessionID,
        id: item.promptID,
        delivery: "queue" as const,
        text: `Scheduled task ${item.scheduleID} (occurrence ${item.id}).\n${item.definition.prompt}`,
      }
      // Persist admission without waking. Only a committed occurrence may schedule provider work.
      if (
        !(await authorize(async () => {
          await client.session.prompt({ ...prompt, resume: false })
        }))
      )
        return { state: "cancelled" }
      await client.session.prompt(prompt)
      await client.experimental.session.wait({ sessionID: item.sessionID })
      const result = await receipt(item)
      return {
        state: result.state === "completed" ? "completed" : "attention",
        assistantID: result.assistantID,
        detail:
          result.state === "completed"
            ? undefined
            : "Execution stopped, failed, or was steered by new input; review the session",
      }
    },
    notify,
  }).open()
  return scheduler
}

export async function manageSchedule(
  scheduler: Scheduler,
  input: { action: string; id?: string; definition?: unknown },
) {
  if (input.action === "list") {
    const state = await scheduler.list()
    return { ...state, occurrences: state.occurrences.slice(-100), totalOccurrences: state.occurrences.length }
  }
  if (input.action === "create") return scheduler.put(input.definition)
  if (!input.id) throw new Error("Schedule id is required")
  if (input.action === "update") return scheduler.put(input.definition, input.id)
  if (input.action === "acknowledge") return scheduler.acknowledge(input.id)
  if (input.action === "delete") {
    await scheduler.remove(input.id)
    return { deleted: input.id }
  }
  if (input.action === "pause" || input.action === "resume") return scheduler.pause(input.id, input.action === "resume")
  throw new Error("Unknown schedule action")
}
