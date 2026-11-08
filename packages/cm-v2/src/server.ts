export * as Server from "./server"

import { spawn, type ChildProcess } from "node:child_process"
import { createServer, request, type IncomingMessage, type ServerResponse } from "node:http"
import { connect } from "node:net"
import type { Duplex } from "node:stream"
import type { ServerOptions } from "@opencode/server/options"
import { isAllowedCorsOrigin, isAllowedRequestOrigin } from "@opencode/server/cors"
import { Effect, Option, Schema } from "effect"
import { HttpEffect, HttpMiddleware, HttpServerRequest, HttpServerResponse } from "effect/http"
import { OpenCode } from "@opencode/client"
import { Extensions } from "./extensions"
import { openScheduler } from "./scheduler"
import z from "zod"
import { featuresRpc } from "./features-rpc"

export type ListenOptions = {
  hostname: string
  port: number
  password: string
  database: string
  // The official OpenCode CLI binary. It serves the API so model providers see a genuine OpenCode client.
  cli: string
  config?: ServerOptions["config"]
}

// CookieMonster's front listener keeps the address, origin policy and CM routes the desktop already uses, and
// forwards everything else (HTTP, SSE and WebSocket upgrades) to an official `opencode serve --stdio` child.
export async function listen(input: ListenOptions) {
  const extensions = new Extensions(input.password)
  const config = z
    .object({ plugin: z.array(z.unknown()).optional() })
    .loose()
    .parse(JSON.parse(input.config?.content ?? "{}"))
  config.plugin = [
    ...(config.plugin ?? []),
    [
      process.env.CM_V2_FEATURE_PLUGIN ?? new URL("./features-plugin", import.meta.url).href,
      { configDirectory: input.config?.directory, project: input.config?.project !== false },
    ],
  ]
  // Match the CORS policy the OpenCode server applies to its own routes, including preflight.
  const extensionHandler = HttpEffect.toWebHandler(
    HttpServerRequest.HttpServerRequest.pipe(
      Effect.flatMap(
        (current) => extensions.handle(current) ?? Effect.succeed(HttpServerResponse.empty({ status: 404 })),
      ),
    ),
    HttpMiddleware.cors({ allowedOrigins: (origin) => isAllowedCorsOrigin(origin), maxAge: 86400 }),
  )
  const upstream = { port: 0 }
  // Upgraded sockets are outside `closeAllConnections`, so shutdown destroys them explicitly.
  const tunnels = new Set<Duplex>()
  const front = createServer((incoming, response) => {
    if (!isAllowedRequestOrigin(incoming.headers.origin, incoming.headers.host)) {
      response.writeHead(403).end()
      return
    }
    if (isExtensionRoute(incoming.url)) {
      void serveExtension(extensionHandler, incoming, response)
      return
    }
    const forward = request(
      {
        hostname: "127.0.0.1",
        port: upstream.port,
        method: incoming.method,
        path: incoming.url,
        headers: incoming.headers,
      },
      (reply) => {
        response.writeHead(reply.statusCode ?? 502, reply.headers)
        reply.pipe(response)
      },
    )
    forward.on("error", () => (response.headersSent ? response.destroy() : response.writeHead(502).end()))
    response.on("close", () => forward.destroy())
    incoming.pipe(forward)
  })
  front.on("upgrade", (incoming, socket, head) => {
    if (!isAllowedRequestOrigin(incoming.headers.origin, incoming.headers.host)) {
      socket.end("HTTP/1.1 403 Forbidden\r\n\r\n")
      return
    }
    tunnel(incoming, socket, head, upstream.port, tunnels)
  })
  await new Promise<void>((resolve, reject) => {
    front.once("error", reject)
    front.listen(input.port, input.hostname, () => resolve())
  })
  const address = front.address()
  if (!address || typeof address === "string") throw new Error("Expected a TCP sidecar listener")
  const url = `http://${input.hostname.includes(":") ? `[${input.hostname}]` : input.hostname}:${address.port}`
  const cli = await startCli(input, JSON.stringify(config), url).catch((error) => {
    front.close()
    throw error
  })
  upstream.port = Number(new URL(cli.url).port)
  const authorization = `Basic ${Buffer.from(`opencode:${input.password}`).toString("base64")}`
  await waitForMigration(cli.url, authorization).catch(async (error) => {
    front.close()
    await cli.stop()
    throw error
  })
  const client = OpenCode.make({ baseUrl: cli.url, headers: { authorization } })
  extensions.initialize(client, input.config?.directory, input.config?.project !== false)
  await openScheduler(client, async (item) => {
    await client.rpc(featuresRpc).notify(
      {
        sessionID: item.sessionID,
        name: item.definition.name,
        state: item.state,
        detail: item.detail ?? "Scheduled run completed",
      },
      { location: { directory: item.directory } },
    )
  })
    .then((scheduler) => {
      extensions.scheduler = scheduler
      scheduler.start()
    })
    .catch((error) => {
      extensions.schedulerError = error
      console.error("CM scheduler unavailable", error)
    })
  let stopping: Promise<void> | undefined
  return {
    address: { hostname: input.hostname, port: address.port },
    stop: () =>
      (stopping ??= (async () => {
        await extensions.scheduler?.close()
        front.closeAllConnections()
        tunnels.forEach((socket) => socket.destroy())
        await new Promise<void>((resolve) => front.close(() => resolve()))
        await cli.stop()
      })()),
  }
}

function isExtensionRoute(url = "/") {
  const pathname = new URL(url, "http://localhost").pathname
  return (
    pathname === "/schedule" ||
    pathname === "/worktree/reset" ||
    /^\/skill\/(catalog|validate|review|create|manage|select)$/.test(pathname)
  )
}

async function serveExtension(
  handler: (request: Request) => Promise<Response>,
  incoming: IncomingMessage,
  response: ServerResponse,
) {
  const body =
    incoming.method === "GET" || incoming.method === "HEAD" || incoming.method === "OPTIONS"
      ? undefined
      : new Uint8Array(Buffer.concat(await incoming.toArray()))
  const reply = await handler(
    new Request(new URL(incoming.url ?? "/", "http://localhost").href, {
      method: incoming.method,
      headers: Object.entries(incoming.headers).flatMap(([name, value]) =>
        value === undefined ? [] : [[name, Array.isArray(value) ? value.join(", ") : value] as [string, string]],
      ),
      body,
    }),
  )
  response.writeHead(reply.status, Object.fromEntries(reply.headers))
  response.end(Buffer.from(await reply.arrayBuffer()))
}

function tunnel(incoming: IncomingMessage, socket: Duplex, head: Buffer, port: number, tunnels: Set<Duplex>) {
  const target = connect(port, "127.0.0.1", () => {
    const lines = [`${incoming.method} ${incoming.url} HTTP/${incoming.httpVersion}`]
    for (let index = 0; index < incoming.rawHeaders.length; index += 2)
      lines.push(`${incoming.rawHeaders[index]}: ${incoming.rawHeaders[index + 1]}`)
    target.write(`${lines.join("\r\n")}\r\n\r\n`)
    if (head.length) target.write(head)
    target.pipe(socket)
    socket.pipe(target)
  })
  target.on("error", () => socket.destroy())
  socket.on("error", () => target.destroy())
  for (const end of [socket, target]) {
    tunnels.add(end)
    end.once("close", () => tunnels.delete(end))
  }
}

const Announcement = Schema.fromJsonString(Schema.Struct({ url: Schema.String }))

async function startCli(input: ListenOptions, content: string, url: string) {
  const child = spawn(input.cli, ["serve", "--stdio", "--hostname", "127.0.0.1", "--port", "0"], {
    env: {
      ...process.env,
      OPENCODE_SERVER_USERNAME: "opencode",
      OPENCODE_SERVER_PASSWORD: input.password,
      OPENCODE_CLIENT: process.env.OPENCODE_CLIENT ?? "desktop",
      OPENCODE_DB: input.database,
      OPENCODE_CONFIG_CONTENT: content,
      OPENCODE_DISABLE_FFF: "1",
      CM_V2_FEATURE_URL: url,
      CM_V2_FEATURE_PASSWORD: input.password,
      ...(input.config?.directory ? { OPENCODE_CONFIG_DIR: input.config.directory } : {}),
      ...(input.config?.project === false ? { OPENCODE_DISABLE_PROJECT_CONFIG: "1" } : {}),
      ...(input.config?.claude === false ? { OPENCODE_DISABLE_CLAUDE_CODE: "1" } : {}),
    },
    stdio: ["pipe", "pipe", "inherit", "ipc"],
  })
  const stdout = child.stdout
  if (!stdout) throw new Error("OpenCode CLI stdout is unavailable")
  relayBrowserMessages(child)
  // --stdio announces `{"url": ...}` on stdout and exits when stdin closes, so the CLI never outlives this process.
  const ready = await new Promise<string>((resolve, reject) => {
    let buffered = ""
    const onData = (chunk: Buffer) => {
      buffered += chunk.toString()
      const lines = buffered.split("\n")
      buffered = lines.pop() ?? ""
      for (const line of lines) {
        const announced = Schema.decodeUnknownOption(Announcement)(line)
        if (Option.isNone(announced)) {
          process.stdout.write(`${line}\n`)
          continue
        }
        stdout.off("data", onData)
        stdout.on("data", (rest) => process.stdout.write(rest))
        resolve(announced.value.url)
        return
      }
    }
    stdout.on("data", onData)
    child.once("error", reject)
    child.once("exit", (code, signal) => reject(new Error(`OpenCode CLI exited before ready (${code ?? signal})`)))
  })
  const exited = new Promise<void>((resolve) =>
    child.exitCode !== null ? resolve() : child.once("exit", () => resolve()),
  )
  return {
    url: ready,
    stop: async () => {
      child.stdin?.end()
      const timer = setTimeout(() => child.kill("SIGKILL"), 10_000)
      await exited
      clearTimeout(timer)
    },
  }
}

type ParentPort = {
  postMessage(message: unknown): void
  on(event: "message", listener: (event: { data: unknown }) => void): void
  off(event: "message", listener: (event: { data: unknown }) => void): void
}

// CM Browser tools reach Electron's browser bridge through the utility process's parent port. The plugin now runs
// in the CLI child, so relay its requests up and the bridge's results back down over the child's IPC channel.
function relayBrowserMessages(child: ChildProcess) {
  const parent = (process as NodeJS.Process & { parentPort?: ParentPort }).parentPort
  if (!parent) return
  child.on("message", (message) => {
    if (isBrowserMessage(message, ["browser_request", "browser_cancel"])) parent.postMessage(message)
  })
  const down = (event: { data: unknown }) => {
    if (isBrowserMessage(event.data, ["browser_result"]) && child.connected) child.send(event.data)
  }
  parent.on("message", down)
  child.once("exit", () => parent.off("message", down))
}

function isBrowserMessage(message: unknown, types: string[]): message is { type: string } {
  return typeof message === "object" && message !== null && "type" in message && types.includes(String(message.type))
}

async function waitForMigration(url: string, authorization: string) {
  const deadline = Date.now() + 240_000
  while (Date.now() < deadline) {
    const response = await fetch(`${url}/api/experimental/migration/v1`, {
      headers: { authorization },
      signal: AbortSignal.timeout(5000),
    })
    if (!response.ok) throw new Error(`V1 history migration status failed: ${response.status}`)
    const status = z.object({ status: z.string(), error: z.string().optional() }).parse(await response.json())
    if (status.status === "completed") return
    if (status.status === "error") throw new Error(`V1 history migration failed: ${status.error}`)
    await new Promise((resolve) => setTimeout(resolve, 50))
  }
  throw new Error("V1 history migration did not complete within four minutes")
}
