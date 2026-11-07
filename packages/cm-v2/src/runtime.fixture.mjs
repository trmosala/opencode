import assert from "node:assert/strict"
import { createServer } from "node:http"
import { createHash } from "node:crypto"
import { mkdir, readFile, writeFile } from "node:fs/promises"
import { join } from "node:path"
import { DatabaseSync } from "node:sqlite"
import { pathToFileURL } from "node:url"
import { OpenCode } from "@opencode/client"
import { Server, prepareDatabase } from "../dist/runtime.js"
import { Database } from "../dist/migration-reader.js"

const root = process.env.FIXTURE_ROOT
assert.ok(root)
process.chdir(root)
const database = join(root, "legacy.db")
const config = { project: false, claude: false, content: "{}" }
const input = { hostname: "127.0.0.1", port: 0, password: "fixture-secret", database, config }
const initial = await Server.listen(input)
await initial.stop()
const legacy = new DatabaseSync(database)
legacy.exec(`
  CREATE TABLE session (
    id TEXT PRIMARY KEY, project_id TEXT NOT NULL, workspace_id TEXT, parent_id TEXT,
    slug TEXT NOT NULL, directory TEXT NOT NULL, path TEXT, title TEXT NOT NULL, version TEXT NOT NULL,
    share_url TEXT, summary_additions INTEGER, summary_deletions INTEGER, summary_files INTEGER,
    summary_diffs TEXT, metadata TEXT, cost REAL NOT NULL DEFAULT 0, tokens_input INTEGER NOT NULL DEFAULT 0,
    tokens_output INTEGER NOT NULL DEFAULT 0, tokens_reasoning INTEGER NOT NULL DEFAULT 0,
    tokens_cache_read INTEGER NOT NULL DEFAULT 0, tokens_cache_write INTEGER NOT NULL DEFAULT 0,
    revert TEXT, permission TEXT, agent TEXT, model TEXT, time_created INTEGER NOT NULL,
    time_updated INTEGER NOT NULL, time_compacting INTEGER, time_archived INTEGER
  );
  CREATE TABLE message (id TEXT PRIMARY KEY, session_id TEXT, time_created INTEGER, time_updated INTEGER, data TEXT);
  CREATE TABLE part (id TEXT PRIMARY KEY, message_id TEXT, session_id TEXT, time_created INTEGER, time_updated INTEGER, data TEXT);
`)
const sessionID = "ses_00000000000000migrationtest"
const messageID = "msg_00000000000000migrationtest"
legacy
  .prepare("INSERT INTO project (id,worktree,time_created,time_updated,time_active,sandboxes) VALUES (?,?,?,?,?,?)")
  .run("fixture-project", root, 1, 1, 1, "[]")
legacy
  .prepare(
    "INSERT INTO session (id,project_id,slug,directory,title,version,time_created,time_updated) VALUES (?,?,?,?,?,?,?,?)",
  )
  .run(sessionID, "fixture-project", "fixture", root, "Preserved title", "1.19.5", 1, 1)
legacy.prepare("INSERT INTO message VALUES (?,?,?,?,?)").run(
  messageID,
  sessionID,
  1,
  1,
  JSON.stringify({
    role: "user",
    time: { created: 1 },
    agent: "build",
    model: { providerID: "cookiemonster", modelID: "fixture" },
  }),
)
legacy
  .prepare("INSERT INTO part VALUES (?,?,?,?,?,?)")
  .run(
    "prt_00000000000000migrationtest",
    messageID,
    sessionID,
    1,
    1,
    JSON.stringify({ type: "text", text: "Preserve this history exactly." }),
  )
legacy.close()
const digest = async () =>
  createHash("sha256")
    .update(await readFile(database))
    .digest("hex")
const reader = new Database(database)
assert.equal(reader.query("SELECT COUNT(*) AS count FROM message").get().count, 1)
assert.equal(reader.query("SELECT id FROM message WHERE id = ?").all(messageID)[0].id, messageID)
assert.throws(() => reader.query("DELETE FROM message").run(), /readonly/)
reader.run("BEGIN")
assert.equal(reader.inTransaction, true)
reader.run("ROLLBACK")
assert.equal(reader.inTransaction, false)
reader.run("BEGIN")
reader.run("COMMIT")
assert.equal(reader.inTransaction, false)
reader.close()
const before = await digest()
await mkdir(join(process.env.XDG_DATA_HOME, "opencode"), { recursive: true })
const previousPath = join(process.env.XDG_DATA_HOME, "opencode", "opencode-next.db")
const previousNext = new DatabaseSync(previousPath)
previousNext.exec(`
CREATE TABLE project (id TEXT, worktree TEXT, time_created INTEGER, time_updated INTEGER, sandboxes TEXT);
CREATE TABLE session (id TEXT, project_id TEXT, slug TEXT, directory TEXT, version TEXT, cost REAL, tokens_input INTEGER, tokens_output INTEGER, tokens_reasoning INTEGER, tokens_cache_read INTEGER, tokens_cache_write INTEGER, time_created INTEGER, time_updated INTEGER);
CREATE TABLE session_message (id TEXT, session_id TEXT, type TEXT, seq INTEGER, time_created INTEGER, time_updated INTEGER, data TEXT);
`)
previousNext.prepare("INSERT INTO project VALUES (?,?,?,?,?)").run("previous-project", root, 1, 1, "[]")
previousNext
  .prepare("INSERT INTO session VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)")
  .run("ses_previous_next", "previous-project", "previous", root, "1.19.5", 0, 0, 0, 0, 0, 0, 1, 1)
previousNext
  .prepare("INSERT INTO session_message VALUES (?,?,?,?,?,?,?)")
  .run(
    "msg_previous_next",
    "ses_previous_next",
    "user",
    0,
    1,
    1,
    JSON.stringify({ text: "Previous next history", time: { created: 1 } }),
  )
previousNext.close()
const previousDigest = createHash("sha256")
  .update(await readFile(previousPath))
  .digest("hex")
process.env.OPENCODE_DB = database
const target = await prepareDatabase("dev")
assert.notEqual(target, database)
assert.equal(await prepareDatabase("dev"), target)
assert.equal(await digest(), before)
const plugin = join(root, "probe")
await mkdir(plugin)
await writeFile(
  join(plugin, "package.json"),
  JSON.stringify({ name: "cm-runtime-probe", type: "module", exports: { "./server": "./server.js" } }),
)
await writeFile(
  join(plugin, "server.js"),
  `import { Schema } from "effect";
export default {id:"cm-runtime-probe",async setup(ctx){
  await ctx.tool.transform(e=>e.add({name:"cm_runtime_probe",description:"Runtime fixture",options:{codemode:false},input:Schema.Struct({value:Schema.String}),execute:async (input)=>({content:[{type:"text",text:input.value}]})}));
  await ctx.session.hook("model.request",()=>{});
}}`,
)
const requests = []
const model = createServer(async (request, response) => {
  const chunks = []
  for await (const chunk of request) chunks.push(chunk)
  const body = JSON.parse(Buffer.concat(chunks).toString())
  requests.push({ headers: request.headers, body })
  const primary = body.tools?.some((tool) => tool.function.name === "cm_runtime_probe")
  const result = body.messages.some(
    (message) => message.role === "tool" && message.content.includes("native tool works"),
  )
  const delta =
    primary && !result
      ? {
          role: "assistant",
          tool_calls: [
            {
              index: 0,
              id: "call_cm_probe",
              type: "function",
              function: { name: "cm_runtime_probe", arguments: '{"value":"native tool works"}' },
            },
          ],
        }
      : { role: "assistant", content: primary ? "V2_TOOL_OK" : "Fixture title" }
  const chunk = (delta, finish_reason) =>
    `data: ${JSON.stringify({ id: "fixture", object: "chat.completion.chunk", created: 1, model: "m", choices: [{ index: 0, delta, finish_reason }] })}\n\n`
  response.writeHead(200, { "content-type": "text/event-stream" })
  response.end(chunk(delta, null) + chunk({}, primary && !result ? "tool_calls" : "stop") + "data: [DONE]\n\n")
})
await new Promise((resolve) => model.listen(0, "127.0.0.1", resolve))
const wpp = new URL("../dist/wpp-plugin", import.meta.url).href
const start = (password = input.password) =>
  Server.listen({
    ...input,
    password,
    database: target,
    config: {
      ...config,
      content: JSON.stringify({
        plugin: [wpp, pathToFileURL(plugin).href],
        model: "cookiemonster/m",
        snapshots: false,
        permission: { cm_runtime_probe: "allow" },
        provider: {
          cookiemonster: {
            npm: "@ai-sdk/openai-compatible",
            options: {
              baseURL: `http://127.0.0.1:${model.address().port}/v1`,
              apiKey: "fixture",
              headers: { "X-OpenCode-Runtime-Id": "wrong-owner" },
            },
            models: { m: { name: "Fixture", tool_call: true } },
          },
        },
      }),
    },
  })
const server = await start()
const url = `http://127.0.0.1:${server.address.port}`
const authorization = `Basic ${Buffer.from(`opencode:${input.password}`).toString("base64")}`
const client = OpenCode.make({ baseUrl: url, headers: { authorization } })
assert.equal((await fetch(`${url}/api/info`)).status, 401)
assert.equal(
  (await fetch(`${url}/api/info`, { headers: { authorization, origin: "https://hostile.invalid" } })).status,
  403,
)
const allowed = await fetch(`${url}/api/info`, { headers: { authorization, origin: "oc://renderer" } })
assert.equal(allowed.headers.get("access-control-allow-origin"), "oc://renderer")
assert.equal((await client.server.info()).version, "2.2.5")
assert.equal((await client.session.get({ sessionID })).title, "Preserved title")
assert.equal((await client.session.get({ sessionID: "ses_previous_next" })).id, "ses_previous_next")
const previousMessages = await client.message.list({ sessionID: "ses_previous_next" })
assert.ok(JSON.stringify(previousMessages).includes("Previous next history"))
assert.ok(JSON.stringify(previousMessages).includes("msg_previous_next"))
const messages = await client.message.list({ sessionID })
assert.ok(JSON.stringify(messages).includes("Preserve this history exactly."))
assert.ok(JSON.stringify(messages).includes(messageID))
let plugins
for (let attempt = 0; attempt < 100; attempt++) {
  plugins = await client.plugin.list({ location: { directory: root } })
  if (JSON.stringify(plugins).includes("cm-runtime-probe")) break
  await new Promise((resolve) => setTimeout(resolve, 50))
}
assert.ok(JSON.stringify(plugins).includes("cookiemonster.wpp"), JSON.stringify(plugins))
assert.ok(JSON.stringify(plugins).includes("cm-runtime-probe"))
assert.ok(!JSON.stringify(plugins).includes('"status":"error"'), JSON.stringify(plugins))
const task = await client.session.create({
  location: { directory: root },
  model: { providerID: "cookiemonster", id: "m" },
})
await client.session.prompt({ sessionID: task.id, text: "Use cm_runtime_probe to report native tool works." })
await client.experimental.session.wait({ sessionID: task.id }, { signal: AbortSignal.timeout(15000) })
const result = await client.message.list({ sessionID: task.id })
assert.ok(
  result.data.some((message) => message.type === "assistant" && JSON.stringify(message).includes("V2_TOOL_OK")),
  JSON.stringify(result),
)
const primary = requests.filter((request) =>
  request.body.tools?.some((tool) => tool.function.name === "cm_runtime_probe"),
)
assert.ok(primary.length >= 2, "Native plugin tool did not execute and continue")
assert.ok(
  primary[1].body.messages.some((message) => message.role === "tool" && message.content.includes("native tool works")),
)
assert.equal(primary[0].headers["x-opencode-client"], "desktop")
assert.equal(primary[0].headers["x-opencode-session-id"], task.id)
assert.match(primary[0].headers["x-opencode-runtime-id"], /^[a-f0-9-]{36}$/)
assert.equal(primary[0].headers["x-opencode-runtime-id"], primary[1].headers["x-opencode-runtime-id"])
await assert.rejects(Server.listen({ ...input, port: server.address.port, database: target }))
await server.stop()
await server.stop()
const projected = new DatabaseSync(target, { readOnly: true })
const records = projected.prepare("SELECT id,data FROM session_message ORDER BY id").all()
assert.equal(projected.prepare("SELECT count(*) AS n FROM message").get().n, 1)
projected.close()
const restarted = await start("new-fixture-secret")
const reopened = new DatabaseSync(target, { readOnly: true })
assert.deepEqual(reopened.prepare("SELECT id,data FROM session_message ORDER BY id").all(), records)
reopened.close()
assert.equal(
  (await fetch(`http://127.0.0.1:${restarted.address.port}/api/info`, { headers: { authorization } })).status,
  401,
)
await restarted.stop()
await new Promise((resolve) => model.close(resolve))
assert.equal(await digest(), before)
assert.equal(
  createHash("sha256")
    .update(await readFile(previousPath))
    .digest("hex"),
  previousDigest,
)
console.log(
  "Runtime fixture passed: authenticated startup, origin protection, exact SDK plugin load, native history import, idempotence, original preserved, lifecycle cleanup",
)
