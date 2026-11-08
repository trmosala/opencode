import assert from "node:assert/strict"
import { createServer } from "node:http"
import { mkdir, readFile, writeFile } from "node:fs/promises"
import { join } from "node:path"
import { execFile } from "node:child_process"
import { promisify } from "node:util"
import { OpenCode } from "@opencode/client"
const { Server } = await import(process.env.CM_V2_TEST_RUNTIME ?? "../dist/runtime.js")

const root = process.env.FIXTURE_ROOT
assert.ok(root)
process.chdir(root)
const requests = []
let releaseBusy
let busyHeld = false
let signedIn = true
let loginRequests = 0
const model = createServer(async (request, response) => {
  if (request.url === "/bridge/auth") {
    response.writeHead(200, { "content-type": "application/json" })
    response.end(JSON.stringify({ status: signedIn ? "signed-in" : "signed-out" }))
    return
  }
  if (request.url === "/bridge/login") {
    loginRequests++
    response.end("ok")
    return
  }
  const chunks = []
  for await (const chunk of request) chunks.push(chunk)
  const body = JSON.parse(Buffer.concat(chunks).toString())
  requests.push(body)
  const primary = body.tools?.some((tool) => tool.function.name === "schedule")
  if (primary && !busyHeld && JSON.stringify(body.messages).includes("BUSY_HOLD")) {
    busyHeld = true
    await new Promise((resolve) => {
      releaseBusy = resolve
    })
  }
  const createSchedule = primary && JSON.stringify(body.messages).includes("USE_SCHEDULE_CREATE")
  const callSchedule =
    primary &&
    (createSchedule || JSON.stringify(body.messages).includes("USE_SCHEDULE_TOOL")) &&
    !body.messages.some((message) => message.role === "tool")
  const delta = callSchedule
    ? {
        role: "assistant",
        tool_calls: [
          {
            index: 0,
            id: "call_schedule",
            type: "function",
            function: {
              name: "schedule",
              arguments: JSON.stringify(
                createSchedule
                  ? {
                      action: "create",
                      definition: {
                        schemaVersion: 1,
                        name: "Tool-created schedule",
                        prompt: "Return SCHEDULE_OK",
                        target: { type: "new_session", directory: root, workspace: { type: "local" } },
                        schedule: { type: "once", at: new Date(Date.now() + 3600000).toISOString() },
                      },
                    }
                  : { action: "list" },
              ),
            },
          },
        ],
      }
    : { role: "assistant", content: "SCHEDULE_OK" }
  const chunk = (delta, finish_reason) =>
    `data: ${JSON.stringify({ id: "fixture", object: "chat.completion.chunk", created: 1, model: "m", choices: [{ index: 0, delta, finish_reason }] })}\n\n`
  response.writeHead(200, { "content-type": "text/event-stream" })
  response.end(chunk(delta, null) + chunk({}, callSchedule ? "tool_calls" : "stop") + "data: [DONE]\n\n")
})
await new Promise((resolve) => model.listen(0, "127.0.0.1", resolve))
process.env.O1_CODE_PROXY_PORT = String(model.address().port)
const config = {
  project: true,
  claude: false,
  content: JSON.stringify({
    model: "cookiemonster/m",
    snapshots: false,
    provider: {
      cookiemonster: {
        npm: "@ai-sdk/openai-compatible",
        options: { baseURL: `http://127.0.0.1:${model.address().port}/v1`, apiKey: "fixture" },
        models: { m: { name: "Fixture", tool_call: true }, m2: { name: "Selected fixture", tool_call: true } },
      },
    },
  }),
}
const input = {
  hostname: "127.0.0.1",
  port: 0,
  password: "feature-secret",
  database: join(root, "fixture.db"),
  config,
  cli: process.env.CM_V2_CLI,
}
const store = join(process.env.XDG_DATA_HOME, "opencode/scheduling/schedules.json")
await mkdir(join(process.env.XDG_DATA_HOME, "opencode/scheduling"), { recursive: true })
const legacyDefinition = {
  schemaVersion: 1,
  name: "Retained V1 JSON task",
  prompt: "Do not run",
  enabled: false,
  target: { type: "existing_session", sessionID: "ses_legacy_fixture" },
  schedule: { type: "once", at: "2026-12-01T00:00:00Z" },
}
await writeFile(
  store,
  JSON.stringify({
    version: 1,
    schedules: [
      { id: "sch_legacy_fixture", revision: 7, definition: legacyDefinition, directory: root, runs: 3, deleted: false },
    ],
    occurrences: [],
  }),
)
let server = await Server.listen(input)
let url = `http://127.0.0.1:${server.address.port}`
const authorization = `Basic ${Buffer.from(`opencode:${input.password}`).toString("base64")}`
let client = OpenCode.make({ baseUrl: url, headers: { authorization } })
const request = async (path, body) => {
  const response = await fetch(`${url}${path}`, {
    method: body ? "POST" : "GET",
    headers: { authorization, "content-type": "application/json" },
    ...(body ? { body: JSON.stringify(body) } : {}),
  })
  const data = await response.json()
  return { status: response.status, data }
}
const poll = async (fn) => {
  for (let attempt = 0; attempt < 200; attempt++) {
    const value = await fn()
    if (value) return value
    await new Promise((resolve) => setTimeout(resolve, 50))
  }
  throw new Error("Fixture condition timed out")
}
try {
  for (const path of ["/schedule", `/skill/catalog?directory=${encodeURIComponent(root)}`]) {
    assert.equal((await fetch(url + path)).status, 401)
    assert.equal(
      (await fetch(url + path, { headers: { authorization, origin: "https://hostile.invalid" } })).status,
      403,
    )
    const allowed = await fetch(url + path, { headers: { authorization, origin: "oc://renderer" } })
    assert.equal(allowed.status, 200, await allowed.text())
    assert.equal(allowed.headers.get("access-control-allow-origin"), "oc://renderer")
  }
  const retained = (await request("/schedule")).data.schedules.find((item) => item.id === "sch_legacy_fixture")
  assert.equal(retained.revision, 7)
  assert.equal(retained.runs, 3)
  assert.equal(retained.definition.enabled, false)
  const skillPath = (name) => `/skill/${name}?directory=${encodeURIComponent(root)}`
  const draft = { name: "fixture-skill", description: "Fixture skill", instructions: "SKILL_FIRST", scope: "workspace" }
  const reviewed = await request(skillPath("review"), draft)
  assert.equal(reviewed.status, 200, JSON.stringify(reviewed))
  const created = await request(skillPath("create"), { ...draft, token: reviewed.data.token })
  assert.equal(created.status, 200, JSON.stringify(created))
  assert.equal((await request(skillPath("create"), { ...draft, token: reviewed.data.token })).status, 400)
  const catalog = await request(skillPath("catalog"))
  const selected = catalog.data.find((skill) => skill.name === draft.name)
  assert.ok(selected)
  const task = await client.session.create({
    location: { directory: root },
    model: { providerID: "cookiemonster", id: "m" },
  })
  const initialSelection = await request(skillPath("select"), { sessionID: task.id, selected: [selected] })
  assert.equal(initialSelection.status, 200, JSON.stringify(initialSelection))
  const denied = await client.session.create({
    location: { directory: root },
    model: { providerID: "cookiemonster", id: "m" },
    permissions: [{ action: "skill", resource: "fixture-skill", effect: "deny" }],
  })
  const refused = await request(skillPath("select"), { sessionID: denied.id, selected: [selected] })
  assert.equal(refused.status, 400)
  assert.ok(refused.data.message.includes("denied"))
  assert.equal(
    (await client.message.list({ sessionID: denied.id })).data.filter((message) => message.type === "skill").length,
    0,
  )
  const edit = { action: "review", selected, operation: "edit", draft: { ...draft, instructions: "SKILL_EDITED" } }
  const revision = await request(skillPath("manage"), edit)
  assert.equal(revision.status, 200, JSON.stringify(revision))
  const updated = await request(skillPath("manage"), { ...edit, action: "apply", token: revision.data.token })
  assert.equal(updated.status, 200, JSON.stringify(updated))
  assert.ok((await readFile(updated.data.backup, "utf8")).includes("SKILL_FIRST"))
  assert.equal((await request(skillPath("select"), { sessionID: task.id, selected: [selected] })).status, 400)
  const refreshed = (await request(skillPath("catalog"))).data.find((skill) => skill.name === draft.name)
  assert.notEqual(refreshed.revision, selected.revision)
  assert.equal((await request(skillPath("select"), { sessionID: task.id, selected: [refreshed] })).status, 200)
  // Different sources can have the same native folder ID. Activate the selected source, not whichever scan wins.
  const otherRoot = join(process.env.XDG_CONFIG_HOME, "opencode/skills/fixture-skill")
  await mkdir(otherRoot, { recursive: true })
  await writeFile(join(otherRoot, "SKILL.md"), "---\nname: other-source\ndescription: Other source\n---\nOTHER_SOURCE")
  const other = (await request(skillPath("catalog"))).data.find((skill) => skill.name === "other-source")
  assert.ok(other)
  assert.equal((await request(skillPath("select"), { sessionID: task.id, selected: [other] })).status, 200)
  assert.equal((await request(skillPath("select"), { sessionID: task.id, selected: [refreshed] })).status, 200)
  const selectedHistory = await client.message.list({ sessionID: task.id })
  assert.ok(JSON.stringify(selectedHistory).includes("SKILL_EDITED"), JSON.stringify(selectedHistory))
  assert.equal(selectedHistory.data.find((message) => message.type === "skill").text, "SKILL_EDITED")
  const invalidDraft = { ...draft, name: "../escape" }
  assert.equal((await request(skillPath("review"), invalidDraft)).status, 400)
  const definition = {
    schemaVersion: 1,
    name: "Fixture schedule",
    prompt: "Return SCHEDULE_OK",
    target: {
      type: "new_session",
      directory: root,
      workspace: { type: "local" },
      model: { providerID: "cookiemonster", id: "m" },
    },
    schedule: { type: "once", at: new Date(Date.now() + 1200).toISOString() },
  }
  const scheduled = await request("/schedule", { action: "create", definition })
  assert.equal(scheduled.status, 200, JSON.stringify(scheduled))
  const complete = await poll(async () =>
    (await request("/schedule")).data.occurrences.find(
      (item) => item.scheduleID === scheduled.data.id && ["completed", "attention"].includes(item.state),
    ),
  )
  assert.equal(complete.state, "completed", JSON.stringify(complete))
  assert.ok(complete.admitted)
  const messages = await client.message.list({ sessionID: complete.sessionID })
  assert.equal(messages.data.filter((message) => message.id === complete.promptID).length, 1)
  assert.ok(JSON.stringify(messages).includes("SCHEDULE_OK"))
  const existing = await request("/schedule", {
    action: "create",
    definition: {
      ...definition,
      target: { type: "existing_session", sessionID: task.id },
      schedule: { type: "once", at: new Date(Date.now() + 1200).toISOString() },
    },
  })
  assert.equal(existing.status, 200, JSON.stringify(existing))
  const previous = await poll(async () =>
    (await request("/schedule")).data.occurrences.find(
      (item) => item.scheduleID === existing.data.id && ["completed", "attention"].includes(item.state),
    ),
  )
  assert.equal(previous.state, "completed", JSON.stringify(previous))
  assert.ok(
    requests.some((body) => JSON.stringify(body.messages).includes("SKILL_EDITED")),
    "Edited skill never reached the actual model context",
  )
  // A busy target stays pending without steering or admitting over the active turn.
  const busy = await client.session.create({
    location: { directory: root },
    model: { providerID: "cookiemonster", id: "m" },
  })
  await client.session.prompt({ sessionID: busy.id, text: "BUSY_HOLD" })
  await poll(async () => busyHeld)
  const deferred = await request("/schedule", {
    action: "create",
    definition: {
      ...definition,
      target: { type: "existing_session", sessionID: busy.id },
      schedule: { type: "once", at: new Date(Date.now() + 1200).toISOString() },
    },
  })
  const pending = await poll(async () =>
    (await request("/schedule")).data.occurrences.find(
      (item) => item.scheduleID === deferred.data.id && item.state === "pending" && item.detail?.includes("idle"),
    ),
  )
  assert.equal(pending.admitted, false)
  assert.equal(pending.state, "pending")
  releaseBusy()
  await poll(async () =>
    (await request("/schedule")).data.occurrences.find((item) => item.id === pending.id && item.state === "completed"),
  )
  // Execute the deployed schedule plugin through the native tool loop.
  const toolTask = await client.session.create({
    location: { directory: root },
    model: { providerID: "cookiemonster", id: "m" },
  })
  await client.session.prompt({ sessionID: toolTask.id, text: "USE_SCHEDULE_TOOL" })
  await client.experimental.session.wait({ sessionID: toolTask.id })
  assert.ok(
    requests.some((body) =>
      body.messages.some((message) => message.role === "tool" && message.content.includes(scheduled.data.id)),
    ),
    "Native schedule tool did not return the JSON store",
  )
  const creator = await client.session.create({
    location: { directory: root },
    model: { providerID: "cookiemonster", id: "m2" },
    permissions: [{ action: "schedule", resource: "*", effect: "allow" }],
  })
  await client.session.prompt({ sessionID: creator.id, text: "USE_SCHEDULE_CREATE" })
  await client.experimental.session.wait({ sessionID: creator.id })
  const inherited = (await request("/schedule")).data.schedules.find(
    (item) => item.definition.name === "Tool-created schedule",
  )
  assert.ok(
    inherited,
    "Native schedule mutation tool did not execute: " +
      JSON.stringify(await client.message.list({ sessionID: creator.id })),
  )
  assert.equal(inherited.definition.target.model.id, "m2", "Schedule ignored the caller's selected model")
  assert.equal(inherited.definition.target.agent, "build")
  signedIn = false
  const waiting = await request("/schedule", {
    action: "create",
    definition: { ...definition, schedule: { type: "once", at: new Date(Date.now() + 1200).toISOString() } },
  })
  const awaiting = await poll(async () =>
    (await request("/schedule")).data.occurrences.find(
      (item) => item.scheduleID === waiting.data.id && item.state === "awaiting_auth",
    ),
  )
  assert.equal(awaiting.admitted, false)
  assert.equal(loginRequests, 1)
  signedIn = true
  await poll(async () =>
    (await request("/schedule")).data.occurrences.find((item) => item.id === awaiting.id && item.state === "completed"),
  )
  const state = (await request("/schedule")).data
  const removal = await request(skillPath("manage"), { action: "review", selected: refreshed, operation: "delete" })
  assert.equal(removal.status, 200)
  const deleted = await request(skillPath("manage"), {
    action: "apply",
    selected: refreshed,
    operation: "delete",
    token: removal.data.token,
  })
  assert.equal(deleted.status, 200, JSON.stringify(deleted))
  assert.equal(deleted.data.deleted, true)
  assert.ok((await readFile(deleted.data.backup, "utf8")).includes("SKILL_EDITED"))
  assert.ok(!(await request(skillPath("catalog"))).data.some((skill) => skill.name === draft.name))
  const uncertain = await client.session.create({
    location: { directory: root },
    model: { providerID: "cookiemonster", id: "m" },
  })
  const uncertainPromptID = "msg_uncertain_occurrence"
  await client.session.prompt({
    sessionID: uncertain.id,
    id: uncertainPromptID,
    text: "Uncertain fixture",
    delivery: "queue",
    resume: false,
  })
  // Exact retry is admit-only and must retain one durable inbox entry.
  await client.session.prompt({
    sessionID: uncertain.id,
    id: uncertainPromptID,
    text: "Uncertain fixture",
    delivery: "queue",
    resume: false,
  })
  assert.equal(
    (await client.session.inbox.list({ sessionID: uncertain.id })).filter((entry) => entry.id === uncertainPromptID)
      .length,
    1,
  )
  const count = requests.length
  await server.stop()
  const file = join(process.env.XDG_DATA_HOME, "opencode/scheduling/schedules.json")
  const persisted = JSON.parse(await readFile(file, "utf8"))
  // Simulate death after provider completion but before occurrence bookkeeping.
  persisted.occurrences.find((item) => item.id === complete.id).state = "dispatching"
  const uncertainSchedule = {
    ...persisted.schedules.find((item) => item.id === scheduled.data.id),
    id: "sch_uncertain",
    runs: 0,
    next: undefined,
  }
  persisted.schedules.push(uncertainSchedule)
  persisted.occurrences.push({
    ...complete,
    id: "occ_uncertain",
    scheduleID: uncertainSchedule.id,
    sessionID: uncertain.id,
    promptID: uncertainPromptID,
    state: "dispatching",
    admitted: false,
  })
  await writeFile(file, JSON.stringify(persisted))
  server = await Server.listen(input)
  url = `http://127.0.0.1:${server.address.port}`
  client = OpenCode.make({ baseUrl: url, headers: { authorization } })
  const recovered = (await request("/schedule")).data
  assert.equal(recovered.occurrences.find((item) => item.id === complete.id).state, "completed")
  assert.deepEqual(
    recovered.schedules.filter((item) => item.id !== "sch_uncertain").map((item) => item.id),
    state.schedules.map((item) => item.id),
  )
  const uncertainRun = recovered.occurrences.find((item) => item.id === "occ_uncertain")
  assert.equal(uncertainRun.state, "attention")
  assert.equal(uncertainRun.admitted, true)
  assert.equal(recovered.schedules.find((item) => item.id === "sch_uncertain").runs, 1)
  assert.equal(requests.length, count, "Restart replayed provider work")
  const projectRoot = join(root, "reset-project")
  const worktree = join(root, "reset-linked")
  await mkdir(projectRoot)
  const exec = promisify(execFile)
  const git = async (directory, args) => (await exec("git", ["-C", directory, ...args])).stdout
  await git(projectRoot, ["init", "-b", "main"])
  await git(projectRoot, ["config", "user.name", "Fixture"])
  await git(projectRoot, ["config", "user.email", "fixture@example.invalid"])
  await writeFile(join(projectRoot, "tracked.txt"), "original")
  await git(projectRoot, ["add", "."])
  await git(projectRoot, ["commit", "-m", "fixture"])
  await git(projectRoot, ["worktree", "add", "-b", "reset-test", worktree])
  const resetPath = `/worktree/reset?directory=${encodeURIComponent(projectRoot)}`
  await writeFile(join(worktree, "tracked.txt"), "changed")
  await writeFile(join(worktree, "untracked.txt"), "discard")
  assert.equal(
    (await fetch(url + resetPath, { method: "POST", body: JSON.stringify({ directory: worktree }) })).status,
    401,
  )
  assert.equal((await request(resetPath, { directory: projectRoot })).status, 400)
  assert.equal((await request(resetPath, { directory: root })).status, 400)
  assert.equal(await readFile(join(worktree, "tracked.txt"), "utf8"), "changed")
  const resettingSession = await client.session.create({
    location: { directory: worktree },
    model: { providerID: "cookiemonster", id: "m" },
  })
  busyHeld = false
  await client.session.prompt({ sessionID: resettingSession.id, text: "BUSY_HOLD" })
  await poll(() => busyHeld)
  const activeReset = await request(resetPath, { directory: worktree })
  assert.equal(activeReset.status, 400)
  assert.match(activeReset.data.message, /active session/)
  releaseBusy()
  await client.experimental.session.wait({ sessionID: resettingSession.id })
  const reset = await request(resetPath, { directory: worktree })
  assert.equal(reset.status, 200, JSON.stringify(reset.data))
  assert.equal(reset.data, true)
  assert.equal(await readFile(join(worktree, "tracked.txt"), "utf8"), "original")
  assert.equal((await git(worktree, ["status", "--porcelain"])).trim(), "")
  assert.equal(await readFile(join(projectRoot, "tracked.txt"), "utf8"), "original")
  console.log(
    "Feature fixture passed: real V2 new/existing scheduled admissions, WPP auth wait, stable IDs/recovery without replay, managed review/edit/backup/stale selection, refreshed native skill execution, auth/origin",
  )
} finally {
  releaseBusy?.()
  await server.stop()
  await new Promise((resolve) => model.close(resolve))
}
