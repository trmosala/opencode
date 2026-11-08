import { afterAll, beforeAll, expect, test } from "bun:test"
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import { pathToFileURL } from "node:url"
import { OpenCode } from "@opencode/client"
import { ServerProcess } from "@opencode/server/process"
import { Effect, Exit, Scope } from "effect"
import { HttpServer } from "effect/http"
import { requests, respond } from "./v2-port.fixture"

// Real published @opencode/server 2.2.5 runtime, real plugin loading, scripted OpenAI-compatible model.
const turns: unknown[][] = []
const script: Array<(body: { tools?: { function: { name: string; parameters: unknown } }[] }) => unknown> = []
const llm = Bun.serve({
  port: 0,
  async fetch(request) {
    const body = (await request.json()) as {
      tools?: { function: { name: string; parameters: unknown } }[]
      messages: unknown[]
    }
    // Title and other auxiliary requests carry no tools; only agent turns consume the script.
    if (body.tools?.length) turns.push(body.messages)
    const next = (body.tools?.length ? script.shift()?.(body) : undefined) ?? { content: "done" }
    const chunk = (delta: unknown, finish: string | null) =>
      `data: ${JSON.stringify({ id: "c", object: "chat.completion.chunk", created: 0, model: "m", choices: [{ index: 0, delta, finish_reason: finish }] })}\n\n`
    const stream =
      "tool" in (next as object)
        ? chunk(
            {
              role: "assistant",
              tool_calls: [
                { index: 0, id: `call_${turns.length}`, type: "function", function: (next as { tool: unknown }).tool },
              ],
            },
            null,
          ) + chunk({}, "tool_calls")
        : chunk({ role: "assistant", content: (next as { content: string }).content }, null) + chunk({}, "stop")
    return new Response(stream + "data: [DONE]\n\n", { headers: { "content-type": "text/event-stream" } })
  },
})

const scope = Effect.runSync(Scope.make())
let directory = ""
let client: ReturnType<typeof OpenCode.make>
let tools: { function: { name: string; parameters: unknown } }[] = []

beforeAll(async () => {
  directory = await mkdtemp(path.join(tmpdir(), "cm-browser-v2-"))
  const plugin = path.join(directory, "cm-browser")
  await mkdir(plugin)
  await writeFile(
    path.join(plugin, "server.ts"),
    `import { createPlugin } from ${JSON.stringify(path.resolve(import.meta.dir, "../src/v2.ts"))}\nimport { port } from ${JSON.stringify(path.resolve(import.meta.dir, "v2-port.fixture.ts"))}\nexport default createPlugin(port)\n`,
  )
  process.env.XDG_DATA_HOME = path.join(directory, "data")
  process.env.XDG_CONFIG_HOME = path.join(directory, "config")
  process.env.XDG_STATE_HOME = path.join(directory, "state")
  process.env.XDG_CACHE_HOME = path.join(directory, "cache")
  const server = await Effect.runPromise(
    ServerProcess.start<never, never>({
      hostname: "127.0.0.1",
      port: 0,
      password: "secret",
      app: { version: "2.2.5" },
      database: { path: ":memory:" },
      config: {
        directory,
        content: JSON.stringify({
          plugin: [pathToFileURL(plugin).href],
          model: "mock/m",
          provider: {
            mock: {
              npm: "@ai-sdk/openai-compatible",
              options: { baseURL: `http://127.0.0.1:${llm.port}/v1`, apiKey: "test" },
              models: { m: { name: "m", tool_call: true } },
            },
          },
          permission: { browser_navigate: "deny", subagent: "ask", browser_delegate_tabs: "ask" },
        }),
      },
      fs: { filewatcher: false },
      models: { fetch: false },
    }).pipe(Scope.provide(scope)),
  )
  client = OpenCode.make({
    baseUrl: HttpServer.formatAddress(server.address),
    headers: { authorization: `Basic ${btoa("opencode:secret")}` },
  })
})

afterAll(async () => {
  await Effect.runPromise(Scope.close(scope, Exit.void))
  llm.stop(true)
  await rm(directory, { recursive: true, force: true })
})

async function prompt(
  text: string,
  approve?: (request: {
    id: string
    sessionID: string
    action: string
    resources: readonly string[]
  }) => "once" | "reject",
) {
  const session = await client.session.create({ location: { directory } })
  await client.session.prompt({ sessionID: session.id, text })
  const answered = new Set<string>()
  const done = client.experimental.session.wait({ sessionID: session.id }).then(() => true)
  while (approve && !(await Promise.race([done, Bun.sleep(25).then(() => false)]))) {
    const pending = (await client.permission.request.list({ location: { directory } })).data
    for (const request of pending.filter((item) => !answered.has(item.id))) {
      answered.add(request.id)
      await client.permission.reply({ sessionID: request.sessionID, requestID: request.id, decision: approve(request) })
    }
  }
  await done
  if (process.env.CM_DEBUG)
    console.log("DEBUG", JSON.stringify(await client.message.list({ sessionID: session.id })).slice(0, 3000))
  return session
}

const empty = { tabID: "", url: "", title: "", visibleText: "", elements: [] }

test("browser tools register as top-level tools, run over the parent port and get CM system guidance", async () => {
  respond((request) => ({
    ok: true,
    result: { ...empty, tabs: [{ tabID: "t1", url: "https://example.com" }] },
    request,
  }))
  script.push((body) => {
    tools = body.tools ?? []
    return { tool: { name: "browser_read_state", arguments: "{}" } }
  })
  const session = await prompt("read the browser")
  const names = tools.map((tool) => tool.function.name)
  expect(names).toEqual(
    expect.arrayContaining(["browser_read_state", "browser_create_tab", "desktop_set_panel", "browser_subagent"]),
  )
  const read = tools.find((tool) => tool.function.name === "browser_read_state")!
  expect(read.function.parameters).toMatchObject({ type: "object", properties: { tabID: { type: "string" } } })
  expect(requests.at(-1)).toMatchObject({ sessionID: session.id, request: { op: "list_tabs" } })
  expect(JSON.stringify(turns.at(-1))).toContain("t1 https://example.com")
  expect(JSON.stringify(turns.at(-1))).toContain("Use CookieMonster's built-in CM Browser browser_* tools")
})

test("lifecycle defaults allow tab creation without a prompt; a configured deny removes the tool", async () => {
  respond((request) =>
    request.op === "prepare_tab"
      ? { ok: true, result: { ...empty, tabToken: "tok" } }
      : { ok: true, result: { ...empty, tabResult: { op: "create_tab", tabID: "t2" } } },
  )
  const before = requests.length
  script.push((body) => {
    tools = body.tools ?? []
    return { tool: { name: "browser_create_tab", arguments: "{}" } }
  })
  await prompt("open a tab")
  expect(requests.slice(before).map((entry) => entry.request.op)).toEqual(["prepare_tab", "create_tab"])
  expect(JSON.stringify(turns.at(-1))).toContain("create_tab t2")
  expect(tools.map((tool) => tool.function.name)).not.toContain("browser_navigate")
})

test("browser_subagent lends tabs only after approval, to the real child, and revokes when it returns", async () => {
  const grants: { op: string; executionID: string; childSessionID?: string; tabIDs?: readonly string[] }[] = []
  respond((request) => {
    if (request.op !== "grant_tabs" && request.op !== "revoke_tabs")
      return { ok: false, code: "bad_request", error: request.op }
    grants.push(request)
    return {
      ok: true,
      result: { ...empty, delegation: { executionID: request.executionID, active: request.op === "grant_tabs" } },
    }
  })
  const lend = { agent: "general", description: "d", prompt: "use the tab", browser_tab_ids: ["t2"] }
  script.push(() => ({ tool: { name: "browser_subagent", arguments: JSON.stringify(lend) } }))
  const asked: string[] = []
  const parent = await prompt("delegate", (request) => {
    asked.push(`${request.action}:${request.resources.join(",")}`)
    return "once"
  })
  expect(asked).toEqual(["subagent:general", "browser_delegate_tabs:t2"])
  expect(grants.map((grant) => grant.op)).toEqual(["grant_tabs", "revoke_tabs"])
  expect(grants[1]!.executionID).toBe(grants[0]!.executionID)
  const child = await client.session.get({ sessionID: grants[0]!.childSessionID! })
  expect(child.parentID).toBe(parent.id)
  expect(grants[0]!.tabIDs).toEqual(["t2"])
  expect(requests.at(-1)?.sessionID).toBe(parent.id)

  grants.length = 0
  script.push(() => ({ tool: { name: "browser_subagent", arguments: JSON.stringify(lend) } }))
  await prompt("delegate again", (request) => (request.action === "browser_delegate_tabs" ? "reject" : "once"))
  expect(grants).toEqual([])
})
