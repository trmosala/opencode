import { afterEach, expect, test } from "bun:test"
import { createServer } from "node:http"
import { join } from "node:path"
import { pathToFileURL } from "node:url"
import { createOpencodeClient } from "@opencode-ai/sdk"
import { Server } from "../../src/server/server"
import { tmpdir, disposeAllInstances } from "../fixture/fixture"
import { resetDatabase } from "../fixture/db"
import { testProviderConfig } from "../lib/test-provider"

const root = process.env.CM_AE_SOURCE_ROOT
afterEach(async () => {
  await disposeAllInstances()
  await resetDatabase()
})

test.skipIf(!root)(
  "AE chat reaches the real CM SDK and persists a model reply",
  async () => {
    const model = createServer(async (request, response) => {
      for await (const chunk of request) void chunk
      response.writeHead(200, { "Content-Type": "text/event-stream" })
      for (const choice of [
        { delta: { role: "assistant", content: "AE chat integration verified" }, finish_reason: null },
        { delta: {}, finish_reason: "stop" },
      ])
        response.write(
          `data: ${JSON.stringify({ id: "chatcmpl-test", object: "chat.completion.chunk", choices: [{ index: 0, ...choice }] })}\n\n`,
        )
      response.end("data: [DONE]\n\n")
    })
    await new Promise<void>((resolve) => model.listen(0, "127.0.0.1", resolve))
    const address = model.address()
    if (!address || typeof address === "string") throw new Error("Missing test model port")
    await using tmp = await tmpdir({
      git: true,
      config: {
        ...testProviderConfig(`http://127.0.0.1:${address.port}/v1`),
        model: "test/test-model",
        small_model: "test/test-model",
      },
    })
    const sdk = createOpencodeClient({
      baseUrl: "http://test",
      directory: tmp.path,
      fetch: async (request) => Server.Default().app.fetch(request),
    })
    const plugin = await import(pathToFileURL(join(root!, "src/plugin.mjs")).href)
    const transport = (await import(pathToFileURL(join(root!, "panel/transport.cjs")).href)).default
    const hooks = await plugin.server({ client: sdk, directory: tmp.path }, { dataDir: join(tmp.path, "ae-private") })
    await hooks.config({ permission: "ask" })
    const store = transport.automaticStore(join(tmp.path, "ae-private"))
    const project = { id: "test-project", path: join(tmp.path, "project.aep"), saved: true }
    const state = {
      project,
      activeCompId: 1,
      aeVersion: "26.3",
      capabilities: { fileNetwork: true },
      busy: false,
      uncertain: false,
      items: [{ id: 1, kind: "comp", name: "Main" }],
      selection: [],
      installedEffects: [],
      revision: 1,
      fingerprint: "native-test",
      projectEpoch: "one",
      nextCursor: null,
    }
    const client = new transport.Client({
      store,
      host: {
        async call() {
          return state
        },
      },
    })
    const stopped = new AbortController()
    const pump = (async () => {
      while (!stopped.signal.aborted) {
        await client.tick()
        await Bun.sleep(10)
      }
    })()
    try {
      // Wait for the actual transport to connect; model work is entirely local to this test.
      const deadline = Date.now() + 30000
      while (client.state.connection !== "connected" && Date.now() < deadline) await Bun.sleep(10)
      expect(client.state.connection).toBe("connected")
      const sent = await transport.request(
        client.descriptor,
        store.state.credential,
        "/chat",
        {
          action: "send",
          project,
          compId: 1,
          text: "Reply with AE chat integration verified. Do not use tools.",
          requestId: "a".repeat(40),
        },
        30000,
      )
      expect(sent.result.delivery).toBe("accepted")
      let text = ""
      while (!text.includes("AE chat integration verified") && Date.now() < deadline) {
        const response = await transport.request(client.descriptor, store.state.credential, "/chat", {
          action: "state",
          project,
        })
        if (response.result.error) throw new Error(response.result.error)
        text = JSON.stringify(
          response.result.messages.filter((message: { role: string }) => message.role === "assistant"),
        )
        if (!text.includes("AE chat integration verified")) await Bun.sleep(20)
      }
      expect(text).toContain("AE chat integration verified")
      const history = await sdk.session.messages({ path: { id: sent.result.sessionID } })
      expect(history.error).toBeUndefined()
      expect(history.data?.some((message) => message.info.role === "user")).toBe(true)
    } finally {
      stopped.abort()
      await pump
      client.stop()
      store.close()
      await hooks.dispose()
      await new Promise<void>((resolve) => model.close(() => resolve()))
    }
  },
  60000,
)
