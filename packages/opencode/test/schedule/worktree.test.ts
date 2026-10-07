import { expect, test } from "bun:test"
import { mkdtemp, mkdir, writeFile, readFile, rm } from "node:fs/promises"
import { execFile } from "node:child_process"
import { promisify } from "node:util"
import { randomUUID } from "node:crypto"
import path from "node:path"
import os from "node:os"
import { Definition } from "../../src/schedule/definition"
import { prepareWorktree } from "../../src/schedule/worktree"
import type { Occurrence } from "../../src/schedule/engine"

const git = promisify(execFile)

test("creates a worktree at the saved ref, persists ownership before creation, and retains artifacts on adoption", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "cm-schedule-git-"))
  const repo = path.join(directory, "repo")
  await mkdir(repo)
  const run = (args: string[]) => git("git", ["-C", repo, ...args])
  try {
    await run(["init"])
    await run(["config", "user.name", "Scheduler test"])
    await run(["config", "user.email", "test@example.com"])
    await writeFile(path.join(repo, "input.txt"), "first")
    await run(["add", "input.txt"])
    await run(["commit", "-m", "initial"])
    const base = (await run(["rev-parse", "HEAD"])).stdout.trim()
    await writeFile(path.join(repo, "input.txt"), "second")
    await run(["commit", "-am", "second"])
    const item: Occurrence = {
      id: "occ_" + randomUUID(),
      scheduleID: "sch_test",
      revision: 1,
      at: Date.now(),
      definition: Definition.parse({
        schemaVersion: 1,
        name: "Review",
        prompt: "Review",
        target: { type: "new_session", directory: repo, workspace: { type: "worktree", baseRef: base } },
        schedule: { type: "once", at: "2027-01-01T00:00:00Z" },
      }),
      sessionID: "ses_test",
      promptID: "msg_test",
      state: "pending",
      admitted: false,
      loginRequested: false,
    }
    const snapshots: Occurrence[] = []
    const persist = async () => {
      snapshots.push(structuredClone(item))
    }
    await prepareWorktree(item, path.join(directory, "owned"), 0, persist)
    expect(snapshots[0].baseCommit).toBe(base)
    expect(snapshots[0].worktree).toBe(path.join(directory, "owned", item.id))
    expect(await readFile(path.join(item.directory!, "input.txt"), "utf8")).toBe("first")
    await writeFile(path.join(item.directory!, "output.txt"), "retained output")
    await prepareWorktree(item, path.join(directory, "owned"), 1, persist)
    expect(await readFile(path.join(item.directory!, "output.txt"), "utf8")).toBe("retained output")
    const altered = { ...item, worktree: repo }
    await expect(prepareWorktree(altered, path.join(directory, "owned"), 1, persist)).rejects.toThrow("ownership")
    const fresh = { ...item, id: "occ_" + randomUUID(), baseCommit: undefined, worktree: undefined }
    await expect(prepareWorktree(fresh, path.join(directory, "owned"), 100, persist)).rejects.toThrow("limit")
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
}, 15_000)
