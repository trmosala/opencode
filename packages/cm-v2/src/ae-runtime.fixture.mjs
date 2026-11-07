import assert from "node:assert/strict"
import { createServer } from "node:http"
import { readFile, writeFile, mkdir } from "node:fs/promises"
import { join } from "node:path"
import { setTimeout as delay } from "node:timers/promises"
import { OpenCode } from "@opencode/client"
const { Server } = await import(process.env.CM_V2_TEST_RUNTIME ?? "../dist/runtime.js")
const root = process.env.FIXTURE_ROOT
assert.ok(root)
process.chdir(root)
const plugin = process.env.CM_V2_AE_PATH
assert.ok(plugin)
const dataDir = join(root, "ae-data")
const requests = [],
  commands = []
let holding = false
const model = createServer(async (request, response) => {
  const chunks = []
  for await (const chunk of request) chunks.push(chunk)
  const body = JSON.parse(Buffer.concat(chunks))
  requests.push(body)
  const primary = body.tools?.some((tool) => tool.function.name === "ae_inspect")
  const at = body.messages.findLastIndex(
    (message) => message.role === "user" && /AE_(READ|MUTATE|DENY|HOLD|ERROR)/.test(JSON.stringify(message)),
  )
  const text = JSON.stringify(body.messages[at])
  const history = body.messages.slice(at + 1)
  if (primary && text.includes("AE_HOLD")) {
    holding = true
    response.writeHead(200, { "content-type": "text/event-stream" })
    response.write(
      `data: ${JSON.stringify({ id: "fixture", object: "chat.completion.chunk", created: 1, model: "m", choices: [{ index: 0, delta: { role: "assistant", content: "AE_PARTIAL_STREAM" }, finish_reason: null }] })}\n\n`,
    )
    return
  }
  if (primary && text.includes("AE_ERROR")) {
    response.writeHead(400, { "content-type": "application/json" })
    response.end(JSON.stringify({ error: { message: "AE_FIXTURE_MODEL_ERROR", type: "invalid_request_error" } }))
    return
  }
  const output = history.filter((message) => message.role === "tool")
  const call = (name, args) => ({
    role: "assistant",
    tool_calls: [
      {
        index: 0,
        id: `call_${requests.length}`,
        type: "function",
        function: { name, arguments: JSON.stringify(args) },
      },
    ],
  })
  let delta = { role: "assistant", content: primary ? "AE_ASSISTANT_CONTINUATION_OK" : "AE fixture title" }
  if (primary && !output.length)
    delta = call(text.includes("AE_DENY") ? "ae_grant" : "ae_inspect", text.includes("AE_DENY") ? { path: root } : {})
  if (primary && text.includes("AE_MUTATE") && output.length === 1) {
    const result = JSON.parse(typeof output[0].content === "string" ? output[0].content : output[0].content[0].text)
    delta = call("ae_execute", {
      source: "return { changed: true };",
      label: "Fixture edit",
      expectedRevision: result.expectedRevision,
    })
  }
  const chunk = (value, finish) =>
    `data: ${JSON.stringify({ id: "fixture", object: "chat.completion.chunk", created: 1, model: "m", choices: [{ index: 0, delta: value, finish_reason: finish }] })}\n\n`
  response.writeHead(200, { "content-type": "text/event-stream" })
  response.end(chunk(delta, null) + chunk({}, delta.tool_calls ? "tool_calls" : "stop") + "data: [DONE]\n\n")
})
await new Promise((resolve) => model.listen(0, "127.0.0.1", resolve))
let runtime, pump
const pumping = { active: false }
const config = {
  project: false,
  claude: false,
  content: JSON.stringify({
    plugin: [
      [
        plugin,
        { dataDir, timeoutMs: 2000, heartbeatMs: 60000, releaseMetadata: { cookieMonsterVersion: "2.2.5-cm.fixture" } },
      ],
    ],
    model: "mock/m",
    snapshots: false,
    permission: { ae_grant: "deny" },
    provider: {
      mock: {
        npm: "@ai-sdk/openai-compatible",
        options: { baseURL: `http://127.0.0.1:${model.address().port}/v1`, apiKey: "fixture" },
        models: { m: { name: "AE fixture", tool_call: true }, m2: { name: "Second AE fixture", tool_call: true } },
      },
    },
  }),
}
try {
  runtime = await Server.listen({
    hostname: "127.0.0.1",
    port: 0,
    password: "ae-fixture",
    database: join(root, "db.sqlite"),
    config,
  })
  const baseUrl = `http://127.0.0.1:${runtime.address.port}`
  const client = OpenCode.make({
    baseUrl,
    headers: { authorization: `Basic ${Buffer.from("opencode:ae-fixture").toString("base64")}` },
  })
  await client.agent.list({ location: { directory: root } })
  const plugins = await client.plugin.list({ location: { directory: root } })
  console.log(
    "AE plugin roster",
    JSON.stringify(plugins.data.filter((plugin) => JSON.stringify(plugin).includes("cm-ae"))),
  )
  assert.ok(JSON.stringify(plugins).includes('"cm-ae"'), JSON.stringify(plugins))
  const descriptor = JSON.parse(await readFile(join(dataDir, "descriptor.json"), "utf8"))
  assert.equal(descriptor.version, "0.2.3")
  const bootstrap = JSON.parse(await readFile(join(dataDir, "automatic-connection.json"), "utf8"))
  let credential
  const send = async (endpoint, body) => {
    const response = await fetch(`http://127.0.0.1:${descriptor.port}${endpoint}`, {
      method: endpoint === "/poll" ? "GET" : "POST",
      headers: { "content-type": "application/json", ...(credential ? { authorization: `Bearer ${credential}` } : {}) },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      signal: AbortSignal.timeout(10000),
    })
    const value = await response.json()
    if (value.error) throw Object.assign(new Error(value.error.message), value.error)
    assert.equal(response.status, 200)
    return value
  }
  const paired = await send("/pair", {
    protocol: descriptor.protocol,
    version: descriptor.version,
    panelId: "ae-v2-fixture",
    code: bootstrap.code,
  })
  credential = paired.credential
  assert.ok(JSON.stringify(paired).includes("2.2.5-cm.fixture"), "Release metadata crosses the directory wrapper")
  const state = {
    project: { id: "fixture-project", saved: true, path: join(root, "fixture.aep") },
    items: [],
    selection: [],
    installedEffects: [],
    activeCompId: null,
    capabilities: { fileNetwork: true },
    busy: false,
    revision: 1,
    projectEpoch: "fixture-epoch",
    aeVersion: "26.0-fixture",
    fingerprint: "fixture",
    nextCursor: null,
  }
  await writeFile(state.project.path, JSON.stringify(state))
  await send("/connect", {
    protocol: descriptor.protocol,
    version: descriptor.version,
    panelId: "ae-v2-fixture",
    aeVersion: state.aeVersion,
    project: state.project,
    capabilities: state.capabilities,
  })
  pumping.active = true
  pump = (async () => {
    while (pumping.active) {
      const { command } = await send("/poll")
      if (!command) {
        await delay(5)
        continue
      }
      commands.push(command)
      await send("/heartbeat", { project: state.project, capabilities: state.capabilities, busy: true })
      let result
      if (command.method === "inspect") result = structuredClone(state)
      if (command.method === "save") {
        await writeFile(state.project.path, JSON.stringify(state))
        result = { project: state.project }
      }
      if (command.method === "raw") {
        assert.equal(command.params.expectedRevision, state.revision)
        assert.equal(command.params.expectedEpoch, state.projectEpoch)
        state.revision++
        state.items.push({ id: 1, kind: "comp", name: "Fixture edited" })
        result = { value: { changed: true }, revision: state.revision, project: state.project }
      }
      assert.ok(result, `Unexpected fixture AE command ${command.method}`)
      await send("/reply", { id: command.id, result })
    }
  })()
  const chat = async (body = {}) => (await send("/chat", { action: "state", project: state.project, ...body })).result
  const wait = async (check, label) => {
    const deadline = Date.now() + 20000
    while (Date.now() < deadline) {
      const value = await check()
      if (value) return value
      await delay(20)
    }
    throw new Error(`Timeout: ${label}`)
  }
  const submit = async (text, suffix, extra = {}) =>
    chat({ action: "send", text, compId: null, requestId: suffix.repeat(40), ...extra })
  const first = await submit("AE_READ", "a", {
    attachments: [{ filename: "fixture.txt", mime: "text/plain", url: "data:text/plain;base64,Zml4dHVyZQ==" }],
  })
  assert.equal(first.delivery, "accepted")
  await client.experimental.session.wait({ sessionID: first.sessionID })
  const read = await chat()
  assert.equal(read.status, "idle")
  assert.ok(JSON.stringify(read.messages).includes("AE_ASSISTANT_CONTINUATION_OK"), JSON.stringify(read))
  assert.ok(JSON.stringify(read.messages).includes("ae_inspect"))
  assert.equal(read.messages.filter((message) => message.role === "user").length, 1)
  const draft = await chat({
    action: "retryDraft",
    expectedSessionID: first.sessionID,
    messageID: read.messages.find((message) => message.role === "user").id,
  })
  assert.equal(draft.text, "AE_READ")
  assert.equal(draft.attachments[0].filename, "fixture.txt")
  assert.ok(requests.some((body) => JSON.stringify(body.messages).includes("After Effects chat panel")))
  const foreign = await client.session.create({
    location: { directory: root },
    permissions: [{ action: "ae_inspect", resource: "*", effect: "ask" }],
  })
  const beforeForeign = commands.length
  await client.session.prompt({ sessionID: foreign.id, text: "AE_READ" })
  const readApproval = await wait(
    async () => (await client.permission.list({ sessionID: foreign.id }))[0],
    "Session read ask rule",
  )
  assert.equal(readApproval.action, "ae_inspect")
  await client.permission.reply({ sessionID: foreign.id, requestID: readApproval.id, decision: "once" })
  await client.experimental.session.wait({ sessionID: foreign.id })
  assert.equal(commands.length, beforeForeign, "Another Session must not inspect the owned native binding")
  assert.match(JSON.stringify(await client.message.list({ sessionID: foreign.id })), /binding_owned|owns|controls/i)
  const modelList = await chat({ action: "models" })
  assert.ok(modelList.models.some((model) => model.id === "m2"))
  await chat({ action: "model", model: { providerID: "mock", id: "m2", variant: "default" } })
  assert.equal((await chat()).model.id, "m2")
  // A Session allow cannot remove mandatory native script review.
  await client.session.update({
    sessionID: first.sessionID,
    permissions: [{ action: "ae_execute", resource: "*", effect: "allow" }],
  })
  const edited = await submit("AE_MUTATE", "b")
  const approval = await wait(async () => (await chat()).permissions[0], "AE approval event")
  assert.ok(approval.id.startsWith("per"), approval.id)
  assert.match(approval.details, /return \{ changed: true \}/)
  await chat({ action: "permission", permissionId: approval.id, response: "once" })
  await client.experimental.session.wait({ sessionID: edited.sessionID })
  assert.equal(state.revision, 2)
  const mutation = await chat()
  assert.equal(mutation.permissions.length, 0)
  assert.ok(
    mutation.messages.flatMap((message) => message.parts).some((part) => part.type === "checkpoint"),
    JSON.stringify(mutation),
  )
  assert.equal(commands.filter((command) => command.method === "raw").length, 1)
  assert.ok(
    requests.some((body) =>
      body.messages.some((message) => message.role === "tool" && JSON.stringify(message).includes("checkpointId")),
    ),
  )
  await submit("AE_MUTATE", "f")
  const rejected = await wait(async () => (await chat()).permissions[0], "second native mutation approval")
  await chat({ action: "permission", permissionId: rejected.id, response: "reject" })
  await client.experimental.session.wait({ sessionID: first.sessionID })
  assert.equal(
    commands.filter((command) => command.method === "raw").length,
    1,
    "Rejected native mutation never dispatches",
  )
  const beforeDeny = commands.length
  await submit("AE_DENY", "c")
  await client.experimental.session.wait({ sessionID: first.sessionID })
  assert.equal(
    commands.filter((command) => command.method !== "inspect").length,
    commands.slice(0, beforeDeny).filter((command) => command.method !== "inspect").length,
  )
  const denied = requests.findLast((body) => JSON.stringify(body.messages).includes("AE_DENY") && body.tools?.length)
  assert.ok(denied && !denied.tools.some((tool) => tool.function.name === "ae_grant"))
  await submit("AE_HOLD", "d")
  await wait(() => holding, "held model request")
  const partial = await wait(async () => {
    const snapshot = await chat()
    return JSON.stringify(snapshot.messages).includes("AE_PARTIAL_STREAM") ? snapshot : undefined
  }, "streamed panel projection")
  assert.equal(partial.status, "running")
  assert.ok(
    partial.messages.some(
      (message) =>
        message.role === "assistant" && !message.completed && JSON.stringify(message).includes("AE_PARTIAL_STREAM"),
    ),
  )
  await client.session.prompt({
    sessionID: first.sessionID,
    text: "SHOULD_BE_CANCELLED",
    delivery: "queue",
    resume: false,
  })
  await chat({ action: "stop" })
  assert.equal((await client.session.inbox.list({ sessionID: first.sessionID })).length, 0)
  assert.equal((await chat()).status, "idle")
  const second = await chat({ action: "new" })
  assert.notEqual(second.sessionID, first.sessionID)
  await chat({ action: "rename", sessionID: second.sessionID, directory: root, title: "AE renamed" })
  assert.equal((await chat()).title, "AE renamed")
  const technique = {
    name: "ae-fixture",
    description: "AE fixture technique",
    instructions: "Inspect before editing.",
    scope: "global",
  }
  const review = await chat({ action: "skillReview", directory: root, sessionID: second.sessionID, draft: technique })
  const saved = await chat({
    action: "skillSave",
    directory: root,
    sessionID: second.sessionID,
    draft: technique,
    token: review.token,
  })
  const catalog = await chat({ action: "skills" })
  assert.ok(catalog.skills.some((skill) => skill.name === technique.name && skill.revision === saved.revision))
  const selected = { name: saved.name, source: saved.source, revision: saved.revision }
  const managed = await chat({
    action: "skillManage",
    sessionID: second.sessionID,
    directory: root,
    management: { action: "read", selected },
  })
  assert.ok(managed.content.includes(technique.instructions))
  await submit("AE_READ with a selected technique", "1", {
    skill: {
      name: saved.name,
      source: saved.source,
      revision: saved.revision,
      directory: root,
      sessionID: second.sessionID,
    },
  })
  await client.experimental.session.wait({ sessionID: second.sessionID })
  const skilled = await chat()
  assert.ok(
    skilled.messages
      .flatMap((message) => message.parts)
      .some((part) => part.type === "skill" && part.name === technique.name),
    JSON.stringify(skilled),
  )
  await submit("AE_ERROR", "e")
  await client.experimental.session.wait({ sessionID: second.sessionID })
  await wait(async () => (await chat()).error, "AE execution error event")
  const conversations = await chat({ action: "conversations" })
  assert.equal(conversations.total, 2)
  await chat({ action: "reopen", sessionID: first.sessionID, directory: root })
  assert.equal((await chat()).sessionID, first.sessionID)
  await client.session.remove({ sessionID: first.sessionID })
  await wait(async () => (await chat()).missing, "AE deleted session")
  const afterDelete = commands.length
  await client.session.prompt({ sessionID: foreign.id, text: "AE_READ after deletion" })
  const nextRead = await wait(
    async () => (await client.permission.list({ sessionID: foreign.id }))[0],
    "Session ask after owner deletion",
  )
  await client.permission.reply({ sessionID: foreign.id, requestID: nextRead.id, decision: "once" })
  await client.experimental.session.wait({ sessionID: foreign.id })
  assert.ok(commands.length > afterDelete, "Deleted owner releases its native binding")
  // Activating a second workspace shares the real vendored runtime and does not close the first one.
  const other = join(root, "other")
  await mkdir(other)
  await client.agent.list({ location: { directory: other } })
  assert.ok(JSON.stringify(await client.plugin.list({ location: { directory: other } })).includes('"cm-ae"'))
  await send("/heartbeat", { project: state.project, capabilities: state.capabilities, busy: false })
  const code = await readFile(new URL("render-worker.mjs", plugin.endsWith("/") ? plugin : plugin + "/"), "utf8")
  assert.ok(code.length > 1000)
  const worker = await import(new URL("render-worker.mjs", plugin.endsWith("/") ? plugin : plugin + "/").href)
  assert.equal(typeof worker.runWorker, "function")
  pumping.active = false
  await pump
  await runtime.stop()
  runtime = undefined
  await assert.rejects(readFile(join(dataDir, "descriptor.json")), { code: "ENOENT" })
  console.log(
    "AE_V2_RUNTIME_FIXTURE_PASSED",
    JSON.stringify({
      node: process.versions.node,
      commands: commands.map((command) => command.method),
      modelRequests: requests.length,
      sessions: 3,
      directory: plugin,
    }),
  )
} finally {
  pumping.active = false
  await pump
  await runtime?.stop()
  model.closeAllConnections()
  await new Promise((resolve) => model.close(resolve))
}
// Electron's parent port keeps a completed fixture alive; all runtime/host cleanup has settled above.
if (process.parentPort) process.stdout.write("", () => process.exit(0))
