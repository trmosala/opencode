import { describe, expect, test } from "bun:test"
import vm from "node:vm"
import { join } from "node:path"

describe("WPP greeting capture boundary", () => {
  test("ignores an unrecognized background POST failure before admission", async () => {
    const h = await harness()
    const request = h.fetch("/internal-preferences")
    h.respond(new Response("failed", { status: 500 }))
    await request
    await h.idle()
    expect(h.state().failure).toBeNull()
    expect(() => h.arm("prompt", "offline input")).not.toThrow()
  })

  test("captures only the request carrying the admitted prompt after arming", async () => {
    const h = await harness()
    const prompt = 'offline input\n  preserve "spacing"  '
    h.arm("prompt", prompt)
    const greeting = h.fetch("/v1/chat", JSON.stringify({ messages: [{ content: "automatic greeting" }] }))
    h.respond(Response.json(JSON.parse(answer("Automatic answer"))))
    await greeting
    await h.idle()
    expect(h.records()).toEqual([])
    expect(h.requests()).toEqual([])
    const request = h.fetch("/v1/chat", JSON.stringify({ messages: [{ content: prompt }] }))
    h.respond(Response.json(JSON.parse(answer("Admitted answer"))))
    await request
    await h.idle()
    expect(h.records().at(-1)).toMatchObject({ runId: "prompt", finalText: "Admitted answer", done: true })
    expect(h.requests()).toHaveLength(1)
    expect(JSON.stringify(h.records())).not.toContain("offline input")
  })

  test("ignores a matching prompt posted to a different endpoint than the validated model endpoint", async () => {
    const h = await harness()
    h.arm("prompt", "offline input", "https://open-web-agent-builder-cs.wpp.ai/v1/chat")
    const request = h.fetch("/history/save", JSON.stringify({ content: "offline input" }))
    h.respond(Response.json(JSON.parse(answer("Unrelated response"))))
    await request
    await h.idle()
    expect(h.records()).toEqual([])
    expect(h.requests()).toEqual([])
  })

  test("records a chat stream from another lambda region and a versioned chat path", async () => {
    const h = await harness()
    h.arm("prompt")
    const lambda = h.fetch("https://abc.lambda-url.us-east-1.on.aws/")
    const lambdaBody = h.stream("text/event-stream")
    await lambda
    lambdaBody.enqueue(new TextEncoder().encode(sse("east")))
    lambdaBody.close()
    await h.idle()
    expect(h.records().at(-1)).toMatchObject({ runId: "prompt", finalText: "east", done: true })

    const next = h.fetch("/v2/chat/completions")
    const nextBody = h.stream("text/event-stream")
    await next
    nextBody.enqueue(new TextEncoder().encode(sse("v2")))
    nextBody.close()
    await h.idle()
    expect(h.records().at(-1)).toMatchObject({ runId: "prompt", finalText: "v2", done: true })
  })

  test("admits an unknown POST only when its event stream parses as chat", async () => {
    const h = await harness()
    h.arm("prompt")
    const noise = h.fetch("/internal/notifications")
    const noiseBody = h.stream("text/event-stream")
    await noise
    noiseBody.enqueue(new TextEncoder().encode('data: {"kind":"ping"}\n\n'))
    noiseBody.close()
    await Bun.sleep(30)
    await h.idle()
    expect(h.records()).toEqual([])
    expect(h.state().failure).toBeNull()

    const chat = h.fetch("/internal/completions")
    const chatBody = h.stream("text/event-stream")
    await chat
    chatBody.enqueue(new TextEncoder().encode(sse("moved")))
    chatBody.close()
    for (let i = 0; i < 40 && !h.records().some((record) => record.done); i++) await Bun.sleep(5)
    await h.idle()
    expect(h.records().at(-1)).toMatchObject({ runId: "prompt", finalText: "moved", done: true })
  })

  test("does not record heap telemetry even when it is an event stream", async () => {
    const h = await harness()
    h.arm("prompt")
    const heap = h.fetch("https://c.eu.heap-api.com/api/capture")
    h.respond(new Response(sse("nope"), { headers: { "content-type": "text/event-stream" } }))
    await heap
    await Bun.sleep(30)
    await h.idle()
    expect(h.records()).toEqual([])
    expect(h.state().failure).toBeNull()
  })

  test("records a lambda SSE when armed without expectedPrompt (live job path)", async () => {
    const h = await harness()
    h.arm("prompt")
    const request = h.fetch(
      "https://ydrlzt42d3f4jnndx73jwk6x3q0lnrho.lambda-url.eu-west-1.on.aws/",
      JSON.stringify({ messages: [{ content: "live turn" }] }),
    )
    const body = h.stream("text/event-stream")
    await request
    body.enqueue(new TextEncoder().encode(sse("pong")))
    body.close()
    await h.idle()
    expect(h.requests()).toHaveLength(1)
    expect(h.records().at(-1)).toMatchObject({ runId: "prompt", finalText: "pong", done: true })
  })
  test.each([
    "https://www.google-analytics.com/g/collect",
    "https://events.launchdarkly.com/events/bulk/flags",
    "https://ogilvy.os.wpp.com/api/az/v5/users/me/permissions",
  ])("background failures do not block the next prompt: %s", async (url) => {
    const h = await harness()
    const background = h.fetch(url)
    h.respond(url.includes("google-analytics") ? Response.error() : new Response("", { status: 403 }))
    await background
    await h.idle()
    expect(h.state().failure).toBeNull()
    h.arm("prompt")
    const response = h.fetch()
    h.respond(Response.json(JSON.parse(answer("Real prompt response"))))
    await response
    await h.idle()
    expect(h.records().at(-1)).toMatchObject({ runId: "prompt", finalText: "Real prompt response", done: true })
  })

  test.each(["text/event-stream", "application/json"])(
    "waits for greeting headers and body EOF for %s",
    async (contentType) => {
      const h = await harness()
      const greeting = h.fetch()
      expect(h.state().pending).toBe(1)
      expect(() => h.arm("prompt")).toThrow("o1_code_greeting_not_settled")
      const body = h.stream(contentType)
      await greeting
      body.enqueue(new TextEncoder().encode(contentType === "application/json" ? answer("Hello") : sse("Hello")))
      await h.tick()
      expect(() => h.arm("prompt")).toThrow("o1_code_greeting_not_settled")
      body.close()
      await h.idle()
      expect(h.records()).toEqual([])
      expect(h.requests()).toEqual([])
      h.arm("prompt")
      expect(h.state().runId).toBe("prompt")
    },
  )

  test.each([false, true])("isolates delayed headers across generations, reused run id=%s", async (sameId) => {
    const h = await harness()
    h.reset("previous")
    const previous = h.fetch()
    h.reset(sameId ? "previous" : "prompt")
    h.respond(Response.json(JSON.parse(answer("Previous response"))))
    await previous
    await h.idle()
    expect(h.records()).toEqual([])
    expect(h.requests()).toHaveLength(1)
    expect(h.requests()[0]?.runId).toBe("previous")
  })

  test("suppresses queued progress and the tail of an old streaming generation", async () => {
    const h = await harness()
    h.arm("same")
    const response = h.fetch()
    const body = h.stream("text/event-stream")
    await response
    body.enqueue(new TextEncoder().encode(sse("old")))
    await h.tick()
    h.reset("same")
    const count = h.records().length
    body.enqueue(new TextEncoder().encode(sse(" tail")))
    body.close()
    await h.idle()
    await Bun.sleep(180)
    expect(h.records()).toHaveLength(count)
  })

  test.each([
    "Hello",
    "Hello! Here is the result.\n\n  preserve spacing  ",
    '{"type":"tool_call","tool":"read","args":{"filePath":"a.ts"}}',
  ])("captures the actual requested response unchanged: %s", async (text) => {
    const h = await harness()
    h.arm("prompt")
    const response = h.fetch()
    h.respond(Response.json(JSON.parse(answer(text))))
    await response
    await h.idle()
    expect(h.records().at(-1)).toMatchObject({ runId: "prompt", finalText: text, done: true })
    expect(h.requests()).toHaveLength(1)
  })

  test.each(["Hello", "Use data: as a literal"])(
    "parses fragmented pretty JSON containing %s and usage",
    async (content) => {
      const h = await harness()
      h.arm("prompt")
      const response = h.fetch()
      const body = h.stream("application/json")
      await response
      const text = JSON.stringify(
        { choices: [{ message: { content } }], usage: { prompt_tokens: 20, completion_tokens: 3, total_tokens: 23 } },
        null,
        2,
      )
      for (const part of [text.slice(0, 15), text.slice(15, 35), text.slice(35)]) {
        body.enqueue(new TextEncoder().encode(part))
        await h.tick()
      }
      body.close()
      await h.idle()
      expect(h.records().at(-1)).toMatchObject({ finalText: content, usage: { totalTokens: 23 }, done: true })
    },
  )

  test.each(["text/event-stream", "application/json"])(
    "keeps streaming progress for SSE frames served as %s",
    async (type) => {
      const h = await harness()
      h.arm("prompt")
      const response = h.fetch()
      const body = h.stream(type)
      await response
      body.enqueue(new TextEncoder().encode("da"))
      await h.tick()
      body.enqueue(new TextEncoder().encode(sse("Hello").slice(2)))
      await Bun.sleep(180)
      expect(h.records().at(-1)).toMatchObject({ finalText: "Hello", done: false })
      body.close()
      await h.idle()
      expect(h.records().at(-1)).toMatchObject({ finalText: "Hello", done: true })
    },
  )

  test("parses split NDJSON with literal data: text without losing frames", async () => {
    const h = await harness()
    h.arm("prompt")
    const response = h.fetch()
    const body = h.stream("application/x-ndjson")
    await response
    const lines = [
      JSON.stringify({ choices: [{ delta: { content: "Use data:" } }] }),
      JSON.stringify({ choices: [{ delta: { content: " as a literal" } }] }),
    ]
    body.enqueue(new TextEncoder().encode(lines[0] + "\n" + lines[1].slice(0, 18)))
    await h.tick()
    body.enqueue(new TextEncoder().encode(lines[1].slice(18) + "\n"))
    body.close()
    await h.idle()
    expect(h.records().at(-1)).toMatchObject({ finalText: "Use data: as a literal", done: true, unparsedCount: 0 })
  })

  test.each(["http", "headers", "body"])("fails closed after a greeting %s failure", async (kind) => {
    const h = await harness()
    const response = h.fetch().catch(() => null)
    if (kind === "http") h.respond(new Response("failed", { status: 500 }))
    if (kind === "headers") h.reject(new Error("offline"))
    if (kind === "body") {
      const body = h.stream("text/event-stream")
      await response
      body.error(new Error("broken body"))
    }
    await response
    await h.idle()
    expect(h.state().failure).toBeTruthy()
    h.reset(null)
    expect(() => h.arm("prompt")).toThrow("o1_code_greeting_not_settled")
    expect(h.records()).toEqual([])
  })

  test("keeps a failed old generation fail-closed until the worker is discarded", async () => {
    const h = await harness()
    h.reset("old")
    const response = h.fetch().catch(() => null)
    h.reset(null)
    h.reject(new Error("late failure"))
    await response
    await h.idle()
    expect(() => h.arm("prompt")).toThrow("o1_code_greeting_not_settled")
    expect(h.records()).toEqual([])
  })

  test("waits for XHR loadend and excludes a streaming greeting before reusing XHR", async () => {
    const h = await harness()
    const xhr = new h.Xhr()
    xhr.open("POST", "/v1/chat")
    xhr.send()
    xhr.chunk(sse("greeting"))
    expect(() => h.arm("prompt")).toThrow("o1_code_greeting_not_settled")
    xhr.readyState = 4
    xhr.dispatchEvent(new Event("readystatechange"))
    expect(h.state().pending).toBe(1)
    xhr.end()
    expect(h.records()).toEqual([])
    h.arm("prompt")
    xhr.open("POST", "/v1/chat")
    xhr.send()
    xhr.chunk(sse("Hello"))
    xhr.end()
    expect(h.state().pending).toBe(0)
    expect(h.records().filter((record) => record.done)).toHaveLength(1)
    expect(h.records().at(-1)).toMatchObject({ finalText: "Hello", runId: "prompt", done: true })
  })

  test.each(["abort", "error", "timeout", "send"])("fails closed on XHR %s", async (kind) => {
    const h = await harness()
    const xhr = new h.Xhr()
    xhr.open("POST", "/v1/chat")
    if (kind === "send") {
      xhr.throwOnSend = true
      expect(() => xhr.send()).toThrow("send failed")
    } else {
      xhr.send()
      xhr.status = 0
      xhr.dispatchEvent(new Event(kind))
      xhr.end()
    }
    expect(h.state().pending).toBe(0)
    expect(() => h.arm("prompt")).toThrow("o1_code_greeting_not_settled")
  })

  test("does not attribute an old XHR response to a reused run id", async () => {
    const h = await harness()
    h.reset("same")
    const xhr = new h.Xhr()
    xhr.open("POST", "/v1/chat")
    xhr.send()
    h.reset("same")
    const count = h.records().length
    xhr.chunk(sse("old"))
    xhr.end()
    expect(h.records()).toHaveLength(count)
    expect(h.state().pending).toBe(0)
  })
})

function answer(content: string) {
  return JSON.stringify({ choices: [{ message: { content }, finish_reason: "stop" }] })
}

function sse(content: string) {
  return `data: ${JSON.stringify({ choices: [{ delta: { content } }] })}\n\n`
}

async function harness() {
  const messages: { type?: string; status?: string; record?: Record<string, unknown>; runId?: string }[] = []
  const responses: ReturnType<typeof Promise.withResolvers<Response>>[] = []
  class Xhr extends EventTarget {
    static LOADING = 3
    static DONE = 4
    readyState = 0
    status = 200
    responseType = ""
    responseText = ""
    throwOnSend = false
    open(_method: string, _url: string) {
      this.readyState = 1
      this.responseText = ""
    }
    send() {
      if (this.throwOnSend) throw new Error("send failed")
    }
    getAllResponseHeaders() {
      return "content-type: text/event-stream"
    }
    chunk(text: string) {
      this.responseText += text
      this.readyState = 3
      this.dispatchEvent(new Event("readystatechange"))
    }
    end() {
      this.readyState = 4
      this.dispatchEvent(new Event("readystatechange"))
      this.dispatchEvent(new Event("loadend"))
    }
  }
  const window = {
    addEventListener() {},
    postMessage(message: (typeof messages)[number]) {
      messages.push(structuredClone(message))
    },
    XMLHttpRequest: Xhr,
    fetch: (_url: string, _init: { method: string }) => {
      const response = Promise.withResolvers<Response>()
      responses.push(response)
      return response.promise
    },
    __o1CodeRecorderState: () => ({ pending: 0, failure: null as string | null, runId: null as string | null }),
    __o1CodeRecorderControl: (_data: {
      runId: string | null
      requireIdle?: boolean
      expectedPrompt?: string
      expectedEndpoint?: string
    }) => {},
  }
  vm.runInContext(
    await Bun.file(join(import.meta.dir, "injected", "pageRecorder.js")).text(),
    vm.createContext({
      window,
      location: { href: "https://open-web-agent-builder-cs.wpp.ai/chat/project/foundational" },
      URL,
      Date,
      TextDecoder,
      setTimeout,
      clearTimeout,
    }),
  )
  const respond = (response: Response) => {
    const pending = responses.shift()
    if (!pending) throw new Error("no pending fetch")
    pending.resolve(response)
  }
  return {
    Xhr,
    state: () => window.__o1CodeRecorderState(),
    reset: (runId: string | null) => window.__o1CodeRecorderControl({ runId }),
    arm: (runId: string, expectedPrompt?: string, expectedEndpoint?: string) =>
      window.__o1CodeRecorderControl({ runId, requireIdle: true, expectedPrompt, expectedEndpoint }),
    fetch: (url = "/v1/chat", body?: string) => window.fetch(url, { method: "POST", body }),
    respond,
    reject: (error: Error) => responses.shift()?.reject(error),
    stream: (contentType: string) => {
      let controller: ReadableStreamDefaultController<Uint8Array>
      const body = new ReadableStream<Uint8Array>({
        start(value) {
          controller = value
        },
      })
      respond(new Response(body, { headers: { "content-type": contentType } }))
      return controller!
    },
    tick: () => Bun.sleep(5),
    idle: async () => {
      for (let i = 0; i < 200 && window.__o1CodeRecorderState().pending; i++) await Bun.sleep(5)
      expect(window.__o1CodeRecorderState().pending).toBe(0)
    },
    records: () => messages.flatMap((message) => (message.record ? [message.record] : [])),
    requests: () => messages.filter((message) => message.status === "request"),
  }
}
