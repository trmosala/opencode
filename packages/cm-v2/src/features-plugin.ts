import type { Plugin } from "@opencode/plugin/promise/plugin"
import { Schema } from "effect"
import path from "node:path"
import { Global } from "@opencode/util/global"
import { Glob } from "@opencode/util/glob"
import { SkillFile } from "@opencode/core/config/plugin/skill-file"
import type { Registration } from "@opencode/plugin/promise/registration"
import { ManagedSkill } from "../../opencode/src/skill/managed"
import { Definition } from "../../opencode/src/schedule/definition"
import { featuresRpc, scheduleRuntimeRpc } from "./features-rpc"

export default {
  id: "cookiemonster.features",
  async setup(ctx) {
    const global =
      typeof ctx.options.configDirectory === "string"
        ? ctx.options.configDirectory
        : (process.env.OPENCODE_CONFIG_DIR ?? Global.Path.config)
    const roots = [global, ...(ctx.options.project === false ? [] : [path.join(ctx.location.directory, ".opencode")])]
    let transform: Registration | undefined
    let refreshing: Promise<unknown> = Promise.resolve()
    const load = async (external = true, selected: { name: string; source: string; revision: string }[] = []) => {
      const list = external ? (await ctx.skill.list()).data : []
      const files = [
        ...new Set([
          ...(
            await Promise.all(
              roots.map((root) =>
                Glob.scan("{skill,skills}/**/SKILL.md", { cwd: root, absolute: true, symlink: true }).catch(() => []),
              ),
            )
          ).flat(),
          ...list.filter((skill) => !skill.path.startsWith("/builtin/")).map((skill) => skill.path),
        ]),
      ]
      const managed = [
        ...new Map(
          (await Promise.all(files.map((file) => ManagedSkill.snapshot(file).catch(() => undefined))))
            .filter((skill) => skill !== undefined)
            .map((skill) => [skill.source, skill]),
        ).values(),
      ]
      const ordered = [...managed]
      for (const selection of selected) {
        if (
          list.some(
            (skill) =>
              skill.path.startsWith("/builtin/") &&
              skill.name === selection.name &&
              ManagedSkill.digest(["builtin", skill.id]) === selection.source &&
              ManagedSkill.digest(skill.content) === selection.revision,
          )
        )
          continue
        const matching = managed.filter((skill) => skill.name === selection.name)
        if (
          matching.length !== 1 ||
          matching[0].source !== selection.source ||
          matching[0].revision !== selection.revision
        )
          throw new Error("Skill changed. Refresh and select it again.")
        ordered.push(matching[0])
      }
      await transform?.dispose()
      // Register last: config transforms can be installed after initial plugin activation.
      transform = await ctx.skill.transform((editor) => {
        for (const skill of editor.list())
          if (
            roots.some((root) =>
              ["skill", "skills"].some((folder) => skill.path.startsWith(path.join(root, folder) + path.sep)),
            )
          )
            editor.remove(skill.id)
        for (const skill of ordered) {
          const parsed = SkillFile.parse(path.dirname(path.dirname(skill.location)), skill.location, skill.text)
          if (parsed._tag === "Parsed") editor.add(parsed.skill)
        }
      })
      await ctx.skill.reload()
      return {
        skills: [
          ...managed
            .map(({ description, ...skill }) => ({
              ...skill,
              ...(description === undefined ? {} : { description }),
              id: SkillFile.parse(path.dirname(path.dirname(skill.location)), skill.location, skill.text),
            }))
            .flatMap((skill) => (skill.id._tag === "Parsed" ? [{ ...skill, id: skill.id.skill.id }] : [])),
          ...list
            .filter((skill) => skill.path.startsWith("/builtin/"))
            .map((skill) => ({
              name: skill.name,
              ...(skill.description === undefined ? {} : { description: skill.description }),
              content: skill.content,
              text: skill.content,
              location: skill.path,
              source: ManagedSkill.digest(["builtin", skill.id]),
              revision: ManagedSkill.digest(skill.content),
              id: skill.id,
            })),
        ],
      }
    }
    const refresh = (external = true, selected?: { name: string; source: string; revision: string }[]) => {
      const result = refreshing.then(() => load(external, selected))
      refreshing = result.catch(() => undefined)
      return result
    }
    await refresh(false)
    await ctx.rpc.register(scheduleRuntimeRpc, {
      defaults: async (input) => {
        // The native list puts the selected default agent first, including plugin transforms.
        const agents = await ctx.agent.list()
        const agent = input.agent ? agents.data.find((agent) => agent.id === input.agent) : agents.data[0]
        if (!agent) throw new Error("Scheduled agent does not exist")
        let configured: { providerID: string; modelID: string } | undefined
        const inspect = await ctx.model.transform((editor) => {
          configured = editor.default.get()
        })
        const models = await ctx.model.list().finally(() => inspect.dispose())
        const fallback =
          models.data.find(
            (model) => model.enabled && model.providerID === configured?.providerID && model.id === configured.modelID,
          ) ??
          models.data.find(
            (model) =>
              model.enabled &&
              model.capabilities.input.some((type) => type.startsWith("text")) &&
              model.capabilities.output.some((type) => type.startsWith("text")),
          )
        const selected = input.model ?? agent.model ?? fallback
        if (!selected) throw new Error("No model is available for scheduled execution")
        const model = {
          providerID: selected.providerID,
          id: selected.id,
          ...("variant" in selected && selected.variant ? { variant: selected.variant } : {}),
        }
        if (
          !models.data.some(
            (available) =>
              available.enabled &&
              available.providerID === model.providerID &&
              available.id === model.id &&
              (!model.variant ||
                model.variant === "default" ||
                available.variants.some((variant) => variant.id === model.variant)),
          )
        )
          throw new Error("Scheduled model or variant does not exist")
        return { agent: agent.id, model }
      },
    })
    const rpc = await ctx.rpc.register(featuresRpc, {
      refresh: async (input) => refresh(true, input.selected),
      notify: async (input) => {
        await rpc.events.emit("schedule", input)
        return {}
      },
    })
    await ctx.tool.transform((editor) =>
      editor.add({
        name: "schedule",
        description:
          "Manage durable CookieMonster tasks while the desktop is running. Actions create/list/update/pause/resume/delete/acknowledge. Create/update requires schemaVersion=1, name, prompt, target={type:existing_session,sessionID}|{type:new_session,directory,workspace:{type:local}|{type:worktree,baseRef},agent?,model?:{providerID,id,variant?}}, schedule={type:once,at}|{type:interval,everyMinutes,startsAt}|{type:calendar,timezone,time:HH:mm,weekdays:[mon..sun]}, optional enabled, misfire={type:skip}|{type:catch_up_once,withinMinutes}, notification=all_runs|failures_only, maxRuns, endsAt. ISO timestamps require seconds and UTC offset. Existing-session tasks wait until idle. Creating a schedule grants no tool permissions. Attention runs need review before acknowledgement; never blindly replay them.",
        options: { codemode: false },
        input: Schema.Struct({
          action: Schema.Literals(["create", "list", "update", "pause", "resume", "delete", "acknowledge"]),
          id: Schema.optional(Schema.String),
          definition: Schema.optional(Schema.Unknown),
        }),
        execute: async (input, tool) => {
          if (input.action !== "list")
            await ctx.permission.assert({
              sessionID: tool.sessionID,
              agent: tool.agent,
              action: "schedule",
              resources: [input.id ?? "create"],
              save: ["*"],
              metadata: { action: input.action },
              source: { type: "tool", messageID: tool.messageID, id: tool.id },
            })
          const definition =
            input.action === "create" || input.action === "update" ? Definition.parse(input.definition) : undefined
          const session =
            definition?.target.type === "new_session" ? await ctx.session.get({ sessionID: tool.sessionID }) : undefined
          const selected =
            definition?.target.type === "new_session"
              ? {
                  ...definition,
                  target: {
                    ...definition.target,
                    agent: definition.target.agent ?? tool.agent,
                    model: definition.target.model ?? session?.model,
                  },
                }
              : definition
          const response = await fetch(`${process.env.CM_V2_FEATURE_URL}/schedule`, {
            method: input.action === "list" ? "GET" : "POST",
            headers: {
              authorization: `Basic ${Buffer.from(`opencode:${process.env.CM_V2_FEATURE_PASSWORD}`).toString("base64")}`,
              "content-type": "application/json",
            },
            ...(input.action === "list" ? {} : { body: JSON.stringify({ ...input, definition: selected }) }),
            signal: tool.signal,
          })
          const text = await response.text()
          if (!response.ok) throw new Error(`Schedule request failed (${response.status}): ${text}`)
          return { content: [{ type: "text", text }] }
        },
      }),
    )
  },
} satisfies Plugin
