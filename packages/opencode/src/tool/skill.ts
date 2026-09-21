import path from "path"
import { Effect, Schema } from "effect"
import { Ripgrep } from "@opencode-ai/core/ripgrep"
import { Skill } from "../skill"
import * as Tool from "./tool"
import DESCRIPTION from "./skill.txt"
import { ManagedSkill } from "../skill/managed"

export const Parameters = Schema.Struct({
  name: Schema.String.annotate({ description: "The name of the skill from available_skills" }),
})

export const SkillTool = Tool.define(
  "skill",
  Effect.gen(function* () {
    const skill = yield* Skill.Service
    const ripgrep = yield* Ripgrep.Service

    return {
      description: DESCRIPTION,
      parameters: Parameters,
      execute: (params: Schema.Schema.Type<typeof Parameters>, ctx: Tool.Context) =>
        Effect.gen(function* () {
          const user = ctx.messages.findLast((message) => message.info.role === "user")
          const selection = user?.parts.flatMap((part) =>
            part.type === "text" && part.metadata?.cmSkill ? [part.metadata.cmSkill] : [],
          )[0]
          const selected =
            selection === undefined
              ? undefined
              : yield* Schema.decodeUnknownEffect(ManagedSkill.Selection)(selection).pipe(Effect.orDie)
          const pinned = selected?.name === params.name ? selected : undefined
          const before = pinned
            ? yield* skill.resolve(pinned).pipe(Effect.orDie)
            : yield* skill
                .require(params.name)
                .pipe(Effect.catchTag("Skill.NotFoundError", (error) => Effect.die(new Error(error.message))))

          yield* ctx.ask({
            permission: "skill",
            patterns: [params.name],
            always: [params.name],
            metadata: { name: params.name, ...(pinned ? { source: pinned.source, revision: pinned.revision } : {}) },
          })

          // Permission dialogs can stay open while files change. Validate again,
          // then use these exact bytes rather than re-reading by name.
          const info = pinned ? yield* skill.resolve(pinned).pipe(Effect.orDie) : before
          const dir = path.dirname(info.location)
          const base = dir
          const files =
            info.location === "<built-in>"
              ? []
              : yield* ripgrep.find({
                  cwd: dir,
                  pattern: "!**/SKILL.md",
                  hidden: true,
                  follow: false,
                  signal: ctx.abort,
                  limit: 10,
                })

          return {
            title: `Loaded skill: ${info.name}`,
            output: [
              `<skill_content name="${info.name}">`,
              `# Skill: ${info.name}`,
              "",
              info.content.trim(),
              "",
              `Base directory for this skill: ${base}`,
              "Relative paths in this skill (e.g., scripts/, reference/) are relative to this base directory.",
              "Note: file list is sampled.",
              "",
              "<skill_files>",
              files.map((file) => `<file>${path.resolve(dir, file.path)}</file>`).join("\n"),
              "</skill_files>",
              "</skill_content>",
            ].join("\n"),
            metadata: {
              name: info.name,
              dir,
              ...(pinned ? { source: pinned.source, revision: pinned.revision } : {}),
            },
          }
        }).pipe(Effect.orDie),
    }
  }),
)
