// Isolated issue #20 experiment. No production imports, storage, providers or tools.
import assert from "node:assert/strict"
import { spawn, execFileSync } from "node:child_process"
import { randomUUID } from "node:crypto"
import { closeSync, existsSync, mkdtempSync, openSync, realpathSync, rmSync, statSync, writeSync } from "node:fs"
import { createRequire } from "node:module"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { createInterface } from "node:readline"
import { setTimeout } from "node:timers/promises"
import { fileURLToPath, pathToFileURL } from "node:url"

const self = fileURLToPath(import.meta.url)
const [action, path, namespace, session, option] = process.argv.slice(2)
const send = (value) => console.log(JSON.stringify(value))

if (action === "linger") {
  send({ state: "tool-started", pid: process.pid })
  setInterval(() => {}, 1000)
} else if (action === "host") {
  const runtime = JSON.parse(option)
  const holder = spawn(runtime.bin, [self, "hold", path, namespace, session], {
    stdio: ["pipe", "pipe", "pipe", 3],
    env: { ...process.env, ...runtime.env },
  })
  // Only the holder retains this test-only lifetime witness descriptor.
  closeSync(3)
  holder.stderr.pipe(process.stderr)
  holder.stdin.on("error", () => {})
  let state = "starting"
  let deferred
  let clean = false
  let calls = 0
  const checks = new Map()
  holder.stdout.on("end", () => {
    for (const resolve of checks.values()) resolve(false)
    checks.clear()
  })
  const acknowledge = (message) => {
    if (message.state === "acquired" && state === "starting") state = "active"
    send({
      ...message,
      state: message.state === "acquired" && state !== "active" ? "obsolete" : message.state,
      holder: holder.pid,
      host: process.pid,
    })
  }
  const lines = createInterface({ input: holder.stdout })
  lines.on("line", (line) => {
    const message = JSON.parse(line)
    if (message.state === "checked") {
      checks.get(message.nonce)?.(true)
      checks.delete(message.nonce)
      return
    }
    if (message.state === "holder-released") {
      clean = state === "releasing"
      return
    }
    if (runtime.defer && message.state === "acquired") {
      deferred = message
      send({ state: "deferred" })
      return
    }
    acknowledge(message)
  })
  holder.on("error", () => {
    state = "lost"
    send({ state: "lost", calls })
  })
  holder.on("exit", () => {
    if (runtime.deferLoss) return
    if (state !== "releasing") state = "lost"
  })
  holder.on("close", (code) => {
    if (runtime.deferLoss) {
      send({ state: "loss-held" })
      return
    }
    state = state === "releasing" && clean && code === 0 ? "released" : "lost"
    send({ state, calls })
  })
  for await (const line of createInterface({ input: process.stdin })) {
    if (line === "descriptor" || line === "shared-descriptor") {
      closeSync(openSync(line === "descriptor" ? path : `${path}-shm`, "r"))
      send({ state: "closed" })
    }
    if (line === "dispatch") {
      const confirmed =
        state === "active" &&
        !holder.stdout.readableEnded &&
        (await new Promise((resolve) => {
          const nonce = randomUUID()
          checks.set(nonce, resolve)
          holder.stdin.write(`check ${nonce}\n`, (error) => {
            if (!error) return
            checks.delete(nonce)
            resolve(false)
          })
        }))
      const allowed = confirmed && state === "active"
      if (allowed) calls++
      send({ state: allowed ? "dispatched" : "refused", calls })
    }
    if (line === "deliver-ack" && deferred) acknowledge(deferred)
    if (line === "kill-holder") holder.kill("SIGKILL")
    if (line === "release") {
      state = "releasing"
      holder.stdin.end("release\n")
    }
    if (line === "linger") spawn(process.execPath, [self, "linger"], { stdio: "inherit" })
  }
  state = "lost"
  holder.stdin.end()
} else if (action) {
  const Native = process.versions.bun
    ? (await import("bun:sqlite")).Database
    : (await import("node:sqlite")).DatabaseSync
  const row = (db, sql) => (process.versions.bun ? db.query(sql).get() : db.prepare(sql).get())
  if (action === "init") {
    const db = new Native(path)
    assert(["DELETE", "WAL"].includes(option))
    db.exec(`PRAGMA journal_mode=${option}; CREATE TABLE identity(namespace TEXT, session TEXT)`)
    const insert = process.versions.bun
      ? db.query("INSERT INTO identity VALUES (?, ?)")
      : db.prepare("INSERT INTO identity VALUES (?, ?)")
    insert.run(namespace, session)
    send({
      state: "provisioned",
      runtime: process.version,
      bun: process.versions.bun,
      electron: process.versions.electron,
      sqlite: row(db, "SELECT sqlite_version() AS version").version,
    })
    db.close()
  } else {
    let db
    try {
      const canonical = realpathSync(path)
      const identity = statSync(canonical)
      assert(identity.isFile() && identity.nlink === 1, "Expected one regular lock resource")
      const uri = pathToFileURL(canonical)
      uri.search = "mode=rw"
      db = process.versions.bun ? new Native(canonical, { readwrite: true, create: false }) : new Native(uri.href)
      db.exec("PRAGMA busy_timeout=0; BEGIN IMMEDIATE")
      const current = statSync(canonical)
      assert.equal(current.dev, identity.dev)
      assert.equal(current.ino, identity.ino)
      assert.equal(current.nlink, 1)
      const bound = row(db, "SELECT namespace, session FROM identity")
      assert.equal(bound?.namespace, namespace)
      assert.equal(bound?.session, session)
      send({ state: "acquired", pid: process.pid })
      if (action === "hold") {
        let reason = "abandoned"
        for await (const line of createInterface({ input: process.stdin })) {
          if (line === "release") {
            reason = "released"
            break
          }
          if (line.startsWith("check ")) {
            send({ state: "checked", nonce: line.slice(6) })
            continue
          }
          throw new Error("Unknown holder command")
        }
        db.close()
        db = undefined
        writeSync(3, JSON.stringify({ state: reason, pid: process.pid }) + "\n")
        if (reason === "released") send({ state: "holder-released" })
      }
    } catch (error) {
      if (action === "hold") process.exitCode = 1
      const code = Number(error.errcode ?? error.errno)
      send({
        state: (code & 255) === 5 ? "busy" : "error",
        code: error.code,
        sqliteCode: Number.isFinite(code) ? code : undefined,
        message: error.message,
      })
    } finally {
      db?.close()
    }
  }
} else {
  assert(process.platform !== "win32", "This experiment requires POSIX process-group cleanup; Windows is not validated")
  const scratch = mkdtempSync(join(tmpdir(), "session-lock-holder-"))
  const require = createRequire(new URL("../packages/desktop/package.json", import.meta.url))
  const runtimes = [
    { name: "bun", bin: "bun", env: {} },
    { name: "node", bin: process.execPath, env: {} },
    { name: "electron", bin: require("electron"), env: { ELECTRON_RUN_AS_NODE: "1" } },
  ]
  const children = new Map()
  let assertions = 0
  const check = (name, actual, expected) => {
    assertions++
    assert.deepEqual(actual, expected, name)
    send({ pass: name })
  }
  const start = (runtime, args) => {
    const child = spawn(runtime.bin, [self, ...args], {
      detached: process.platform !== "win32",
      stdio: ["pipe", "pipe", "pipe", "pipe"],
      env: { ...process.env, ...runtime.env },
    })
    let stderr = ""
    child.stderr.on("data", (chunk) => {
      stderr += chunk
    })
    child.stdin.on("error", () => {})
    const exited = new Promise((resolve, reject) => {
      child.once("error", reject)
      child.once("exit", (code, signal) => resolve({ code, signal }))
    })
    const closed = new Promise((resolve) => child.once("close", resolve))
    children.set(child, closed)
    const lines = createInterface({ input: child.stdout })[Symbol.asyncIterator]()
    const witness = createInterface({ input: child.stdio[3] })[Symbol.asyncIterator]()
    const witnessClosed = new Promise((resolve) => child.stdio[3].once("end", resolve))
    const timer = globalThis.setTimeout(() => {
      if (!child.pid) return
      if (process.platform === "win32") child.kill("SIGKILL")
      else {
        try {
          process.kill(-child.pid, "SIGKILL")
        } catch {}
      }
    }, 15000)
    void closed.then(() => {
      clearTimeout(timer)
      children.delete(child)
    })
    const next = async (source = lines) => {
      const result = await source.next()
      assert(!result.done, `Child ended before acknowledgement: ${stderr}`)
      return JSON.parse(result.value)
    }
    return { child, exited, closed, next, witness, witnessClosed }
  }
  const run = async (runtime, args) => {
    const proc = start(runtime, args)
    const result = await proc.next()
    assert.equal((await proc.exited).code, 0)
    await proc.closed
    return result
  }
  const request = (host, command) => {
    host.child.stdin.write(command + "\n")
    return host.next()
  }
  try {
    for (const runtime of runtimes) {
      for (const mode of ["DELETE", "WAL"]) {
        const path = join(scratch, `${runtime.name}-${mode}.sqlite`)
        const namespace = randomUUID()
        const session = randomUUID()
        const args = [path, namespace, session]
        send({ runtime: runtime.name, mode, versions: await run(runtime, ["init", ...args, mode]) })
        const independent = [path + ".independent", namespace, randomUUID()]
        await run(runtime, ["init", ...independent, mode])
        for (const ending of ["release", "host-death", "holder-death", "paused-holder"]) {
          const label = `${runtime.name}/${mode}/${ending}`
          const host = start(runtimes[1], ["host", ...args, JSON.stringify(runtime)])
          const acquired = await host.next()
          check(`${label}/ack`, acquired.state, "acquired")
          check(`${label}/independent-session`, (await run(runtimes[1], ["try", ...independent])).state, "acquired")
          for (const contender of runtimes)
            check(`${label}/${contender.name}/contends`, (await run(contender, ["try", ...args])).state, "busy")
          for (const command of mode === "WAL" ? ["descriptor", "shared-descriptor"] : ["descriptor"]) {
            check(`${label}/${command}/host-close`, (await request(host, command)).state, "closed")
            for (const contender of runtimes)
              check(
                `${label}/${command}/${contender.name}/still-exclusive`,
                (await run(contender, ["try", ...args])).state,
                "busy",
              )
          }
          if (ending === "host-death") {
            const tool = await request(host, "linger")
            check(`${label}/tool-started`, tool.state, "tool-started")
            if (process.platform !== "win32") {
              host.child.kill("SIGSTOP")
              for (let i = 0; i < 100; i++) {
                if (
                  execFileSync("ps", ["-o", "stat=", "-p", String(host.child.pid)], { encoding: "utf8" }).includes("T")
                )
                  break
                await setTimeout(10)
              }
              check(
                `${label}/observed-stopped`,
                execFileSync("ps", ["-o", "stat=", "-p", String(host.child.pid)], { encoding: "utf8" }).includes("T"),
                true,
              )
              check(`${label}/paused-not-reclaimed`, (await run(runtimes[1], ["try", ...args])).state, "busy")
              host.child.kill("SIGCONT")
            }
            host.child.kill("SIGKILL")
            check(`${label}/host-exited`, (await host.exited).signal, "SIGKILL")
            check(`${label}/pipe-eof`, (await host.next(host.witness)).state, "abandoned")
            await host.witnessClosed
            check(`${label}/ordinary-tool-survives`, process.kill(tool.pid, 0), true)
            process.kill(tool.pid, "SIGKILL")
          }
          if (ending === "holder-death") {
            check(`${label}/completed-marker`, await request(host, "dispatch"), { state: "dispatched", calls: 1 })
            check(`${label}/lost-notification`, (await request(host, "kill-holder")).state, "lost")
            await host.witnessClosed
            check(`${label}/no-dispatch-after-loss`, await request(host, "dispatch"), { state: "refused", calls: 1 })
            host.child.stdin.end()
            check(`${label}/host-exited`, (await host.exited).code, 0)
          }
          if (ending === "paused-holder") {
            process.kill(acquired.holder, "SIGSTOP")
            for (let i = 0; i < 100; i++) {
              if (
                execFileSync("ps", ["-o", "stat=", "-p", String(acquired.holder)], { encoding: "utf8" }).includes("T")
              )
                break
              await setTimeout(10)
            }
            check(
              `${label}/observed-stopped`,
              execFileSync("ps", ["-o", "stat=", "-p", String(acquired.holder)], { encoding: "utf8" }).includes("T"),
              true,
            )
            host.child.kill("SIGKILL")
            check(`${label}/host-exited`, (await host.exited).signal, "SIGKILL")
            check(`${label}/not-reclaimed-after-host-death`, (await run(runtimes[1], ["try", ...args])).state, "busy")
            process.kill(acquired.holder, "SIGCONT")
            check(`${label}/resumed-eof`, (await host.next(host.witness)).state, "abandoned")
            await host.witnessClosed
          }
          if (ending === "release") {
            host.child.stdin.write("release\ndispatch\n")
            check(`${label}/admission-closed-first`, await host.next(), { state: "refused", calls: 0 })
            check(`${label}/release-after-exit`, (await host.next()).state, "released")
            check(`${label}/clean-witness`, (await host.next(host.witness)).state, "released")
            await host.witnessClosed
            host.child.stdin.end()
            check(`${label}/host-exited`, (await host.exited).code, 0)
          }
          await host.closed
          for (const contender of runtimes)
            check(`${label}/${contender.name}/reopen`, (await run(contender, ["try", ...args])).state, "acquired")
        }
        const delayed = start(runtimes[1], ["host", ...args, JSON.stringify({ ...runtime, defer: true })])
        check(`${runtime.name}/${mode}/ack-held`, (await delayed.next()).state, "deferred")
        check(`${runtime.name}/${mode}/before-ack-refused`, await request(delayed, "dispatch"), {
          state: "refused",
          calls: 0,
        })
        check(`${runtime.name}/${mode}/cancel-before-ack`, (await request(delayed, "release")).state, "released")
        await delayed.witnessClosed
        check(`${runtime.name}/${mode}/late-ack-refused`, (await request(delayed, "deliver-ack")).state, "obsolete")
        check(`${runtime.name}/${mode}/late-ack-no-dispatch`, await request(delayed, "dispatch"), {
          state: "refused",
          calls: 0,
        })
        delayed.child.stdin.end()
        check(`${runtime.name}/${mode}/delayed-host-exited`, (await delayed.exited).code, 0)
        await delayed.closed
        const stale = start(runtimes[1], ["host", ...args, JSON.stringify({ ...runtime, deferLoss: true })])
        check(`${runtime.name}/${mode}/loss-window-acquired`, (await stale.next()).state, "acquired")
        check(
          `${runtime.name}/${mode}/loss-notification-held`,
          (await request(stale, "kill-holder")).state,
          "loss-held",
        )
        await stale.witnessClosed
        check(
          `${runtime.name}/${mode}/loss-window-contender`,
          (await run(runtimes[1], ["try", ...args])).state,
          "acquired",
        )
        check(`${runtime.name}/${mode}/loss-window-no-dispatch`, await request(stale, "dispatch"), {
          state: "refused",
          calls: 0,
        })
        stale.child.stdin.end()
        check(`${runtime.name}/${mode}/loss-window-host-exited`, (await stale.exited).code, 0)
        await stale.closed
        check(
          `${runtime.name}/${mode}/wrong-session`,
          (await run(runtime, ["try", path, namespace, randomUUID()])).state,
          "error",
        )
        check(
          `${runtime.name}/${mode}/wrong-namespace`,
          (await run(runtime, ["try", path, randomUUID(), session])).state,
          "error",
        )
        const missing = path + ".missing"
        check(
          `${runtime.name}/${mode}/missing-refused`,
          (await run(runtime, ["try", missing, namespace, session])).state,
          "error",
        )
        check(`${runtime.name}/${mode}/missing-not-created`, existsSync(missing), false)
      }
    }
    send({ completed: true, assertions })
  } finally {
    const pending = [...children]
    pending.forEach(([child]) => {
      if (process.platform === "win32") child.kill("SIGKILL")
      else {
        try {
          process.kill(-child.pid, "SIGKILL")
        } catch {}
      }
    })
    await Promise.all(pending.map(([, closed]) => closed))
    rmSync(scratch, { recursive: true, force: true })
    send({ cleanup: "owned process groups closed before scratch removal" })
  }
}
