import { execFile } from "node:child_process"
import { realpath } from "node:fs/promises"
import { promisify } from "node:util"
import type { OpenCodeClient } from "@opencode/client"

const execute = promisify(execFile)

export async function resetWorktree(client: OpenCodeClient, root: string, target: string) {
  const directory = await realpath(target)
  const location = await client.location.get({ location: { directory: root } })
  const primary = await realpath(location.project.canonical)
  if (directory === primary) throw new Error("Cannot reset the primary workspace")
  const entries = (await git(primary, ["worktree", "list", "--porcelain", "-z"]))
    .split("\0")
    .filter((entry) => entry.startsWith("worktree "))
    .map((entry) => entry.slice(9))
  const registered = await Promise.all(entries.map((entry) => realpath(entry)))
  if (!registered.includes(directory) || directory === registered[0]) throw new Error("Worktree not found")
  const active = await client.session.active()
  const sessions = await Promise.all(Object.keys(active).map((sessionID) => client.session.get({ sessionID })))
  if (sessions.some((session) => session.location.directory === directory))
    throw new Error("Cannot reset a workspace with an active session")

  // Match the existing Reset action: remote default, configured default, main, then master.
  const remotes = (await git(primary, ["remote"])).trim().split(/\r?\n/).filter(Boolean)
  const remote = remotes.includes("origin") ? "origin" : remotes.includes("upstream") ? "upstream" : remotes[0]
  const remoteHead = remote ? await git(primary, ["symbolic-ref", `refs/remotes/${remote}/HEAD`]).catch(() => "") : ""
  const branches = (await git(primary, ["for-each-ref", "--format=%(refname:short)", "refs/heads"]))
    .trim()
    .split(/\r?\n/)
  const configured = (await git(primary, ["config", "init.defaultBranch"]).catch(() => "")).trim()
  const base =
    remoteHead.trim().replace(/^refs\/remotes\//, "") ||
    [configured, "main", "master"].find((branch) => branch && branches.includes(branch))
  if (!base) throw new Error("Default branch not found")
  if (remoteHead && remote) await git(primary, ["fetch", "--", remote, base.slice(remote.length + 1)])
  await git(directory, ["reset", "--hard", base, "--"])
  await git(directory, ["clean", "-ffdx"])
  await git(directory, ["submodule", "update", "--init", "--recursive", "--force"])
  await git(directory, ["submodule", "foreach", "--recursive", "git", "reset", "--hard"])
  await git(directory, ["submodule", "foreach", "--recursive", "git", "clean", "-fdx"])
  if ((await git(directory, ["-c", "core.fsmonitor=false", "status", "--porcelain=v1"])).trim())
    throw new Error("Worktree reset left local changes")
  const project = (await client.project.list()).find((project) => project.id === location.project.id)
  if (project?.commands?.start?.trim())
    await client.shell.create({ location: { directory }, command: project.commands.start })
  await client.worktree.refresh({ projectID: location.project.id })
  return true
}

async function git(directory: string, args: string[]) {
  return (await execute("git", ["-C", directory, ...args], { timeout: 120_000, maxBuffer: 8 * 1024 * 1024 })).stdout
}
