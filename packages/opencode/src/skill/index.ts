import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import path from "path"
import { Effect, Layer, Context, Schema, Semaphore } from "effect"
import { NamedError } from "@opencode-ai/core/util/error"
import type { Agent } from "@/agent/agent"
import { EventV2Bridge } from "@/event-v2-bridge"
import { InstanceState } from "@/effect/instance-state"
import { Global } from "@opencode-ai/core/global"
import { SkillPlugin } from "@opencode-ai/core/plugin/skill"
import { Permission } from "@/permission"
import { FSUtil } from "@opencode-ai/core/fs-util"
import { Config } from "@/config/config"
import { FrontmatterError } from "@opencode-ai/core/v1/config/error"
import { ConfigMarkdown } from "@/config/markdown"
import { RuntimeFlags } from "@/effect/runtime-flags"
import { Glob } from "@opencode-ai/core/util/glob"
import { Discovery } from "./discovery"
import { isRecord } from "@/util/record"
import { escapeHtml } from "@/util/html"
import { ManagedSkill } from "./managed"
import { Flag } from "@opencode-ai/core/flag/flag"
import { randomBytes } from "node:crypto"

const CLAUDE_EXTERNAL_DIR = ".claude"
const AGENTS_EXTERNAL_DIR = ".agents"
const EXTERNAL_SKILL_PATTERN = "skills/**/SKILL.md"
const OPENCODE_SKILL_PATTERN = "{skill,skills}/**/SKILL.md"
const SKILL_PATTERN = "**/SKILL.md"

// Built-in skill that ships with opencode. The model's intuition for what an
// opencode.json should look like is often wrong, and opencode hard-fails on
// invalid config, so users hit cryptic startup errors. Loading this skill
// when the model is asked to touch opencode's own config files gives it the
// actual schemas instead of guesses.
const CUSTOMIZE_OPENCODE_SKILL_NAME = "customize-opencode"
const CUSTOMIZE_OPENCODE_SKILL_DESCRIPTION =
  "Use ONLY when the user is editing or creating opencode's own configuration: opencode.json, opencode.jsonc, files under .opencode/, or files under ~/.config/opencode/. Also use when creating or fixing opencode agents, subagents, skills, plugins, MCP servers, or permission rules. Do not use for the user's own application code, or for any project that is not configuring opencode itself."
const CUSTOMIZE_OPENCODE_SKILL_BODY = SkillPlugin.CustomizeOpencodeContent

export const Info = Schema.Struct({
  name: Schema.String,
  description: Schema.optional(Schema.String),
  location: Schema.String,
  content: Schema.String,
})
export type Info = Schema.Schema.Type<typeof Info>

const Issue = Schema.StructWithRest(
  Schema.Struct({
    message: Schema.String,
    path: Schema.Array(Schema.String),
  }),
  [Schema.Record(Schema.String, Schema.Unknown)],
)

function isSkillFrontmatter(data: unknown): data is { name: string; description?: string } {
  return (
    isRecord(data) &&
    typeof data.name === "string" &&
    (data.description === undefined || typeof data.description === "string")
  )
}

export class InvalidError extends Schema.TaggedErrorClass<InvalidError>()("SkillInvalidError", {
  path: Schema.String,
  message: Schema.optional(Schema.String),
  issues: Schema.optional(Schema.Array(Issue)),
}) {}

export class NameMismatchError extends Schema.TaggedErrorClass<NameMismatchError>()("SkillNameMismatchError", {
  path: Schema.String,
  expected: Schema.String,
  actual: Schema.String,
}) {}

export class NotFoundError extends Schema.TaggedErrorClass<NotFoundError>()("Skill.NotFoundError", {
  name: Schema.String,
  available: Schema.Array(Schema.String),
}) {
  override get message() {
    return `Skill "${this.name}" not found. Available skills: ${this.available.join(", ") || "none"}`
  }
}

type State = {
  skills: Record<string, Info>
  dirs: Set<string>
}

type DiscoveryState = {
  matches: string[]
  dirs: string[]
}

type ScanState = {
  matches: Set<string>
  dirs: Set<string>
}

export interface Interface {
  readonly manage: (input: ManagedSkill.Manage) => Effect.Effect<typeof ManagedSkill.Managed.Type, ManagedSkill.Error>
  readonly get: (name: string) => Effect.Effect<Info | undefined>
  readonly require: (name: string) => Effect.Effect<Info, NotFoundError>
  readonly all: () => Effect.Effect<Info[]>
  readonly dirs: () => Effect.Effect<string[]>
  readonly available: (agent?: Agent.Info) => Effect.Effect<Info[]>
  readonly catalog: () => Effect.Effect<ManagedSkill.Metadata[], ManagedSkill.Error>
  readonly resolve: (
    selected: ManagedSkill.Selection,
  ) => Effect.Effect<Info & ManagedSkill.Metadata, ManagedSkill.Error>
  readonly review: (draft: ManagedSkill.Draft) => Effect.Effect<typeof ManagedSkill.Review.Type, ManagedSkill.Error>
  readonly create: (
    input: ManagedSkill.Draft & { token: string },
  ) => Effect.Effect<typeof ManagedSkill.Receipt.Type, ManagedSkill.Error>
}

const add = Effect.fnUntraced(function* (state: State, match: string, events: EventV2Bridge.Service["Service"]) {
  const md = yield* Effect.tryPromise({
    try: () => ConfigMarkdown.parse(match),
    catch: (err) => err,
  }).pipe(
    Effect.catch(
      Effect.fnUntraced(function* (err) {
        const message = FrontmatterError.isInstance(err) ? err.data.message : `Failed to parse skill ${match}`
        const { Session } = yield* Effect.promise(() => import("@/session/session"))
        yield* events.publish(Session.Event.Error, { error: new NamedError.Unknown({ message }).toObject() })
        yield* Effect.logError("failed to load skill", { skill: match, error: err })
        return undefined
      }),
    ),
  )

  if (!md) return

  if (!isSkillFrontmatter(md.data)) return

  if (state.skills[md.data.name]) {
    yield* Effect.logWarning("duplicate skill name", {
      name: md.data.name,
      existing: state.skills[md.data.name].location,
      duplicate: match,
    })
  }

  state.dirs.add(path.dirname(match))
  state.skills[md.data.name] = {
    name: md.data.name,
    description: md.data.description,
    location: match,
    content: md.content,
  }
})

const scan = Effect.fnUntraced(function* (
  state: ScanState,
  root: string,
  pattern: string,
  opts?: { dot?: boolean; scope?: string },
) {
  const matches = yield* Effect.tryPromise({
    try: () =>
      Glob.scan(pattern, {
        cwd: root,
        absolute: true,
        include: "file",
        symlink: true,
        dot: opts?.dot,
      }),
    catch: (error) => error,
  }).pipe(
    Effect.catch((error) => {
      if (!opts?.scope) return Effect.die(error)
      return Effect.logError(`failed to scan ${opts.scope} skills`, { dir: root, error: error }).pipe(
        Effect.as([] as string[]),
      )
    }),
  )

  for (const match of matches) {
    state.matches.add(match)
    state.dirs.add(path.dirname(match))
  }
})

const discoverSkills = Effect.fnUntraced(function* (
  config: Config.Interface,
  discovery: Discovery.Interface,
  fsys: FSUtil.Interface,
  global: Global.Interface,
  disableExternalSkills: boolean,
  disableClaudeCodeSkills: boolean,
  directory: string,
  worktree: string,
) {
  const state: ScanState = { matches: new Set(), dirs: new Set() }

  const externalDirs: string[] = []
  if (!disableExternalSkills) {
    if (!disableClaudeCodeSkills) externalDirs.push(CLAUDE_EXTERNAL_DIR)
    externalDirs.push(AGENTS_EXTERNAL_DIR)

    for (const dir of externalDirs) {
      const root = path.join(global.home, dir)
      if (!(yield* fsys.isDir(root))) continue
      yield* scan(state, root, EXTERNAL_SKILL_PATTERN, { dot: true, scope: "global" })
    }

    const upDirs = yield* fsys
      .up({ targets: externalDirs, start: directory, stop: worktree })
      .pipe(Effect.catch(() => Effect.succeed([] as string[])))

    for (const root of upDirs) {
      yield* scan(state, root, EXTERNAL_SKILL_PATTERN, { dot: true, scope: "project" })
    }
  }

  const configDirs = yield* config.directories()
  for (const dir of configDirs) {
    yield* scan(state, dir, OPENCODE_SKILL_PATTERN)
  }

  const cfg = yield* config.get()
  for (const item of cfg.skills?.paths ?? []) {
    const expanded = item.startsWith("~/") ? path.join(global.home, item.slice(2)) : item
    const dir = path.isAbsolute(expanded) ? expanded : path.join(directory, expanded)
    if (!(yield* fsys.isDir(dir))) {
      yield* Effect.logWarning("skill path not found", { path: dir })
      continue
    }

    yield* scan(state, dir, SKILL_PATTERN)
  }

  for (const url of cfg.skills?.urls ?? []) {
    const pulledDirs = yield* discovery.pull(url)
    for (const dir of pulledDirs) {
      yield* scan(state, dir, SKILL_PATTERN)
    }
  }

  return {
    matches: Array.from(state.matches),
    dirs: Array.from(state.dirs),
  }
})

const loadSkills = Effect.fnUntraced(function* (
  state: State,
  discovered: DiscoveryState,
  events: EventV2Bridge.Service["Service"],
) {
  yield* Effect.forEach(discovered.matches, (match) => add(state, match, events), {
    concurrency: "unbounded",
    discard: true,
  })

  yield* Effect.logInfo("init", { count: Object.keys(state.skills).length })
})

export class Service extends Context.Service<Service, Interface>()("@opencode/Skill") {}

const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const discovery = yield* Discovery.Service
    const config = yield* Config.Service
    const events = yield* EventV2Bridge.Service
    const fsys = yield* FSUtil.Service
    const global = yield* Global.Service
    const flags = yield* RuntimeFlags.Service
    const discovered = yield* InstanceState.make(
      Effect.fn("Skill.discovery")(function* (ctx) {
        return yield* discoverSkills(
          config,
          discovery,
          fsys,
          global,
          flags.disableExternalSkills,
          flags.disableClaudeCodeSkills,
          ctx.directory,
          ctx.worktree,
        )
      }),
    )
    const state = yield* InstanceState.make(
      Effect.fn("Skill.state")(function* () {
        const s: State = { skills: {}, dirs: new Set() }
        // Register the built-in skill BEFORE disk discovery so a user-disk
        // skill with the same name can override it.
        s.skills[CUSTOMIZE_OPENCODE_SKILL_NAME] = {
          name: CUSTOMIZE_OPENCODE_SKILL_NAME,
          description: CUSTOMIZE_OPENCODE_SKILL_DESCRIPTION,
          location: "<built-in>",
          content: CUSTOMIZE_OPENCODE_SKILL_BODY,
        }
        yield* loadSkills(s, yield* InstanceState.get(discovered), events)
        return s
      }),
    )

    const managedError = (error: unknown) =>
      new ManagedSkill.Error({
        message: error instanceof Error ? error.message : String(error),
      })
    const fresh = Effect.fn("Skill.fresh")(function* () {
      const ctx = yield* InstanceState.context
      const found = yield* discoverSkills(
        config,
        discovery,
        fsys,
        global,
        flags.disableExternalSkills,
        flags.disableClaudeCodeSkills,
        ctx.directory,
        ctx.worktree,
      )
      // Config's directory list is cached before a first .opencode directory
      // exists. Discover these roots afresh without disposing the AE instance.
      const extra: ScanState = { matches: new Set(found.matches), dirs: new Set(found.dirs) }
      if (!Flag.OPENCODE_DISABLE_PROJECT_CONFIG) {
        const roots = yield* fsys
          .up({ targets: [".opencode"], start: ctx.directory, stop: ctx.worktree })
          .pipe(Effect.orDie)
        for (const root of roots) yield* scan(extra, root, OPENCODE_SKILL_PATTERN)
      }
      yield* scan(extra, global.config, OPENCODE_SKILL_PATTERN, { scope: "global" })
      const list = yield* Effect.forEach([...extra.matches].sort(), (location) =>
        Effect.tryPromise({ try: () => ManagedSkill.snapshot(location), catch: managedError }).pipe(
          Effect.catch(() => Effect.succeed(undefined)),
        ),
      )
      const builtin = {
        name: CUSTOMIZE_OPENCODE_SKILL_NAME,
        description: CUSTOMIZE_OPENCODE_SKILL_DESCRIPTION,
        location: "<built-in>",
        content: CUSTOMIZE_OPENCODE_SKILL_BODY,
        source: ManagedSkill.digest("builtin:customize-opencode"),
        revision: ManagedSkill.digest(CUSTOMIZE_OPENCODE_SKILL_BODY),
      }
      const disk = list.filter((item) => item !== undefined)
      return disk.some((item) => item.name === builtin.name) ? disk : [...disk, builtin]
    })
    const catalog = Effect.fn("Skill.catalog")(function* () {
      return (yield* fresh()).map(({ name, description, source, revision }) => ({
        name,
        description,
        source,
        revision,
      }))
    })
    const resolve = Effect.fn("Skill.resolve")(function* (selected: ManagedSkill.Selection) {
      const list = (yield* fresh()).filter((item) => item.name === selected.name)
      if (list.length !== 1 || list[0].source !== selected.source || list[0].revision !== selected.revision)
        return yield* new ManagedSkill.Error({
          message: "Skill is missing, changed or has a duplicate name. Refresh and select it again.",
        })
      return list[0]
    })
    const reviews = new Map<string, { digest: string; expires: number }>()
    const destination = Effect.fn("Skill.destination")(function* (draft: ManagedSkill.Draft) {
      yield* Effect.try({ try: () => ManagedSkill.validate(draft), catch: managedError })
      if (draft.scope === "workspace" && Flag.OPENCODE_DISABLE_PROJECT_CONFIG)
        return yield* new ManagedSkill.Error({ message: "Workspace skill storage is disabled by CM configuration." })
      const directory = yield* InstanceState.directory
      const root = path.join(draft.scope === "workspace" ? path.join(directory, ".opencode") : global.config, "skills")
      return { directory, root, destination: path.join(root, draft.name, "SKILL.md") }
    })
    const review = Effect.fn("Skill.review")(function* (draft: ManagedSkill.Draft) {
      const target = yield* destination(draft)
      if ((yield* fresh()).some((item) => item.name.toLowerCase() === draft.name.toLowerCase()))
        return yield* new ManagedSkill.Error({ message: "A skill with this name already exists. Choose another name." })
      for (const [token, value] of reviews) if (value.expires < Date.now()) reviews.delete(token)
      if (reviews.size >= 1000) return yield* new ManagedSkill.Error({ message: "Too many pending reviews." })
      const token = randomBytes(32).toString("hex")
      reviews.set(token, { digest: ManagedSkill.digest([target, draft]), expires: Date.now() + 600000 })
      return {
        token,
        digest: ManagedSkill.digest([target, draft]),
        directory: target.directory,
        destination: target.destination,
        scope: draft.scope,
      }
    })
    const saveLock = Semaphore.makeUnsafe(1)
    const create = Effect.fn("Skill.create")(function* (input: ManagedSkill.Draft & { token: string }) {
      const { token, ...draft } = input
      const saved = reviews.get(token)
      reviews.delete(token)
      const target = yield* destination(draft)
      if (!saved || saved.expires < Date.now() || saved.digest !== ManagedSkill.digest([target, draft]))
        return yield* new ManagedSkill.Error({
          message: "Review expired, was used, or does not match this exact content and workspace. Review again.",
        })
      if ((yield* fresh()).some((item) => item.name.toLowerCase() === draft.name.toLowerCase()))
        return yield* new ManagedSkill.Error({
          message: "A skill with this name already exists. Nothing was overwritten.",
        })
      const info = yield* Effect.tryPromise({ try: () => ManagedSkill.create(target.root, draft), catch: managedError })
      yield* resolve(info)
      return {
        name: info.name,
        description: info.description,
        source: info.source,
        revision: info.revision,
        directory: target.directory,
        destination: target.destination,
        scope: draft.scope,
        digest: saved.digest,
      }
    })

    const management = new Map<string, { digest: string; expires: number }>()
    const manage = Effect.fn("Skill.manage")(function* (input: ManagedSkill.Manage) {
      const info = yield* resolve(input.selected)
      const workspace = yield* InstanceState.directory
      const roots = {
        workspace: path.join(workspace, ".opencode", "skills"),
        global: path.join(global.config, "skills"),
      }
      const parent = path.dirname(path.dirname(info.location))
      const scope =
        parent === roots.workspace
          ? ("workspace" as const)
          : parent === roots.global
            ? ("global" as const)
            : ("external" as const)
      const editable = scope !== "external" && !(scope === "workspace" && Flag.OPENCODE_DISABLE_PROJECT_CONFIG)
      const value = {
        name: info.name,
        description: info.description,
        source: info.source,
        revision: info.revision,
        content: info.content,
        document: "text" in info && typeof info.text === "string" ? info.text : info.content,
        location: info.location,
        editable,
        scope,
      }
      if (input.action === "read") return value
      if (!editable || !input.operation)
        return yield* new ManagedSkill.Error({
          message: "This skill is read-only. Copy it into a managed skill to edit it.",
        })
      if (input.operation === "edit") {
        if (!input.draft || input.draft.scope !== scope)
          return yield* new ManagedSkill.Error({ message: "Keep the existing skill scope when editing." })
        yield* Effect.try({ try: () => ManagedSkill.validate(input.draft!), catch: managedError })
        if (
          (yield* fresh()).some(
            (item) => item.source !== info.source && item.name.toLowerCase() === input.draft!.name.toLowerCase(),
          )
        )
          return yield* new ManagedSkill.Error({ message: "Another skill already uses that name." })
      } else if (input.draft)
        return yield* new ManagedSkill.Error({ message: "Deletion does not accept replacement content." })
      yield* Effect.tryPromise({ try: () => ManagedSkill.directory(path.dirname(info.location)), catch: managedError })
      const digest = ManagedSkill.digest([
        workspace,
        info.location,
        input.selected,
        input.operation,
        input.draft || null,
      ])
      if (input.action === "review") {
        for (const [token, review] of management) if (review.expires < Date.now()) management.delete(token)
        if (management.size >= 1000)
          return yield* new ManagedSkill.Error({ message: "Too many pending skill reviews." })
        const token = randomBytes(32).toString("hex")
        management.set(token, { digest, expires: Date.now() + 600000 })
        return { ...value, token, digest }
      }
      const review = management.get(input.token || "")
      management.delete(input.token || "")
      if (!review || review.digest !== digest || review.expires < Date.now())
        return yield* new ManagedSkill.Error({
          message: "Review is expired, changed or already used. Refresh before reviewing again.",
        })
      const result = yield* Effect.tryPromise({
        try: () => ManagedSkill.change(info.location, input.selected, input.draft),
        catch: managedError,
      })
      return {
        ...value,
        ...(result.updated
          ? {
              name: result.updated.name,
              description: result.updated.description,
              content: result.updated.content,
              document: result.updated.text,
              source: result.updated.source,
              revision: result.updated.revision,
            }
          : {}),
        backup: result.backup,
        deleted: result.deleted,
        digest,
      }
    })

    const get = Effect.fn("Skill.get")(function* (name: string) {
      const s = yield* InstanceState.get(state)
      return s.skills[name]
    })

    const require = Effect.fn("Skill.require")(function* (name: string) {
      const list = yield* fresh()
      const info = list.find((item) => item.name === name)
      if (info) return info
      return yield* new NotFoundError({ name, available: list.map((item) => item.name).toSorted() })
    })

    const all = Effect.fn("Skill.all")(function* () {
      const s = yield* InstanceState.get(state)
      return Object.values(s.skills)
    })

    const dirs = Effect.fn("Skill.dirs")(function* () {
      return (yield* InstanceState.get(discovered)).dirs
    })

    const available = Effect.fn("Skill.available")(function* (agent?: Agent.Info) {
      const list = (yield* fresh()).toSorted((a, b) => a.name.localeCompare(b.name))
      if (!agent) return list
      return list.filter((skill) => Permission.evaluate("skill", skill.name, agent.permission).action !== "deny")
    })

    return Service.of({
      manage: (input) => saveLock.withPermits(1)(manage(input)),
      get,
      require,
      all,
      dirs,
      available,
      catalog,
      resolve,
      review,
      create: (input) => saveLock.withPermits(1)(create(input)),
    })
  }),
)

export function fmt(list: Info[], opts: { verbose: boolean }) {
  const described = list.filter((skill) => skill.description !== undefined)
  if (described.length === 0) return "No skills are currently available."
  if (opts.verbose) {
    return [
      "<available_skills>",
      ...described
        .toSorted((a, b) => a.name.localeCompare(b.name))
        .flatMap((skill) => [
          "  <skill>",
          `    <name>${skill.name}</name>`,
          `    <description>${skill.description}</description>`,
          `    <location>${escapeHtml(skill.location)}</location>`,
          "  </skill>",
        ]),
      "</available_skills>",
    ].join("\n")
  }

  return [
    "## Available Skills",
    ...described
      .toSorted((a, b) => a.name.localeCompare(b.name))
      .map((skill) => `- **${skill.name}**: ${skill.description}`),
  ].join("\n")
}

export const node = LayerNode.make({
  service: Service,
  layer: layer,
  deps: [Discovery.node, Config.node, EventV2Bridge.node, FSUtil.node, Global.node, RuntimeFlags.node],
})

export * as Skill from "."
