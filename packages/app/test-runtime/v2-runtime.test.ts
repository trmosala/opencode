// Real-runtime integration: the app's own adapters against the published 2.2.5 CookieMonster sidecar.
// Boundary: the runtime, HTTP/SSE/WebSocket transport, database, git, PTY and CM extension routes are real;
// only the language model is a scripted local OpenAI-compatible server (no network, no credentials).
import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import type { OpenCodeEvent } from "@opencode/client/promise"
import { adaptServerEvent, eventDirectory } from "@/context/server-sdk"
import { createServerSession } from "@/context/server-session"
import { scheduleNotification } from "@/context/notification"
import { createSchedulingClient } from "@/utils/scheduling"
import { loadCommands, loadGlobalConfigQuery, loadProviders } from "@/context/global-sync/bootstrap"
import { loadHomeSessionIndex } from "@/context/global-sync/home-session-index"
import { createExtensionClient } from "@/utils/cm-extensions"
import { createApiForServer, createSdkForServer } from "@/utils/server"
import { createCompatibleApi } from "@/utils/server-compat"
import { detectServerProtocol } from "@/utils/server-protocol"
import { fetchSessionExport } from "@/utils/session-export"
import { normalizeSessionMessages } from "@/utils/session-message"
import { terminalWebSocketURL } from "@/utils/terminal-websocket-url"
import { QueryClient } from "@tanstack/solid-query"
import { ServerScope } from "@/utils/server-scope"

type Ready = { url: string; password: string; workspace: string; plain: string; model: string }

let root = ""
let child: ReturnType<typeof Bun.spawn> | undefined
let ready: Ready
let server: { url: string; username: string; password: string }
let current: ReturnType<typeof createApiForServer>
let api: ReturnType<typeof createCompatibleApi>
const legacy = (directory?: string) => createSdkForServer({ server, directory, throwOnError: true })
const events: OpenCodeEvent[] = []
const abort = new AbortController()

async function until<T>(read: () => T | undefined | Promise<T | undefined>, label: string, ms = 20_000): Promise<T> {
  const deadline = Date.now() + ms
  while (Date.now() < deadline) {
    const value = await read()
    if (value) return value
    await Bun.sleep(25)
  }
  throw new Error(`Timed out waiting for ${label}`)
}

const event = <Type extends OpenCodeEvent["type"]>(
  type: Type,
  match: (event: Extract<OpenCodeEvent, { type: Type }>) => boolean,
) =>
  until(
    () =>
      events.find((item): item is Extract<OpenCodeEvent, { type: Type }> => item.type === type && match(item as never)),
    type,
  )

const modelRequests = async () => (await (await fetch(`${ready.model}/control/requests`)).json()) as string[]

// Mirrors what prompt-input/submit.ts sends through the compatibility API.
const prompt = (sessionID: string, text: string, extra?: { delivery?: "steer" | "queue" }) =>
  api.session.prompt({
    sessionID,
    id: `msg_${crypto.randomUUID().replaceAll("-", "").slice(0, 24)}`,
    agent: "build",
    model: { providerID: "cookiemonster", modelID: "m" },
    legacyParts: [{ type: "text", text }],
    text,
    files: [],
    agents: [],
    ...extra,
  })

const create = () =>
  api.session.create({ location: { directory: ready.workspace }, model: { providerID: "cookiemonster", id: "m" } })

beforeAll(async () => {
  root = await mkdtemp(join(tmpdir(), "cm-app-v2-runtime-"))
  child = Bun.spawn(["node", new URL("./v2-runtime.fixture.mjs", import.meta.url).pathname], {
    env: {
      ...process.env,
      FIXTURE_ROOT: root,
      HOME: join(root, "home"),
      XDG_DATA_HOME: join(root, "data"),
      XDG_CONFIG_HOME: join(root, "config"),
      XDG_STATE_HOME: join(root, "state"),
      XDG_CACHE_HOME: join(root, "cache"),
      OPENCODE_DISABLE_AUTOUPDATE: "1",
    },
    stdin: "pipe",
    stdout: "pipe",
    stderr: "inherit",
  })
  const reader = (child.stdout as ReadableStream<Uint8Array>).getReader()
  let buffer = ""
  ready = await until(
    async () => {
      const chunk = await reader.read()
      if (chunk.done) throw new Error(`Fixture exited before READY: ${buffer}`)
      buffer += new TextDecoder().decode(chunk.value)
      const line = buffer.split("\n").find((item) => item.startsWith("READY "))
      return line ? (JSON.parse(line.slice(6)) as Ready) : undefined
    },
    "runtime READY",
    120_000,
  )
  reader.releaseLock()
  server = { url: ready.url, username: "opencode", password: ready.password }
  current = createApiForServer({ server })
  api = createCompatibleApi({
    protocol: detectServerProtocol(server, fetch),
    current,
    legacy,
    directory: ready.workspace,
  })
  void (async () => {
    for await (const item of current.event.subscribe({ signal: abort.signal })) events.push(item)
  })().catch(() => undefined)
  await until(() => events.find((item) => item.type === "server.connected"), "event stream")
}, 150_000)

afterAll(async () => {
  abort.abort()
  if (child) {
    ;(child.stdin as { end?: () => void }).end?.()
    await Promise.race([child.exited, Bun.sleep(15_000).then(() => child?.kill())])
  }
  if (root) await rm(root, { recursive: true, force: true })
}, 30_000)

describe("app adapters on the published 2.2.5 runtime", () => {
  test("detects the 2.2.5 sidecar as V2", async () => {
    expect(await detectServerProtocol(server, fetch)).toBe("v2")
  })

  test("refreshes initially empty history after a prompt, as workflow actions do", async () => {
    const session = await create()
    const store = createServerSession(legacy(), api.session, current.message, {
      protocol: Promise.resolve("v2"),
      retry: (run) => run(),
    })
    await store.sync(session.id)
    expect(store.data.message[session.id]).toEqual([])
    await prompt(session.id, "hello after empty history")
    await event("session.execution.succeeded", (item) => item.data.sessionID === session.id)
    await store.sync(session.id, { force: true })
    expect(store.data.message[session.id].map((message) => message.role)).toEqual(["user", "assistant"])
  }, 60_000)

  test("prompt streams, completes, and normalizes into app history", async () => {
    const session = await create()
    await prompt(session.id, "hello")
    await event("session.execution.succeeded", (item) => item.data.sessionID === session.id)
    expect(events.some((item) => item.type === "session.text.delta" && item.data.sessionID === session.id)).toBe(true)

    // Same request and ordering as server-session fetchMessages: newest-first page, reversed.
    const history = await current.message.list({ sessionID: session.id, limit: 50, order: "desc" })
    const normalized = normalizeSessionMessages(session.id, history.data.toReversed())
    const roles = normalized.messages.map((message) => message.role)
    expect(roles).toEqual(["user", "assistant"])
    const parts = [...normalized.parts.values()].flat()
    expect(parts.some((part) => part.type === "text" && part.text.includes("V2_APP_OK"))).toBe(true)
    expect(parts.some((part) => part.type === "text" && part.text === "hello")).toBe(true)
  }, 60_000)

  test("rename, archive and the home index follow 2.2.5 session state", async () => {
    const session = await create()
    const created = adaptServerEvent(await event("session.created", (item) => item.data.sessionID === session.id))
    expect(created).toMatchObject({
      type: "session.created",
      properties: { info: { id: session.id, directory: ready.workspace } },
    })
    await api.session.rename({ sessionID: session.id, title: "Renamed by app" })
    expect((await api.session.get({ sessionID: session.id })).title).toBe("Renamed by app")
    expect(adaptServerEvent(await event("session.renamed", (item) => item.data.sessionID === session.id)).type).toBe(
      "session.renamed",
    )

    const before = await loadHomeSessionIndex((input, options) => legacy().v2.session.list(input, options))
    expect(before.sessions.some((item) => item.id === session.id && item.title === "Renamed by app")).toBe(true)

    await api.session.archive({ sessionID: session.id, directory: ready.workspace })
    expect(typeof (await api.session.get({ sessionID: session.id })).time.archived).toBe("number")
    const archived = adaptServerEvent(await event("session.archived", (item) => item.data.sessionID === session.id))
    expect(archived).toMatchObject({ type: "session.next.archived", properties: { sessionID: session.id } })
    const after = await loadHomeSessionIndex((input, options) => legacy().v2.session.list(input, options))
    expect(after.sessions.some((item) => item.id === session.id)).toBe(false)
  }, 60_000)

  test("question tool round-trips through the app question adapter", async () => {
    const session = await create()
    await prompt(session.id, "ASK_QUESTION please")
    const created = await event("form.created", (item) => item.data.form.sessionID === session.id)
    const asked = adaptServerEvent(created)
    expect(asked.type).toBe("question.asked")
    const listed = await api.question.request.list({ location: { directory: ready.workspace } })
    const question = listed.data.find((item) => item.sessionID === session.id)
    expect(question?.questions[0]).toMatchObject({
      question: "Which option?",
      options: [{ label: "Alpha" }, { label: "Beta" }],
    })
    expect(question?.tool?.callID).toBe("call_q")

    await api.question.reply({ sessionID: session.id, requestID: question!.id, answers: [["Beta"]] })
    expect(adaptServerEvent(await event("form.replied", (item) => item.data.id === question!.id)).type).toBe(
      "question.replied",
    )
    await event("session.execution.succeeded", (item) => item.data.sessionID === session.id)
    expect((await modelRequests()).some((messages) => messages.includes("Beta"))).toBe(true)
  }, 60_000)

  test("queued admission and interrupt cancel an active run", async () => {
    const session = await create()
    await prompt(session.id, "HOLD_FOR_INTERRUPT")
    await event("session.execution.started", (item) => item.data.sessionID === session.id)
    await prompt(session.id, "queued follow-up", { delivery: "queue" })
    const queued = await event(
      "session.inbox.enqueued",
      (item) => item.data.sessionID === session.id && JSON.stringify(item.data.item).includes("queued follow-up"),
    )
    // The reducer keeps it as pending until delivery; the composer shows it as queued.
    expect(adaptServerEvent(queued).current).toBe(queued)
    expect(
      (await current.session.inbox.list({ sessionID: session.id })).some((item) => item.id === queued.data.inboxID),
    ).toBe(true)
    await current.session.inbox.cancel({ sessionID: session.id, inboxID: queued.data.inboxID })
    await event("session.inbox.cancelled", (item) => item.data.sessionID === session.id)

    await api.session.interrupt({ sessionID: session.id })
    await event("session.execution.interrupted", (item) => item.data.sessionID === session.id)
    expect(await api.session.active()).not.toHaveProperty(session.id)
  }, 60_000)

  test("provider, model, command, config and shell settings load through app loaders", async () => {
    const providers = await loadProviders(ready.workspace, current, legacy(ready.workspace), Promise.resolve("v2"))
    const provider = [...providers.all.values()].find((item) => item.id === "cookiemonster")
    expect(provider?.models).toHaveProperty("m")
    expect(providers.connected).toContain("cookiemonster")

    const shells = await current.config.shells()
    expect(shells.length).toBeGreaterThan(0)
    const seen = events.length
    await current.config.update({ shell: shells[0]!.path })
    // 2.2.5 writes, then reloads asynchronously; server-sync refetches config on config.updated.
    await until(() => events.slice(seen).find((item) => item.type === "config.updated"), "config.updated")
    const config = await new QueryClient().fetchQuery(
      loadGlobalConfigQuery(ServerScope.local, legacy(), Promise.resolve("v2"), current.config),
    )
    expect(config).toEqual({ shell: shells[0]!.path })
    await current.config.update({ shell: null })
  }, 60_000)

  test("files list and read into the V1 tree and viewer shapes", async () => {
    const nodes = await api.file.nodes({ path: "" })
    expect(nodes).toContainEqual({
      name: "hello.ts",
      path: "hello.ts",
      absolute: join(ready.workspace, "hello.ts"),
      type: "file",
      ignored: false,
    })
    expect(await api.file.content({ path: "hello.ts" })).toEqual({ type: "text", content: "export const hello = 1\n" })
    const image = await api.file.content({ path: "pixel.png" })
    expect(image).toMatchObject({ type: "binary", encoding: "base64", mimeType: "image/png" })
    expect(image.content.startsWith("iVBORw0KGgo")).toBe(true)
  }, 30_000)

  test("terminal connects with a 2.2.5 ticket and runs a command", async () => {
    const pty = await current.pty.create({ location: { directory: ready.workspace }, title: "app-test" })
    try {
      const ticket = await current.pty.connect.token({
        ptyID: pty.data.id,
        location: { directory: ready.workspace },
        "x-opencode-ticket": "1",
      })
      const url = terminalWebSocketURL({
        protocol: "v2",
        url: ready.url,
        id: pty.data.id,
        directory: ready.workspace,
        cursor: 0,
        ticket: ticket.data.ticket,
      })
      const socket = new WebSocket(url)
      socket.binaryType = "arraybuffer"
      let output = ""
      socket.onmessage = (message) => {
        output +=
          typeof message.data === "string" ? message.data : new TextDecoder().decode(message.data as ArrayBuffer)
      }
      await until(() => socket.readyState === WebSocket.OPEN || undefined, "pty socket")
      socket.send("echo CM_PTY_$((40+2))\r")
      await until(() => output.includes("CM_PTY_42") || undefined, "pty output")
      socket.close()
    } finally {
      await current.pty.remove({ ptyID: pty.data.id, location: { directory: ready.workspace } })
    }
  }, 30_000)

  test("project edit, git init, vcs branch and worktree lifecycle", async () => {
    const project = await api.project.current({ location: { directory: ready.workspace } })
    const updated = await api.project.update({
      projectID: project.id,
      name: "App Fixture",
      commands: { start: "true" },
    })
    expect(updated).toMatchObject({ id: project.id, name: "App Fixture", commands: { start: "true" } })

    const vcs = await current.vcs.get({ location: { directory: ready.workspace } })
    expect(vcs.data.branch.current).toBe("main")

    const initialized = await api.project.initGit({ location: { directory: ready.plain } })
    expect(await Bun.file(join(ready.plain, ".git", "HEAD")).exists()).toBe(true)
    expect(initialized.id).toBeTruthy()

    const worktree = await current.worktree.create({ projectID: project.id })
    expect(await Bun.file(join(worktree.directory, "hello.ts")).exists()).toBe(true)
    // Workspace reset goes through the CM sidecar extension (2.2.5 has no native reset).
    const extensions = createExtensionClient(server, fetch)
    await Bun.write(join(worktree.directory, "scratch.txt"), "dirty")
    await Bun.write(join(worktree.directory, "hello.ts"), "changed")
    expect(await extensions.worktree.reset(ready.workspace, worktree.directory)).toBe(true)
    expect(await Bun.file(join(worktree.directory, "scratch.txt")).exists()).toBe(false)
    expect(await Bun.file(join(worktree.directory, "hello.ts")).text()).toBe("export const hello = 1\n")
    await expect(extensions.worktree.reset(ready.workspace, ready.workspace)).rejects.toThrow()
    await current.worktree.remove({ projectID: project.id, directory: worktree.directory, force: false })
    expect(await Bun.file(join(worktree.directory, "hello.ts")).exists()).toBe(false)
  }, 60_000)

  test("credential disconnect removes stored integration keys", async () => {
    await current.credential.create({ integrationID: "openrouter", value: { type: "key", key: "fixture-key" } })
    expect((await current.credential.list()).some((item) => item.integrationID === "openrouter")).toBe(true)
    await api.integration.disconnect({ integrationID: "openrouter" })
    expect((await current.credential.list()).some((item) => item.integrationID === "openrouter")).toBe(false)
  }, 30_000)

  test("managed skills surface as slash entries and are admitted by exact identity", async () => {
    const extension = async (path: string, body: unknown) => {
      const response = await fetch(`${ready.url}/skill/${path}?directory=${encodeURIComponent(ready.workspace)}`, {
        method: "POST",
        headers: {
          authorization: `Basic ${btoa(`opencode:${ready.password}`)}`,
          "content-type": "application/json",
        },
        body: JSON.stringify(body),
      })
      expect(response.status).toBe(200)
      return (await response.json()) as { token: string }
    }
    const draft = {
      name: "app-fixture-skill",
      description: "App fixture",
      instructions: "SKILL_MARKER_CONTENT",
      scope: "workspace",
    }
    const reviewed = await extension("review", draft)
    await extension("create", { ...draft, token: reviewed.token })

    const skills = createExtensionClient(server, fetch).skills
    const commands = await loadCommands(
      ready.workspace,
      current.command,
      legacy(),
      Promise.resolve("v2"),
      skills.catalog,
    )
    const entry = commands.find((item) => item.name === draft.name)
    expect(entry?.skill).toMatchObject({ name: draft.name, description: draft.description })

    const session = await create()
    await skills.select(ready.workspace, session.id, [entry!.skill!])
    await prompt(session.id, `/${draft.name} go`)
    await event("session.execution.succeeded", (item) => item.data.sessionID === session.id)
    const history = await current.message.list({ sessionID: session.id })
    expect(JSON.stringify(history)).toContain("V2_SKILL_SEEN")

    await expect(
      skills.select(ready.workspace, session.id, [{ ...entry!.skill!, revision: "stale" }]),
    ).rejects.toThrow()
  }, 60_000)

  test("session export uses the native 2.2.5 transfer format", async () => {
    const session = await create()
    await prompt(session.id, "export me")
    await event("session.execution.succeeded", (item) => item.data.sessionID === session.id)
    const data = await fetchSessionExport({
      sessionID: session.id,
      client: legacy(),
      protocol: Promise.resolve("v2"),
      api: current.experimental.session,
    })
    expect(data.info.id).toBe(session.id)
    expect(data.messages.length).toBeGreaterThanOrEqual(2)
  }, 60_000)

  test("CM schedules notify through rpc.cookiemonster.features.schedule, including pre-admission auth waits", async () => {
    const scheduling = createSchedulingClient(server, fetch)
    const schedule = (name: string) =>
      scheduling.manage({
        action: "create",
        definition: {
          schemaVersion: 1,
          name,
          prompt: "scheduled hello",
          notification: "all_runs",
          target: {
            type: "new_session",
            directory: ready.workspace,
            workspace: { type: "local" },
            model: { providerID: "cookiemonster", id: "m" },
          },
          schedule: { type: "once", at: new Date(Date.now() + 1200).toISOString() },
        },
      } as Parameters<typeof scheduling.manage>[0])
    const rpc = (name: string, state: string) =>
      until(
        () =>
          events
            .filter((item) => item.type === "rpc.cookiemonster.features.schedule")
            .map((item) => ({ item, data: scheduleNotification((item as { data: Record<string, unknown> }).data) }))
            .find((entry) => entry.data?.name === name && entry.data.state === state),
        `${name} ${state} notification`,
        30_000,
      )

    await schedule("App completed run")
    const done = await rpc("App completed run", "completed")
    expect(done.data?.sessionID).toStartWith("ses")
    expect((done.item as { location?: { directory?: string } }).location?.directory).toBe(ready.workspace)
    expect((await scheduling.list()).occurrences.some((item) => item.state === "completed")).toBe(true)

    await fetch(`${ready.model}/control/signout`)
    try {
      await schedule("App auth wait")
      const waiting = await until(
        () =>
          events
            .filter((item) => item.type === "rpc.cookiemonster.features.schedule")
            .map((item) => scheduleNotification((item as { data: Record<string, unknown> }).data))
            .find((data) => data?.name === "App auth wait"),
        "auth wait notification",
        30_000,
      )
      expect(waiting.state).not.toBe("completed")
    } finally {
      await fetch(`${ready.model}/control/signin`)
    }
  }, 90_000)

  test("location-less 2.2.5 session events route to their session directory, never the global bucket", () => {
    // server-sync registers this resolver from its session cache, which session.created feeds.
    const known = new Map(
      events.flatMap((item) =>
        item.type === "session.created" ? [[item.data.sessionID, item.data.location.directory]] : [],
      ),
    )
    const sessionScoped = events.filter(
      (item) =>
        !item.location && "data" in item && typeof (item.data as { sessionID?: unknown })?.sessionID === "string",
    )
    expect(sessionScoped.length).toBeGreaterThan(0)
    for (const item of sessionScoped) expect(eventDirectory(item, (id) => known.get(id))).toBe(ready.workspace)
  })
})
