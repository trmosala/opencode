import assert from "node:assert/strict"
import { mkdtemp } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
const root = await mkdtemp(join(tmpdir(), "cm-v2-free-"))
for (const name of ["DATA", "CONFIG", "STATE", "CACHE"])
  process.env[`XDG_${name}_HOME`] = join(root, name.toLowerCase())
process.chdir(root)
const { Server } = await import("../dist/runtime.js")
const { OpenCode } = await import("@opencode/client")
const server = await Server.listen({
  hostname: "127.0.0.1",
  port: 0,
  password: "probe",
  database: join(root, "probe.db"),
  config: { project: false, claude: false, content: '{"snapshots":false}' },
})
try {
  const client = OpenCode.make({
    baseUrl: `http://127.0.0.1:${server.address.port}`,
    headers: { authorization: `Basic ${Buffer.from("opencode:probe").toString("base64")}` },
  })
  const models = await client.model.list({ location: { directory: root } })
  const free = models.data.filter(
    (m) => m.providerID === "opencode" && m.enabled && m.cost?.some((c) => c.input === 0 && c.output === 0),
  )
  console.log(
    "FREE_MODELS",
    free.map((m) => m.id),
  )
  const chosen = free.find((m) => m.id === "deepseek-v4.1-flash-free") ?? free[0]
  assert.ok(chosen, "No free model is available")
  const session = await client.session.create({
    location: { directory: root },
    model: { providerID: chosen.providerID, id: chosen.id },
  })
  await client.session.prompt({ sessionID: session.id, text: "Reply with exactly CM_V2_FREE_OK. Do not use tools." })
  await client.experimental.session.wait({ sessionID: session.id }, { signal: AbortSignal.timeout(90000) })
  const messages = await client.message.list({ sessionID: session.id })
  console.log("MODEL", chosen.id, "MESSAGES", JSON.stringify(messages))
  assert.ok(JSON.stringify(messages).includes("CM_V2_FREE_OK"), "No requested free-model text")
  const assistant = messages.data?.filter((m) => m.type === "assistant") ?? []
  assert.ok(
    assistant.some((m) => JSON.stringify(m).includes("CM_V2_FREE_OK")),
    "No nonempty free assistant response",
  )
  console.log("FREE_PROMPT_PASSED", root)
} finally {
  await server.stop()
}
