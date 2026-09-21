import path from "node:path"
import fs from "node:fs/promises"
import { constants } from "node:fs"
import { createHash, randomBytes } from "node:crypto"
import { Schema } from "effect"
import { ConfigMarkdown } from "@opencode-ai/core/config/markdown"

export const Selection = Schema.Struct({
  name: Schema.String,
  source: Schema.String,
  revision: Schema.String,
})
export type Selection = Schema.Schema.Type<typeof Selection>

export const Metadata = Schema.Struct({
  ...Selection.fields,
  description: Schema.optional(Schema.String),
})
export type Metadata = Schema.Schema.Type<typeof Metadata>

export const Draft = Schema.Struct({
  name: Schema.String,
  description: Schema.String,
  instructions: Schema.String,
  scope: Schema.Literals(["workspace", "global"]),
})
export type Draft = Schema.Schema.Type<typeof Draft>

export const Review = Schema.Struct({
  token: Schema.String,
  digest: Schema.String,
  directory: Schema.String,
  destination: Schema.String,
  scope: Schema.Literals(["workspace", "global"]),
})
export const Receipt = Schema.Struct({
  ...Metadata.fields,
  directory: Schema.String,
  destination: Schema.String,
  scope: Schema.Literals(["workspace", "global"]),
  digest: Schema.String,
})
export const Manage = Schema.Struct({
  action: Schema.Literals(["read", "review", "apply"]),
  selected: Selection,
  operation: Schema.optional(Schema.Literals(["edit", "delete"])),
  draft: Schema.optional(Draft),
  token: Schema.optional(Schema.String),
})
export type Manage = Schema.Schema.Type<typeof Manage>
export const Managed = Schema.Struct({
  ...Metadata.fields,
  content: Schema.String,
  document: Schema.String,
  location: Schema.String,
  editable: Schema.Boolean,
  scope: Schema.Literals(["workspace", "global", "external"]),
  token: Schema.optional(Schema.String),
  digest: Schema.optional(Schema.String),
  backup: Schema.optional(Schema.String),
  deleted: Schema.optional(Schema.Boolean),
})
export class Error extends Schema.TaggedErrorClass<Error>()("ManagedSkillError", {
  message: Schema.String,
}) {}

export function digest(value: unknown) {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex")
}

export function validate(draft: Draft) {
  if (
    !/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(draft.name) ||
    draft.name.length > 64 ||
    /^(con|prn|aux|nul|com[0-9]|lpt[0-9])$/i.test(draft.name)
  )
    throw new Error({ message: "Use a portable lowercase skill name, up to 64 letters, digits and single hyphens." })
  if (!draft.description.trim() || draft.description.length > 1024 || /[\x00-\x1f]/.test(draft.description))
    throw new Error({ message: "Description must be one line, 1-1024 characters." })
  if (!draft.instructions.trim() || draft.instructions.length > 64000 || draft.instructions.includes("\0"))
    throw new Error({ message: "Instructions must contain 1-64000 characters, without NUL." })
  if (!["workspace", "global"].includes(draft.scope))
    throw new Error({ message: "Choose a workspace or global scope." })
  return `---\nname: ${JSON.stringify(draft.name)}\ndescription: ${JSON.stringify(draft.description)}\n---\n${draft.instructions}`
}

// Check every existing ancestor, including Windows junctions. Never follow a
// configured link when creating files on behalf of a reviewed panel action.
export async function directory(target: string, create = false): Promise<void> {
  const parent = path.dirname(target)
  if (parent !== target) await directory(parent, create)
  const stat = await fs.lstat(target).catch((error: NodeJS.ErrnoException) => {
    if (error.code !== "ENOENT" || !create) throw error
    return undefined
  })
  if (!stat) {
    await fs.mkdir(target).catch((error: NodeJS.ErrnoException) => {
      if (error.code !== "EEXIST") throw error
    })
    return directory(target)
  }
  if (stat.isSymbolicLink() || !stat.isDirectory())
    throw new Error({ message: "Skill storage contains a linked or non-directory path." })
}

export async function snapshot(location: string) {
  // Discovery supports links. Pin the canonical target, not the link's identity.
  // Reviewed writes use the stricter directory checks in create().
  const canonical = await fs.realpath(location)
  const stat = await fs.lstat(canonical)
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 256 * 1024)
    throw new Error({ message: "Skill file is invalid or too large." })
  const file = await fs.open(canonical, constants.O_RDONLY | (constants.O_NOFOLLOW || 0))
  try {
    const opened = await file.stat()
    if (opened.dev !== stat.dev || opened.ino !== stat.ino)
      throw new Error({ message: "Skill changed while being read. Refresh the picker." })
    const text = await file.readFile("utf8")
    if (Buffer.byteLength(text) > 256 * 1024) throw new Error({ message: "Skill is too large." })
    const current = await fs.stat(location)
    if (
      (await fs.realpath(location)) !== canonical ||
      current.dev !== opened.dev ||
      current.ino !== opened.ino ||
      current.size !== opened.size ||
      current.mtimeMs !== opened.mtimeMs ||
      current.ctimeMs !== opened.ctimeMs
    )
      throw new Error({ message: "Skill changed while being read. Refresh the picker." })
    const md = ConfigMarkdown.parse(text)
    if (
      typeof md.data.name !== "string" ||
      !(md.data.description === undefined || typeof md.data.description === "string")
    )
      throw new Error({ message: "Invalid skill frontmatter." })
    return {
      name: md.data.name,
      description: md.data.description,
      content: md.content,
      text,
      location: canonical,
      source: digest([canonical, opened.dev, opened.ino]),
      revision: digest(text),
    }
  } finally {
    await file.close()
  }
}

export async function create(root: string, draft: Draft) {
  const text = validate(draft)
  await directory(root, true)
  const destination = path.join(root, draft.name)
  // Exclusive directory creation also rejects empty directories and linked names.
  await fs.mkdir(destination)
  await directory(destination)
  const location = path.join(destination, "SKILL.md")
  const file = await fs.open(
    location,
    constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | (constants.O_NOFOLLOW || 0),
    0o600,
  )
  try {
    await file.writeFile(text, "utf8")
    await file.sync()
  } finally {
    await file.close()
  }
  await directory(destination)
  if ((await fs.lstat(location)).isSymbolicLink())
    throw new Error({ message: "Saved skill was replaced by a link. Inspect the destination; do not retry." })
  const info = await snapshot(location)
  if (info.revision !== digest(text))
    throw new Error({ message: "Save could not be verified. Inspect the destination; do not retry." })
  return info
}

// Only the selected definition is changed. Bundled scripts and other files remain.
// Retain the exact original bytes under a non-discoverable backup name.
export async function change(location: string, selected: Selection, draft?: Draft) {
  await directory(path.dirname(location))
  const stat = await fs.lstat(location)
  if (stat.isSymbolicLink() || !stat.isFile()) throw new Error({ message: "Skill is not a regular file." })
  const current = await snapshot(location)
  if (current.source !== selected.source || current.revision !== selected.revision)
    throw new Error({ message: "Skill changed. Refresh and review again." })
  const text = draft ? revised(current.text, draft) : undefined
  const backup = path.join(path.dirname(location), ".SKILL.md." + randomBytes(16).toString("hex") + ".bak")
  const preserved = await fs.open(backup, "wx", 0o600)
  try {
    await preserved.writeFile(current.text, "utf8")
    await preserved.sync()
  } finally {
    await preserved.close()
  }
  if (digest(await fs.readFile(backup, "utf8")) !== selected.revision)
    throw new Error({ message: "Backup could not be verified. Nothing was replaced." })
  const file = await fs.open(location, constants.O_RDWR | (constants.O_NOFOLLOW || 0))
  try {
    const opened = await file.stat()
    if (
      opened.ino !== stat.ino ||
      opened.dev !== stat.dev ||
      opened.nlink !== 1 ||
      digest(await file.readFile("utf8")) !== selected.revision
    )
      throw new Error({ message: "Skill changed or has multiple links. Nothing was replaced." })
    if (text !== undefined) {
      await file.write(text, 0, "utf8")
      await file.truncate(Buffer.byteLength(text))
      await file.sync()
    }
  } finally {
    await file.close()
  }
  if (text === undefined) {
    const latest = await snapshot(location)
    if (latest.source !== selected.source || latest.revision !== selected.revision)
      throw new Error({ message: "Skill changed before deletion. Refresh and review again." })
    await fs.unlink(location)
    return { backup, deleted: true }
  }
  const updated = await snapshot(location)
  if (updated.revision !== digest(text))
    throw new Error({ message: "Save could not be confirmed. Inspect the backup; do not retry." })
  return { backup, deleted: false, updated }
}

function revised(original: string, draft: Draft) {
  validate(draft)
  const parsed = ConfigMarkdown.parse(original)
  // JSON objects are valid YAML and preserve additional frontmatter fields.
  return (
    "---\n" +
    JSON.stringify({ ...parsed.data, name: draft.name, description: draft.description }, null, 2) +
    "\n---\n" +
    draft.instructions
  )
}

export * as ManagedSkill from "./managed"
