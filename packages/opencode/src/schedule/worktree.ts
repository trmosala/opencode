import path from "node:path"
import { execFile } from "node:child_process"
import { promisify } from "node:util"
import { realpath } from "node:fs/promises"
import type { Occurrence } from "./engine"

const git = promisify(execFile)

export async function prepareWorktree(item: Occurrence, root: string, retained: number, persist: () => Promise<void>) {
  const target = item.definition.target
  if (target.type !== "new_session" || target.workspace.type !== "worktree") return
  if (!/^occ_[0-9a-f-]{36}$/.test(item.id)) throw new Error("Invalid occurrence identity")
  const directory = path.join(root, item.id)
  if (item.worktree && path.resolve(item.worktree) !== path.resolve(directory))
    throw new Error("Worktree ownership path does not match")
  if (!item.baseCommit) {
    if (retained >= 100) throw new Error("Retained worktree limit reached; review saved worktrees before creating more")
    item.baseCommit = (
      await git("git", [
        "-C",
        target.directory,
        "rev-parse",
        "--verify",
        "--end-of-options",
        target.workspace.baseRef + "^{commit}",
      ])
    ).stdout.trim()
    item.worktree = directory
    await persist()
  }
  if (!/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(item.baseCommit)) throw new Error("Invalid owned worktree commit")
  const listing = (await git("git", ["-C", target.directory, "worktree", "list", "--porcelain"])).stdout
  const canonical = await realpath(directory).catch((error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT") return undefined
    throw error
  })
  // Git reports long Windows paths even when Node's temporary directory uses
  // an 8.3 alias. Compare physical paths before adopting an existing worktree.
  const records = await Promise.all(
    listing.split("\n\n").map(async (record) => {
      const line = record.split("\n").find((value) => value.startsWith("worktree "))
      if (!line || !canonical) return undefined
      const physical = await realpath(line.slice(9)).catch(() => undefined)
      return physical === canonical ? record : undefined
    }),
  )
  const found = records.find((record) => record !== undefined)
  if (found && !found.split("\n").includes("HEAD " + item.baseCommit))
    throw new Error("Owned worktree commit changed; review required")
  if (!found)
    await git("git", [
      "-C",
      target.directory,
      "-c",
      "core.symlinks=false",
      "worktree",
      "add",
      "--detach",
      directory,
      item.baseCommit,
    ])
  item.directory = directory
  item.worktree = directory
  await persist()
}
