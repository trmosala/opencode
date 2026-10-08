import { mkdir, open, readFile, rename, rm, writeFile } from "node:fs/promises"
import path from "node:path"
import { randomUUID } from "node:crypto"
import { setTimeout } from "node:timers/promises"
import z from "zod"
import { Definition, epoch, latest, next } from "./definition"
import { Identifier } from "../id/id"

const Occurrence = z.object({
  id: z.string(),
  scheduleID: z.string(),
  revision: z.number().int(),
  at: z.number().int(),
  definition: Definition,
  sessionID: z.string(),
  promptID: z.string(),
  directory: z.string().optional(),
  baseCommit: z.string().optional(),
  worktree: z.string().optional(),
  state: z.enum(["pending", "awaiting_auth", "dispatching", "running", "completed", "attention", "skipped"]),
  admitted: z.boolean().default(false),
  detail: z.string().optional(),
  assistantID: z.string().optional(),
  loginRequested: z.boolean().default(false),
})
export type Occurrence = z.output<typeof Occurrence>
const Saved = z.object({
  id: z.string(),
  revision: z.number().int(),
  definition: Definition,
  directory: z.string(),
  next: z.number().int().optional(),
  runs: z.number().int(),
  deleted: z.boolean().default(false),
})
export type Saved = z.output<typeof Saved>
export const State = z
  .object({ version: z.literal(1), schedules: z.array(Saved), occurrences: z.array(Occurrence) })
  .strict()

export interface Adapter {
  normalize(definition: Definition): Promise<{ definition: Definition; directory: string }>
  authenticate(occurrence: Occurrence): Promise<boolean>
  requestLogin(): Promise<void>
  reconcile(occurrence: Occurrence): Promise<"absent" | "admitted" | "completed" | "uncertain">
  execute(
    occurrence: Occurrence,
    admitted: () => Promise<void>,
    persist: () => Promise<void>,
  ): Promise<{ state: "completed" | "attention"; detail?: string; assistantID?: string }>
  notify(occurrence: Occurrence): Promise<void>
}

const unfinished = (item: Occurrence) => !["completed", "skipped"].includes(item.state)

/** One process owns the file. Admission and execution remain outside the serialized
 * state mutations so a running model can pause its own schedule through the tool. */
export class Scheduler {
  private data: z.output<typeof State> = { version: 1, schedules: [], occurrences: [] }
  private chain: Promise<unknown> = Promise.resolve()
  private timer?: ReturnType<typeof setInterval>
  private ticking = false
  private active = new Set<string>()
  private closed = false
  private release?: Promise<void>

  private releaseLock() {
    this.release ??= rm(this.file + ".lock", { recursive: true })
    return this.release
  }

  constructor(
    readonly file: string,
    readonly adapter: Adapter,
    readonly now = Date.now,
  ) {}

  private serialize<A>(fn: () => Promise<A>): Promise<A> {
    const result = this.chain.then(fn)
    this.chain = result.catch(() => undefined)
    return result
  }

  async open() {
    await mkdir(path.dirname(this.file), { recursive: true })
    const lock = this.file + ".lock"
    await mkdir(lock).catch(async (error: NodeJS.ErrnoException) => {
      if (error.code !== "EEXIST") throw error
      const owner = Number(await readFile(path.join(lock, "owner"), "utf8").catch(() => "0"))
      // A missing owner is ambiguous. Never steal from a live process.
      if (!owner) throw new Error("Scheduler lock has no owner; manual recovery required")
      const alive = (() => {
        try {
          process.kill(owner, 0)
          return true
        } catch (failure) {
          if (failure instanceof Error && "code" in failure && failure.code === "ESRCH") return false
          throw failure
        }
      })()
      if (alive) throw new Error("Another scheduler already owns this store")
      await rm(lock, { recursive: true })
      await mkdir(lock)
    })
    await writeFile(path.join(lock, "owner"), String(process.pid), { mode: 0o600 })
    try {
      const content = await readFile(this.file, "utf8").catch((error: NodeJS.ErrnoException) => {
        if (error.code === "ENOENT") return undefined
        throw error
      })
      if (content) this.data = State.parse(JSON.parse(content))
      for (const occurrence of this.data.occurrences.filter(
        (value) => value.state === "running" || value.state === "dispatching",
      )) {
        const receipt = await this.adapter.reconcile(occurrence)
        if (receipt !== "absent" && !occurrence.admitted) {
          occurrence.admitted = true
          const saved = this.data.schedules.find((value) => value.id === occurrence.scheduleID)
          if (saved) saved.runs++
        }
        occurrence.state = receipt === "completed" ? "completed" : receipt === "absent" ? "pending" : "attention"
        occurrence.detail =
          receipt === "absent" ? undefined : "Recovered execution requires review; provider work will not be replayed"
      }
      await this.save()
    } catch (error) {
      await rm(lock, { recursive: true })
      throw error
    }
    return this
  }

  private async save() {
    const temporary = this.file + "." + randomUUID() + ".tmp"
    const handle = await open(temporary, "wx", 0o600)
    try {
      await handle.writeFile(JSON.stringify(this.data))
      await handle.sync()
    } finally {
      await handle.close()
    }
    // Windows can briefly deny replacement while an indexer has the destination
    // open. Retry only this atomic file operation, never admission/provider work.
    for (let attempt = 0; ; attempt++) {
      try {
        await rename(temporary, this.file)
        return
      } catch (error) {
        if (
          attempt >= 4 ||
          !(error instanceof Error) ||
          !("code" in error) ||
          !["EPERM", "EBUSY", "EACCES"].includes(String(error.code))
        )
          throw error
        await setTimeout(25 * 2 ** attempt)
      }
    }
  }

  async list() {
    await this.chain
    return structuredClone(this.data)
  }

  async put(value: unknown, id?: string) {
    const parsed = Definition.parse(value)
    const resolved = await this.adapter.normalize(parsed)
    const definition = Definition.parse(resolved.definition)
    const now = this.now()
    if (!id && definition.schedule.type === "once" && epoch(definition.schedule.at) <= now)
      throw new Error("One-time schedule must be in the future")
    const following = next(definition, now)
    if (following === undefined) throw new Error("No future occurrence before endsAt")
    return this.serialize(async () => {
      if (this.closed) throw new Error("Scheduler is stopped")
      const previous = id ? this.data.schedules.find((item) => item.id === id && !item.deleted) : undefined
      if (id && !previous) throw new Error("Schedule not found")
      const saved: Saved = {
        id: previous?.id ?? "sch_" + randomUUID(),
        revision: (previous?.revision ?? 0) + 1,
        definition,
        directory: resolved.directory,
        next: following,
        runs: previous?.runs ?? 0,
        deleted: false,
      }
      if (previous) Object.assign(previous, saved)
      if (!previous) this.data.schedules.push(saved)
      await this.save()
      return structuredClone(saved)
    })
  }

  async pause(id: string, enabled = false) {
    return this.serialize(async () => {
      if (this.closed) throw new Error("Scheduler is stopped")
      const saved = this.data.schedules.find((item) => item.id === id && !item.deleted)
      if (!saved) throw new Error("Schedule not found")
      saved.definition.enabled = enabled
      saved.revision++
      await this.save()
      return structuredClone(saved)
    })
  }

  async remove(id: string) {
    await this.serialize(async () => {
      if (this.closed) throw new Error("Scheduler is stopped")
      const saved = this.data.schedules.find((item) => item.id === id && !item.deleted)
      if (!saved) throw new Error("Schedule not found")
      saved.deleted = true
      saved.definition.enabled = false
      await this.save()
    })
  }

  async acknowledge(id: string) {
    return this.serialize(async () => {
      if (this.closed) throw new Error("Scheduler is stopped")
      const item = this.data.occurrences.find((value) => value.id === id && value.state === "attention")
      if (!item) throw new Error("Occurrence requiring attention not found")
      item.state = "skipped"
      item.detail = "Acknowledged after review; execution was not replayed"
      await this.save()
      return structuredClone(item)
    })
  }

  start() {
    this.timer ??= setInterval(() => void this.tick().catch(() => undefined), 1000)
    this.timer.unref()
    void this.tick().catch(() => undefined)
  }

  async close() {
    if (this.closed) return
    this.closed = true
    clearInterval(this.timer)
    // Active execution is not automatically retried after this process exits.
    await this.chain
    if (this.active.size === 0) await this.releaseLock()
  }

  async tick() {
    if (this.closed || this.ticking) return
    this.ticking = true
    try {
      const waiting = await this.serialize(async () => {
        const now = this.now()
        const dueSchedules = this.data.schedules.filter(
          (saved) => saved.definition.enabled && !saved.deleted && saved.next !== undefined && saved.next <= now,
        )
        for (const saved of dueSchedules) {
          const due = latest(saved.definition, saved.next!, now)
          const blocked = this.data.occurrences.some((item) => item.scheduleID === saved.id && unfinished(item))
          const exhausted = saved.definition.maxRuns !== undefined && saved.runs >= saved.definition.maxRuns
          const expired = saved.definition.endsAt !== undefined && now >= epoch(saved.definition.endsAt)
          saved.next = exhausted || expired ? undefined : due.following
          // The one-second tick tolerance distinguishes an ordinary due tick from a missed run.
          const missed = now - due.at > 2000
          const skip =
            blocked ||
            exhausted ||
            expired ||
            (missed &&
              (saved.definition.misfire.type === "skip" ||
                now - due.at > saved.definition.misfire.withinMinutes * 60000))
          if (blocked || exhausted || expired) continue
          this.data.occurrences.push({
            id: "occ_" + randomUUID(),
            scheduleID: saved.id,
            revision: saved.revision,
            at: due.at,
            definition: structuredClone(saved.definition),
            sessionID:
              saved.definition.target.type === "existing_session"
                ? saved.definition.target.sessionID
                : Identifier.descending("session"),
            promptID: Identifier.ascending("message"),
            directory: saved.directory,
            state: skip ? "skipped" : "pending",
            admitted: false,
            loginRequested: false,
          })
        }
        if (dueSchedules.length) await this.save()
        return this.data.occurrences.filter((item) => item.state === "pending" || item.state === "awaiting_auth")
      })
      // A long model run must not stop other schedules from becoming due.
      this.ticking = false
      await Promise.all(waiting.map((item) => this.dispatch(item)))
    } finally {
      this.ticking = false
    }
  }

  private async dispatch(item: Occurrence) {
    if (this.active.has(item.id) || this.closed) return
    const saved = this.data.schedules.find((value) => value.id === item.scheduleID)
    if (!saved || saved.deleted || !saved.definition.enabled) return
    if (saved.definition.endsAt && this.now() >= epoch(saved.definition.endsAt)) {
      await this.serialize(async () => {
        item.state = "skipped"
        item.detail = "Schedule ended before admission"
        await this.save()
      })
      return
    }
    this.active.add(item.id)
    try {
      if (!(await this.adapter.authenticate(item))) {
        const request = await this.serialize(async () => {
          const announce = item.state !== "awaiting_auth"
          item.state = "awaiting_auth"
          item.detail = "Waiting for WPP sign-in"
          const first = !item.loginRequested
          item.loginRequested = true
          await this.save()
          return { first, announce }
        })
        if (request.first) {
          await this.adapter.requestLogin().catch(async () => {
            await this.serialize(async () => {
              item.detail = "Waiting for WPP sign-in; the login window could not be opened"
              item.loginRequested = false
              await this.save()
            })
          })
        }
        if (request.announce) await this.adapter.notify(item).catch(() => undefined)
        return
      }
      const admitted = () =>
        this.serialize(async () => {
          if (!item.admitted) {
            item.admitted = true
            saved.runs++
          }
          item.state = "running"
          await this.save()
        })
      // Persist the uncertainty boundary before calling external admission. A restart
      // reconciles the exact IDs rather than blindly repeating the provider request.
      const allowed = await this.serialize(async () => {
        if (saved.deleted || !saved.definition.enabled || this.closed) return false
        item.state = "dispatching"
        item.loginRequested = false
        item.detail = undefined
        await this.save()
        return true
      })
      if (!allowed) return
      const result = await this.adapter.execute(item, admitted, () => this.serialize(() => this.save()))
      await this.serialize(async () => {
        Object.assign(item, result)
        await this.save()
      })
      if (item.state === "attention" || item.definition.notification === "all_runs")
        await this.adapter.notify(item).catch(() => undefined)
    } catch (error) {
      await this.serialize(async () => {
        // Busy means no admission took place and the next tick can safely try again.
        item.state = error instanceof Busy ? "pending" : "attention"
        item.detail = error instanceof Error ? error.message : String(error)
        await this.save()
      })
      if (item.state === "attention") await this.adapter.notify(item).catch(() => undefined)
    } finally {
      this.active.delete(item.id)
      if (this.closed && this.active.size === 0) await this.releaseLock()
    }
  }
}

export class Busy extends Error {}
