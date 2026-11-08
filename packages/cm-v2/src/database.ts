import { existsSync } from "node:fs"
import { chmod, link, mkdir, rm } from "node:fs/promises"
import { homedir } from "node:os"
import { dirname, isAbsolute, join } from "node:path"
import { backup, DatabaseSync } from "node:sqlite"
import { randomUUID } from "node:crypto"

export async function prepareDatabase(channel: string) {
  const data = join(process.env.XDG_DATA_HOME || join(homedir(), ".local", "share"), "opencode")
  const source = process.env.OPENCODE_DB
    ? process.env.OPENCODE_DB === ":memory:" || isAbsolute(process.env.OPENCODE_DB)
      ? process.env.OPENCODE_DB
      : join(data, process.env.OPENCODE_DB)
    : join(
        data,
        ["latest", "beta", "prod"].includes(channel) ||
          ["1", "true"].includes(process.env.OPENCODE_DISABLE_CHANNEL_DB ?? "")
          ? "opencode.db"
          : `opencode-${channel.replace(/[^a-zA-Z0-9._-]/g, "-")}.db`,
      )
  if (source === ":memory:") return source
  const target = `${source.replace(/\.db$/, "")}.cm-v2.db`
  await mkdir(dirname(target), { recursive: true, mode: 0o700 })
  if (existsSync(target) || !existsSync(source)) return target
  const temporary = `${target}.${randomUUID()}.tmp`
  const original = new DatabaseSync(source, { readOnly: true })
  try {
    // SQLite backup includes committed WAL data; link publishes once without replacing another startup's copy.
    await backup(original, temporary)
    await chmod(temporary, 0o600)
    await link(temporary, target).catch((error: NodeJS.ErrnoException) => {
      if (error.code !== "EEXIST") throw error
    })
  } finally {
    original.close()
    await rm(temporary, { force: true })
  }
  return target
}
