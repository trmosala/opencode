// THROWAWAY issue #20. Run: node script/sqlite-lock-probe.mjs
import { spawn } from "node:child_process"
import {
  closeSync,
  existsSync,
  mkdtempSync,
  openSync,
  realpathSync,
  statSync,
  symlinkSync,
  writeFileSync,
  rmSync,
} from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { fileURLToPath, pathToFileURL } from "node:url"
import { createInterface } from "node:readline"

const self = fileURLToPath(import.meta.url)
const [, , action, path, mode] = process.argv
if (action) {
  const Native = process.versions.bun
    ? (await import("bun:sqlite")).Database
    : (await import("node:sqlite")).DatabaseSync
  const row = (db, sql) => (process.versions.bun ? db.query(sql).get() : db.prepare(sql).get())
  const send = (value) => console.log(JSON.stringify(value))
  const attempt = (guarded, existing = false) => {
    let db
    try {
      const canonical = guarded ? realpathSync(path) : path
      if (guarded && !statSync(canonical).isFile()) throw new Error("not regular file")
      const uri = pathToFileURL(canonical)
      uri.search = "mode=rw"
      db = existing
        ? process.versions.bun
          ? new Native(canonical, { readwrite: true, create: false })
          : new Native(uri.href)
        : new Native(canonical)
      db.exec("PRAGMA busy_timeout=0")
      if (guarded && row(db, "SELECT value FROM identity").value !== "probe") throw new Error("wrong identity")
      db.exec("BEGIN IMMEDIATE")
      return { state: "acquired" }
    } catch (error) {
      return { state: /locked|busy/i.test(error.message) ? "busy" : "error", message: error.message }
    } finally {
      db?.close()
    }
  }
  if (action === "init") {
    const db = new Native(path)
    db.exec(`PRAGMA journal_mode=${mode}; CREATE TABLE identity(value TEXT); INSERT INTO identity VALUES('probe')`)
    send({
      runtime: process.version,
      bun: process.versions.bun,
      sqlite: row(db, "SELECT sqlite_version() AS version").version,
    })
    db.close()
  } else if (action === "try" || action === "raw" || action === "existing") {
    send(attempt(action === "try", action === "existing"))
  } else if (action === "owner") {
    const db = new Native(realpathSync(path))
    db.exec("PRAGMA busy_timeout=0; BEGIN IMMEDIATE")
    const watchdog = setTimeout(() => process.exit(70), 15000)
    send({ state: "acquired" })
    for await (const line of createInterface({ input: process.stdin })) {
      if (line === "contend") send(attempt(true))
      if (line === "probe") {
        const other = new Native(realpathSync(path))
        row(other, "SELECT value FROM identity")
        other.close()
        send({ state: "closed" })
      }
      if (line === "descriptor" || line === "shared-descriptor") {
        closeSync(openSync(line === "descriptor" ? path : `${path}-shm`, "r"))
        send({ state: "closed", inTransaction: process.versions.bun ? db.inTransaction : db.isTransaction })
      }
    }
    clearTimeout(watchdog)
    db.close()
  } else throw new Error("unknown action")
} else {
  const root = mkdtempSync(join(tmpdir(), "sqlite-lock-probe-"))
  const children = new Map()
  const results = []
  const start = (runtime, args) => {
    const child = spawn(runtime, [self, ...args], { stdio: ["pipe", "pipe", "pipe"] })
    let stderr = ""
    child.stderr.on("data", (chunk) => {
      stderr += chunk
    })
    child.stdin.on("error", () => {})
    const exited = new Promise((resolve) => {
      child.on("error", (error) => {
        stderr += error.message
      })
      child.on("close", (code, signal) => {
        children.delete(child)
        resolve({ code, signal, stderr })
      })
    })
    children.set(child, exited)
    const timer = setTimeout(() => child.kill("SIGKILL"), 20000)
    exited.then(() => clearTimeout(timer))
    const lines = createInterface({ input: child.stdout })[Symbol.asyncIterator]()
    return {
      child,
      exited,
      async next() {
        const line = await lines.next()
        if (line.done) throw new Error(`Child failed: ${JSON.stringify(await exited)}`)
        return JSON.parse(line.value)
      },
    }
  }
  const run = async (runtime, args) => {
    const proc = start(runtime, args)
    const value = await proc.next()
    const exit = await proc.exited
    if (exit.code !== 0) throw new Error(JSON.stringify(exit))
    return value
  }
  const check = (name, actual, expected) => {
    const result = { name, pass: actual.state === expected, expected, ...actual }
    results.push(result)
    console.log(JSON.stringify(result))
  }
  try {
    console.log(JSON.stringify({ throwaway: true, platform: process.platform, arch: process.arch, scratch: root }))
    for (const mode of ["DELETE", "WAL"]) {
      for (const runtime of ["bun", "node"]) {
        const file = join(root, `${runtime}-${mode}.sqlite`)
        console.log(JSON.stringify({ runtime, mode, versions: await run(runtime, ["init", file, mode]) }))
        const independent = `${file}.other`
        await run(runtime, ["init", independent, mode])
        const alias = `${file}.alias`
        symlinkSync(file, alias)
        const owner = start(runtime, ["owner", file])
        check(`${runtime}/${mode}/owner`, await owner.next(), "acquired")
        for (const contender of ["bun", "node"]) {
          check(
            `${runtime}/${mode}/${contender}/existing-open-contention`,
            await run(contender, ["existing", file]),
            "busy",
          )
          for (const target of [file, alias])
            check(
              `${runtime}/${mode}/${contender}/${target === file ? "canonical" : "symlink"}`,
              await run(contender, ["try", target]),
              "busy",
            )
          check(`${runtime}/${mode}/${contender}/independent`, await run(contender, ["try", independent]), "acquired")
        }
        for (const command of ["contend", "probe"]) {
          owner.child.stdin.write(`${command}\n`)
          check(
            `${runtime}/${mode}/same-process-${command}`,
            await owner.next(),
            command === "contend" ? "busy" : "closed",
          )
          for (const contender of ["bun", "node"])
            check(`${runtime}/${mode}/${contender}/after-${command}-close`, await run(contender, ["try", file]), "busy")
        }
        if (process.platform !== "win32") {
          owner.child.kill("SIGSTOP")
          await new Promise((resolve) => setTimeout(resolve, 300))
          for (const contender of ["bun", "node"])
            check(`${runtime}/${mode}/${contender}/paused-owner`, await run(contender, ["try", file]), "busy")
          owner.child.kill("SIGCONT")
        } else console.log("UNSUPPORTED: Windows pause test")
        // A non-SQLite close can release process-wide POSIX locks in rollback-journal mode.
        for (const command of mode === "WAL" ? ["descriptor", "shared-descriptor"] : ["descriptor"]) {
          owner.child.stdin.write(`${command}\n`)
          const closed = await owner.next()
          check(`${runtime}/${mode}/raw-${command}-close`, closed, "closed")
          check(
            `${runtime}/${mode}/after-${command}-transaction`,
            { state: closed.inTransaction === true ? "active" : "lost" },
            "active",
          )
          for (const contender of ["bun", "node"])
            check(
              `${runtime}/${mode}/${contender}/after-raw-${command}-close`,
              await run(contender, ["try", file]),
              "busy",
            )
        }
        owner.child.kill("SIGKILL")
        const exit = await owner.exited
        check(
          `${runtime}/${mode}/owned-kill`,
          { state: exit.signal === "SIGKILL" ? "killed" : JSON.stringify(exit) },
          "killed",
        )
        for (const contender of ["bun", "node"]) {
          check(`${runtime}/${mode}/${contender}/kill-reopen`, await run(contender, ["try", file]), "acquired")
          check(
            `${runtime}/${mode}/${contender}/existing-kill-reopen`,
            await run(contender, ["existing", file]),
            "acquired",
          )
        }
      }
    }
    for (const runtime of ["bun", "node"]) {
      const missing = join(root, `${runtime}-missing`)
      const malformed = join(root, `${runtime}-malformed`)
      const empty = join(root, `${runtime}-empty`)
      writeFileSync(malformed, "not sqlite")
      writeFileSync(empty, "")
      for (const target of [missing, malformed, empty, root])
        check(`${runtime}/guarded/${target}`, await run(runtime, ["try", target]), "error")
      check(`${runtime}/EXISTING-missing-refusal`, await run(runtime, ["existing", missing]), "error")
      check(`${runtime}/EXISTING-missing-not-created`, { state: existsSync(missing) ? "created" : "absent" }, "absent")
      // Intentionally retain failing safety assertions for the bare candidate.
      check(`${runtime}/BARE-missing-refusal`, await run(runtime, ["raw", missing]), "error")
      check(`${runtime}/BARE-malformed-refusal`, await run(runtime, ["raw", malformed]), "error")
    }
  } finally {
    const pending = [...children.entries()]
    pending.forEach(([child]) => child.kill("SIGKILL"))
    await Promise.all(pending.map(([, exited]) => exited))
    rmSync(root, { recursive: true, force: true })
    console.log(
      JSON.stringify({
        cleanup: "scratch removed after children exited",
        total: results.length,
        failed: results.filter((r) => !r.pass).length,
      }),
    )
  }
  if (results.some((r) => !r.pass)) process.exitCode = 1
}
