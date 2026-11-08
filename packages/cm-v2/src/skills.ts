import path from "node:path"
import { Global } from "@opencode/util/global"
import { randomBytes } from "node:crypto"
import type { OpenCodeClient } from "@opencode/client"
import { Permission } from "@opencode/core/permission"
import { ManagedSkill } from "../../opencode/src/skill/managed"
import { featuresRpc } from "./features-rpc"

export class ManagedSkills {
  private reviews = new Map<string, { digest: string; expires: number }>()
  private chain: Promise<unknown> = Promise.resolve()
  constructor(
    readonly client: OpenCodeClient,
    readonly configDirectory = process.env.OPENCODE_CONFIG_DIR ?? Global.Path.config,
    readonly project = true,
  ) {}

  async fresh(directory: string) {
    const result = await this.client.rpc(featuresRpc).refresh({}, { location: { directory } })
    // Discovery may expose the same file through multiple roots. Keep distinct sources.
    return [...new Map(result.skills.map((skill) => [skill.source, skill])).values()]
  }

  async catalog(directory: string) {
    const agent = (await this.client.agent.list({ location: { directory } })).data[0]
    return (await this.fresh(directory))
      .filter((skill) => Permission.evaluate("skill", skill.id, agent?.permissions ?? []).effect !== "deny")
      .map(({ name, description, source, revision }) => ({ name, description, source, revision }))
  }

  async resolve(directory: string, selected: ManagedSkill.Selection) {
    const list = (await this.fresh(directory)).filter((item) => item.name === selected.name)
    if (list.length !== 1 || list[0].source !== selected.source || list[0].revision !== selected.revision)
      throw new Error("Skill is missing, changed or has a duplicate name. Refresh and select it again.")
    return list[0]
  }

  async validate(directory: string, selected: ManagedSkill.Selection) {
    const info = await this.resolve(directory, selected)
    const agent = (await this.client.agent.list({ location: { directory } })).data[0]
    if (Permission.evaluate("skill", info.id, agent?.permissions ?? []).effect === "deny")
      throw new Error("Skill is denied by CM permissions.")
    return { name: info.name, description: info.description, source: info.source, revision: info.revision }
  }

  private destination(directory: string, draft: ManagedSkill.Draft) {
    ManagedSkill.validate(draft)
    if (draft.scope === "workspace" && !this.project)
      throw new Error("Workspace skill storage is disabled by CM configuration.")
    const root = path.join(
      draft.scope === "workspace" ? path.join(directory, ".opencode") : this.configDirectory,
      "skills",
    )
    return { directory, root, destination: path.join(root, draft.name, "SKILL.md") }
  }

  private token(digest: string) {
    for (const [token, review] of this.reviews) if (review.expires < Date.now()) this.reviews.delete(token)
    if (this.reviews.size >= 1000) throw new Error("Too many pending skill reviews.")
    const token = randomBytes(32).toString("hex")
    this.reviews.set(token, { digest, expires: Date.now() + 600000 })
    return token
  }

  private consume(token: string, digest: string) {
    const saved = this.reviews.get(token)
    this.reviews.delete(token)
    if (!saved || saved.expires < Date.now() || saved.digest !== digest)
      throw new Error("Review expired, was used, or does not match this exact content and workspace. Review again.")
  }

  async review(directory: string, draft: ManagedSkill.Draft) {
    const target = this.destination(directory, draft)
    if ((await this.fresh(directory)).some((item) => item.name.toLowerCase() === draft.name.toLowerCase()))
      throw new Error("A skill with this name already exists. Choose another name.")
    const digest = ManagedSkill.digest([target, draft])
    return { token: this.token(digest), digest, directory, destination: target.destination, scope: draft.scope }
  }

  create(directory: string, input: ManagedSkill.Draft & { token: string }) {
    return this.serialize(async () => {
      const { token, ...draft } = input
      const target = this.destination(directory, draft)
      const digest = ManagedSkill.digest([target, draft])
      this.consume(token, digest)
      if ((await this.fresh(directory)).some((item) => item.name.toLowerCase() === draft.name.toLowerCase()))
        throw new Error("A skill with this name already exists. Nothing was overwritten.")
      const info = await ManagedSkill.create(target.root, draft)
      await this.resolve(directory, info)
      return {
        name: info.name,
        description: info.description,
        source: info.source,
        revision: info.revision,
        directory,
        destination: target.destination,
        scope: draft.scope,
        digest,
      }
    })
  }

  manage(directory: string, input: ManagedSkill.Manage) {
    return this.serialize(async () => {
      const info = await this.resolve(directory, input.selected)
      const parent = path.dirname(path.dirname(info.location))
      const scope =
        parent === path.join(directory, ".opencode/skills")
          ? ("workspace" as const)
          : parent === path.join(this.configDirectory, "skills")
            ? ("global" as const)
            : ("external" as const)
      const editable = scope !== "external" && !(scope === "workspace" && !this.project)
      const value = {
        name: info.name,
        description: info.description,
        source: info.source,
        revision: info.revision,
        content: info.content,
        document: info.text,
        location: info.location,
        editable,
        scope,
      }
      if (input.action === "read") return value
      if (!editable || !input.operation)
        throw new Error("This skill is read-only. Copy it into a managed skill to edit it.")
      if (input.operation === "edit") {
        if (!input.draft || input.draft.scope !== scope) throw new Error("Keep the existing skill scope when editing.")
        ManagedSkill.validate(input.draft)
        if (
          (await this.fresh(directory)).some(
            (item) => item.source !== info.source && item.name.toLowerCase() === input.draft!.name.toLowerCase(),
          )
        )
          throw new Error("Another skill already uses that name.")
      } else if (input.draft) throw new Error("Deletion does not accept replacement content.")
      await ManagedSkill.directory(path.dirname(info.location))
      const digest = ManagedSkill.digest([
        directory,
        info.location,
        input.selected,
        input.operation,
        input.draft || null,
      ])
      if (input.action === "review") return { ...value, token: this.token(digest), digest }
      this.consume(input.token || "", digest)
      const result = await ManagedSkill.change(info.location, input.selected, input.draft)
      await this.fresh(directory)
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
  }

  select(directory: string, input: { sessionID: string; selected: ManagedSkill.Selection[] }) {
    return this.serialize(async () => {
      const session = await this.client.session.get({ sessionID: input.sessionID })
      if (path.resolve(session.location.directory) !== directory)
        throw new Error("Skill selection workspace does not match the session")
      // Resolve the entire batch before admitting any selection.
      const list = await Promise.all(input.selected.map((selected) => this.resolve(directory, selected)))
      const agents = await this.client.agent.list({ location: { directory } })
      const agent = session.agent ? agents.data.find((agent) => agent.id === session.agent) : agents.data[0]
      for (const skill of list)
        if (
          Permission.evaluate("skill", skill.id, agent?.permissions ?? [], session.permissions ?? []).effect === "deny"
        )
          throw new Error("Skill is denied by CM permissions.")
      for (const skill of list) {
        await this.client
          .rpc(featuresRpc)
          .refresh(
            { selected: [{ name: skill.name, source: skill.source, revision: skill.revision }] },
            { location: { directory } },
          )
        await this.client.experimental.session.skill({ sessionID: input.sessionID, id: skill.id, resume: false })
      }
      return { selected: input.selected }
    })
  }

  private serialize<T>(fn: () => Promise<T>) {
    const result = this.chain.then(fn)
    this.chain = result.catch(() => undefined)
    return result
  }
}
