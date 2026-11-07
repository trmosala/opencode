// Boots the real published 2.2.5 CookieMonster sidecar (packages/cm-v2 dist) with a scripted local
// OpenAI-compatible model, prints READY <json>, and stops when stdin closes. Everything is isolated
// under FIXTURE_ROOT (database, XDG dirs, workspace); no user data, credentials or ports are touched.
import { createServer } from "node:http"
import { execFileSync } from "node:child_process"
import { mkdir, writeFile } from "node:fs/promises"
import { join } from "node:path"
import { Server } from "../../cm-v2/dist/runtime.js"

const root = process.env.FIXTURE_ROOT
if (!root) throw new Error("FIXTURE_ROOT is required")
const workspace = join(root, "ws")
const plain = join(root, "plain")
await mkdir(workspace, { recursive: true })
await mkdir(plain, { recursive: true })
// Keep the runtime's default Location inside the fixture, away from the repository's .opencode config.
process.chdir(root)
await writeFile(join(workspace, "hello.ts"), "export const hello = 1\n")
// 1x1 PNG
await writeFile(
  join(workspace, "pixel.png"),
  Buffer.from(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==",
    "base64",
  ),
)
const git = (...args) => execFileSync("git", args, { cwd: workspace, stdio: "ignore" })
git("init", "-q", "-b", "main")
git("-c", "user.email=fixture@invalid", "-c", "user.name=fixture", "add", ".")
git("-c", "user.email=fixture@invalid", "-c", "user.name=fixture", "commit", "-q", "-m", "init")

const requests = []
const held = new Set()
let signedIn = true
const model = createServer(async (request, response) => {
  // Scripted WPP bridge for the CM scheduler's auth gate (never the real bridge).
  if (request.url === "/bridge/auth") {
    response.writeHead(200, { "content-type": "application/json" })
    response.end(JSON.stringify({ status: signedIn ? "signed-in" : "signed-out" }))
    return
  }
  if (request.url === "/bridge/login") {
    response.end("ok")
    return
  }
  if (request.url === "/control/signin" || request.url === "/control/signout") {
    signedIn = request.url === "/control/signin"
    response.end("ok")
    return
  }
  if (request.url === "/control/requests") {
    response.writeHead(200, { "content-type": "application/json" })
    response.end(JSON.stringify(requests.map((body) => JSON.stringify(body.messages ?? []))))
    return
  }
  if (request.url === "/control/release") {
    for (const release of held) release()
    held.clear()
    response.end("ok")
    return
  }
  const chunks = []
  for await (const chunk of request) chunks.push(chunk)
  const body = JSON.parse(Buffer.concat(chunks).toString() || "{}")
  requests.push(body)
  const messages = JSON.stringify(body.messages ?? [])
  const answered = (body.messages ?? []).some((message) => message.role === "tool")
  const primary = Array.isArray(body.tools) && body.tools.some((tool) => tool.function?.name === "question")
  const chunk = (delta, finish_reason) =>
    `data: ${JSON.stringify({ id: "fixture", object: "chat.completion.chunk", created: 1, model: "m", choices: [{ index: 0, delta, finish_reason }] })}\n\n`
  response.writeHead(200, { "content-type": "text/event-stream" })
  if (primary && messages.includes("HOLD_FOR_INTERRUPT") && !answered) {
    // Stream one delta, then hold until the client interrupts (socket close) or the test releases it.
    response.write(chunk({ role: "assistant", content: "HOLDING" }, null))
    await new Promise((resolve) => {
      held.add(resolve)
      request.on("close", resolve)
    })
    response.end(chunk({}, "stop") + "data: [DONE]\n\n")
    return
  }
  if (primary && messages.includes("ASK_QUESTION") && !answered) {
    const args = JSON.stringify({
      questions: [
        {
          header: "Pick",
          question: "Which option?",
          options: [
            { label: "Alpha", description: "first" },
            { label: "Beta", description: "second" },
          ],
        },
      ],
    })
    response.end(
      chunk(
        {
          role: "assistant",
          tool_calls: [{ index: 0, id: "call_q", type: "function", function: { name: "question", arguments: args } }],
        },
        null,
      ) +
        chunk({}, "tool_calls") +
        "data: [DONE]\n\n",
    )
    return
  }
  const text = messages.includes("SKILL_MARKER_CONTENT") ? "V2_SKILL_SEEN" : answered ? "V2_ANSWERED" : "V2_APP_OK"
  response.end(chunk({ role: "assistant", content: text }, null) + chunk({}, "stop") + "data: [DONE]\n\n")
})
await new Promise((resolve) => model.listen(0, "127.0.0.1", resolve))
const modelURL = `http://127.0.0.1:${model.address().port}`
process.env.O1_CODE_PROXY_HOST = "127.0.0.1"
process.env.O1_CODE_PROXY_PORT = String(model.address().port)

const password = "app-runtime-secret"
const config = {
  project: true,
  claude: false,
  content: JSON.stringify({
    model: "cookiemonster/m",
    snapshots: false,
    provider: {
      cookiemonster: {
        npm: "@ai-sdk/openai-compatible",
        options: { baseURL: `${modelURL}/v1`, apiKey: "fixture" },
        models: { m: { name: "Fixture", tool_call: true } },
      },
    },
  }),
}
const server = await Server.listen({ hostname: "127.0.0.1", port: 0, password, database: join(root, "app.db"), config })
console.log(
  "READY " +
    JSON.stringify({ url: `http://127.0.0.1:${server.address.port}`, password, workspace, plain, model: modelURL }),
)

let stopping = false
const stop = async () => {
  if (stopping) return
  stopping = true
  for (const release of held) release()
  await server.stop().catch((error) => console.error("stop failed", error))
  await new Promise((resolve) => model.close(resolve))
  process.exit(0)
}
process.stdin.on("end", stop)
process.stdin.on("close", stop)
process.stdin.resume()
process.on("SIGTERM", stop)
