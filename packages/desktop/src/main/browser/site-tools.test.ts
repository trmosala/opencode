import { expect, test } from "bun:test"
import { EventEmitter } from "node:events"
import { discoverSiteTools, invokeSiteTool, prepareSiteTool } from "./site-tools"

class DebuggerFixture extends EventEmitter {
  attached = true
  invocations = 0
  cancelled: string[] = []

  isAttached() {
    return this.attached
  }

  attach() {
    this.attached = true
  }

  async sendCommand(method: string, params?: Record<string, unknown>) {
    if (method === "Page.getFrameTree")
      return {
        frameTree: {
          frame: {
            id: "main",
            url: "https://example.com/page",
            securityOrigin: "https://example.com",
          },
        },
      }
    if (method === "WebMCP.enable") {
      queueMicrotask(() =>
        this.emit("message", {}, "WebMCP.toolsAdded", {
          tools: [
            {
              name: "search",
              description: `Search\u0000${"x".repeat(2_000)}`,
              frameId: "main",
              inputSchema: { type: "object", properties: { query: { type: "string" } } },
              annotations: { readOnly: true, untrustedContent: true, consequential: false },
              stackTrace: { private: "never expose" },
            },
            { name: "child", description: "Private child", frameId: "child" },
            { name: "invalid name", description: "Bad", frameId: "main" },
          ],
        }),
      )
      await Promise.resolve()
      return {}
    }
    if (method === "WebMCP.invokeTool") {
      this.invocations++
      setTimeout(() =>
        this.emit("message", {}, "WebMCP.toolResponded", {
          invocationId: "invocation",
          status: "Completed",
          output: { echoed: params?.input },
        }),
      )
      return { invocationId: "invocation" }
    }
    if (method === "WebMCP.cancelInvocation") {
      this.cancelled.push(String(params?.invocationId))
      return {}
    }
    throw new Error(`Unexpected command ${method}`)
  }
}

function fixture(debuggerFixture = new DebuggerFixture()) {
  const contents = {
    debugger: debuggerFixture,
    isDestroyed: () => false,
    isLoadingMainFrame: () => false,
    getURL: () => "https://example.com/page",
  }
  return { contents, debuggerFixture }
}

test("discovers only bounded top-document metadata and returns opaque refs", async () => {
  const { contents } = fixture()
  const result = await discoverSiteTools(contents, () => {})
  expect(result.origin).toBe("https://example.com")
  expect(result.tools).toHaveLength(1)
  expect(result.tools[0]).toMatchObject({
    name: "search",
    readOnly: true,
    untrustedContent: true,
    consequential: false,
  })
  expect(result.tools[0]?.ref).toMatch(/^[a-f0-9-]{36}$/)
  expect(result.tools[0]?.description).not.toContain("\u0000")
  expect(result.tools[0]?.description.length).toBeLessThanOrEqual(1_024)
  expect(result.tools[0]?.inputSchema).toBe('{"type":"object","properties":{"query":{"type":"string"}}}')
  expect(result.tools[0]).not.toHaveProperty("frameId")
  expect(result.tools[0]).not.toHaveProperty("stackTrace")
})

test("truncates a malicious inventory before the sidecar response ceiling", async () => {
  const { contents, debuggerFixture } = fixture()
  await discoverSiteTools(contents, () => {})
  debuggerFixture.emit("message", {}, "WebMCP.toolsAdded", {
    tools: Array.from({ length: 32 }, (_, index) => ({
      name: `large_${index}`,
      description: "d".repeat(1_024),
      frameId: "main",
      inputSchema: { type: "object", description: "s".repeat(3_900) },
    })),
  })
  const discovered = await discoverSiteTools(contents, () => {})
  expect(discovered.truncated).toBe(true)
  expect(discovered.tools.length).toBeLessThan(32)
  expect(Buffer.byteLength(JSON.stringify(discovered.tools))).toBeLessThanOrEqual(48 * 1024)
})

test("tool changes invalidate prepared refs before dispatch", async () => {
  const { contents, debuggerFixture } = fixture()
  const discovered = await discoverSiteTools(contents, () => {})
  const prepared = await prepareSiteTool(contents, discovered.tools[0].ref, '{"query":"safe"}', () => {})
  debuggerFixture.emit("message", {}, "WebMCP.toolsRemoved", {
    tools: [{ name: "search", frameId: "main" }],
  })
  await expect(
    invokeSiteTool(contents, prepared, '{"query":"safe"}', () => {}, new AbortController().signal),
  ).rejects.toThrow("changed")
  expect(debuggerFixture.invocations).toBe(0)
})

test("invocation returns bounded untrusted JSON and cancellation reaches Chromium", async () => {
  const { contents, debuggerFixture } = fixture()
  const discovered = await discoverSiteTools(contents, () => {})
  const prepared = await prepareSiteTool(contents, discovered.tools[0].ref, '{"query":"safe"}', () => {})
  expect(await invokeSiteTool(contents, prepared, '{"query":"safe"}', () => {}, new AbortController().signal)).toEqual({
    name: "search",
    origin: "https://example.com",
    content: '{"echoed":{"query":"safe"}}',
  })

  debuggerFixture.sendCommand = async (method, params) => {
    if (method === "WebMCP.invokeTool") return { invocationId: "held" }
    if (method === "WebMCP.cancelInvocation") {
      debuggerFixture.cancelled.push(String(params?.invocationId))
      return {}
    }
    return DebuggerFixture.prototype.sendCommand.call(debuggerFixture, method, params)
  }
  const fresh = await prepareSiteTool(contents, discovered.tools[0].ref, '{"query":"cancel"}', () => {})
  const controller = new AbortController()
  const pending = invokeSiteTool(contents, fresh, '{"query":"cancel"}', () => {}, controller.signal)
  await new Promise((resolve) => setTimeout(resolve))
  controller.abort()
  await expect(pending).rejects.toThrow()
  expect(debuggerFixture.cancelled).toEqual(["held"])
})

test("accepts the current Completed terminal status", async () => {
  const { contents, debuggerFixture } = fixture()
  const discovered = await discoverSiteTools(contents, () => {})
  const prepared = await prepareSiteTool(contents, discovered.tools[0].ref, "{}", () => {})
  debuggerFixture.sendCommand = async (method, params) => {
    if (method === "WebMCP.invokeTool") {
      setTimeout(() =>
        debuggerFixture.emit("message", {}, "WebMCP.toolResponded", {
          invocationId: "completed",
          status: "Completed",
          output: params?.input,
        }),
      )
      return { invocationId: "completed" }
    }
    return DebuggerFixture.prototype.sendCommand.call(debuggerFixture, method, params)
  }
  expect(await invokeSiteTool(contents, prepared, "{}", () => {}, new AbortController().signal)).toMatchObject({
    content: "{}",
  })
})
