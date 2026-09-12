import { PermissionV1 } from "@opencode-ai/core/v1/permission"
import { NodeHttpServer, NodeServices } from "@effect/platform-node"
import { Flag } from "@opencode-ai/core/flag/flag"
import { describe, expect } from "bun:test"
import { Config, Context, Effect, FileSystem, Layer, Path } from "effect"
import { HttpClient, HttpClientRequest, HttpRouter, HttpServer } from "effect/unstable/http"
import * as Socket from "effect/unstable/socket/Socket"
import { WorkspaceV2 } from "@opencode-ai/core/workspace"
import { ControlPaths } from "../../src/server/routes/instance/httpapi/groups/control"
import { InstancePaths } from "../../src/server/routes/instance/httpapi/groups/instance"
import { SessionPaths } from "../../src/server/routes/instance/httpapi/groups/session"
import { ProjectV2 } from "@opencode-ai/core/project"
import { QuestionID } from "../../src/question/schema"
import { HttpApiApp } from "../../src/server/routes/instance/httpapi/server"
import { HEADER as FenceHeader } from "../../src/server/shared/fence"
import { resetDatabase } from "../fixture/db"
import { tmpdirScoped } from "../fixture/fixture"
import { testEffect } from "../lib/effect"
import { createClient } from "../../../sdk/js/src/gen/client/client.gen"
import { Schema } from "effect"
import { ManagedSkill } from "../../src/skill/managed"
import path from "node:path"
import { pathToFileURL } from "node:url"
import { OpencodeClient } from "../../../sdk/js/src/gen/sdk.gen"

// Flip the experimental workspaces flag so EventV2.run actually writes to
// EventSequenceTable (the source of truth the fence middleware reads). Reset
// the database around the test so per-instance state does not leak between
// runs. resetDatabase() already calls disposeAllInstances(), so we don't
// repeat it.
const testStateLayer = Layer.effectDiscard(
  Effect.gen(function* () {
    const originalWorkspaces = Flag.OPENCODE_EXPERIMENTAL_WORKSPACES
    Flag.OPENCODE_EXPERIMENTAL_WORKSPACES = true
    yield* Effect.promise(() => resetDatabase())
    yield* Effect.addFinalizer(() =>
      Effect.promise(async () => {
        Flag.OPENCODE_EXPERIMENTAL_WORKSPACES = originalWorkspaces
        await resetDatabase()
      }),
    )
  }),
)

// Mount the production HttpApi route tree on a real Node HTTP server bound to
// 127.0.0.1:0 and a fetch-based HttpClient that prepends the server URL. This
// keeps the test wired directly through the same route layer production uses.
const servedRoutes: Layer.Layer<never, Config.ConfigError, HttpServer.HttpServer> = HttpRouter.serve(
  HttpApiApp.routes,
  { disableListenLog: true, disableLogger: true },
)

const httpApiServerLayer = servedRoutes.pipe(
  Layer.provide(Socket.layerWebSocketConstructorGlobal),
  Layer.provideMerge(NodeHttpServer.layerTest),
  Layer.provideMerge(NodeServices.layer),
)

const it = testEffect(Layer.mergeAll(testStateLayer, httpApiServerLayer))
const handlerContext = Context.empty() as Context.Context<unknown>

const directoryHeader = (dir: string) => HttpClientRequest.setHeader("x-opencode-directory", dir)

describe("instance HttpApi", () => {
  const aeSource = process.env.CM_AE_SOURCE_DIR
  const aeTest = aeSource ? it.live : it.live.skip
  aeTest("AE chat saves a reviewed skill through CM and reuses it after reload without workspace leakage", () =>
    Effect.gen(function* () {
      const dir = yield* tmpdirScoped({ git: true })
      const other = yield* tmpdirScoped({ git: true })
      if (!path.isAbsolute(aeSource!)) throw new Error("CM_AE_SOURCE_DIR must be absolute")
      const { createChat } = yield* Effect.promise(() => import(pathToFileURL(path.join(aeSource!, "src/chat.mjs")).href))
      const { panelFixture } = yield* Effect.promise(() => import(pathToFileURL(path.join(aeSource!, "test/bridge-panel.mjs")).href))
      const cleanup: Array<() => Promise<void>> = []
      yield* Effect.addFinalizer(() => Effect.promise(async () => {
        for (const close of cleanup) await close()
      }))
      const panel = yield* Effect.promise(async () => {
        return await panelFixture({ after: (close: () => Promise<void>) => cleanup.push(close) }) as {
          dataDir: string
          bridge: { setChatHandler: (handler: unknown) => void; release: (session: string) => Promise<void> }
          state: { project: { id: string; path: string; saved: boolean } }
          send: (route: string, body: Record<string, unknown>) => Promise<{
            status: number
            body: {
              error: { message: string; code: string }
              result: {
                sessionID: string
                destination: string
                revision: string
                token: string
                delivery: string
                skills: Array<{ name: string; source: string; revision: string; content?: string }>
              }
            }
          }>
        }
      })
      const transport = createClient({
        baseUrl: "http://localhost",
        fetch: (request) => HttpApiApp.webHandler().handler(request instanceof Request ? request : new Request(request), handlerContext),
      })
      const sdk = new OpencodeClient({ client: transport })
      const prompts: Array<Parameters<typeof sdk.session.promptAsync>[0]> = []
      // CM sessions, skill endpoints, files, SDK and AE chat transport are real.
      // Only model execution and AE composition inspection are replaced.
      const client = {
        _client: transport,
        session: {
          create: sdk.session.create.bind(sdk.session),
          get: sdk.session.get.bind(sdk.session),
          status: sdk.session.status.bind(sdk.session),
          messages: sdk.session.messages.bind(sdk.session),
          abort: sdk.session.abort.bind(sdk.session),
          promptAsync: async (options: Parameters<typeof sdk.session.promptAsync>[0]) => {
            prompts.push(options)
            return { data: undefined }
          },
        },
      }
      const runtime = {
        dataDir: panel.dataDir, bridge: panel.bridge,
        checkpoints: { list: async () => [] },
        workflow: { inspectQuery: async () => ({ items: [{ id: 1, kind: "comp", name: "Main" }] }) },
      }
      const connect = async () => {
        const chat = await createChat(runtime)
        chat.register({ client, directory: dir })
        chat.register({ client, directory: other })
        panel.bridge.setChatHandler(chat.handle)
        return chat
      }
      const send = async (body: Record<string, unknown> = {}) => {
        const response = await panel.send("/chat", { action: "state", project: panel.state.project, ...body })
        if (response.status !== 200) throw Object.assign(new Error(response.body.error.message), response.body.error)
        return response.body.result
      }
      yield* Effect.promise(async () => {
        await panel.bridge.release("session")
        await connect()
        const first = await send({ action: "new", directory: dir })
        const draft = { name: "ae-reusable-motion", description: "Reusable logo easing", instructions: "Keep the logo fixed.\nUse a short ease out.", scope: "workspace" }
        const review = await send({ action: "skillReview", draft, directory: dir, sessionID: first.sessionID })
        const receipt = await send({ action: "skillSave", draft, directory: dir, sessionID: first.sessionID, token: review.token })
        expect(receipt.destination).toBe(path.join(dir, ".opencode", "skills", draft.name, "SKILL.md"))
        expect((await Bun.file(receipt.destination).text())).toContain(draft.instructions)
        await connect()
        expect((await send()).sessionID).toBe(first.sessionID)
        const later = await send({ action: "new", directory: dir })
        expect(later.sessionID).not.toBe(first.sessionID)
        const catalog = await send({ action: "skills" })
        const selected = catalog.skills.find((item: { name: string }) => item.name === draft.name)
        if (!selected) throw new Error("Saved skill missing from the real CM catalog")
        expect(selected?.revision).toBe(receipt.revision)
        expect(selected.content).toBeUndefined()
        const skill = { name: selected.name, source: selected.source, revision: selected.revision, directory: dir, sessionID: later.sessionID }
        const sent = await send({ action: "send", text: "Apply the saved logo easing", compId: 1, requestId: "a".repeat(40), skill })
        expect(sent.delivery).toBe("accepted")
        expect(prompts[0]?.body?.parts[0]).toMatchObject({ metadata: { cmSkill: { name: selected.name, source: selected.source, revision: selected.revision } } })
        await send({ action: "new", directory: other })
        const foreign = await send({ action: "skills" })
        expect(foreign.skills.some((item: { name: string }) => item.name === draft.name)).toBe(false)
        await expect(send({ action: "send", text: "Do not use the other workspace's skill", compId: 1, requestId: "b".repeat(40), skill })).rejects.toMatchObject({ code: "stale_skill" })
        expect(prompts.length).toBe(1)
        await send({ action: "new", directory: dir })
        await Bun.file(receipt.destination).delete()
        const missing = await send({ action: "skills" })
        expect(missing.skills.some((item: { name: string }) => item.name === draft.name)).toBe(false)
      })
    }),
    { timeout: 60_000 },
  )

  it.live("legacy SDK transport creates reviewed skills and sees fresh metadata without disposal", () =>
    Effect.gen(function* () {
      const dir = yield* tmpdirScoped({ git: true })
      const client = createClient({
        baseUrl: "http://localhost",
        fetch: (request) =>
          HttpApiApp.webHandler().handler(request instanceof Request ? request : new Request(request), handlerContext),
      })
      const draft: ManagedSkill.Draft = {
        name: "route-motion",
        description: "Motion rules",
        instructions: "Keep logo fixed",
        scope: "workspace",
      }
      const post = (url: string, body: unknown) =>
        Effect.promise(() =>
          client.post({
            url,
            query: { directory: dir },
            headers: { "Content-Type": "application/json" },
            body,
          }),
        )
      const before = yield* Effect.promise(() => client.get({ url: "/skill/catalog", query: { directory: dir } }))
      expect(before.error).toBeUndefined()
      const reviewed = yield* post("/skill/review", draft)
      expect(reviewed.error).toBeUndefined()
      const review = Schema.decodeUnknownSync(ManagedSkill.Review)(reviewed.data)
      const saved = yield* post("/skill/create", { ...draft, token: review.token })
      expect(saved.error).toBeUndefined()
      const receipt = Schema.decodeUnknownSync(ManagedSkill.Receipt)(saved.data)
      expect(receipt.digest).toBe(review.digest)
      const fresh = yield* Effect.promise(() => client.get({ url: "/skill/catalog", query: { directory: dir } }))
      const list = Schema.decodeUnknownSync(Schema.Array(ManagedSkill.Metadata))(fresh.data)
      expect(list.find((s) => s.name === draft.name)?.revision).toBe(receipt.revision)
      expect(JSON.stringify(fresh.data)).not.toContain(draft.instructions)
      const selected = { name: receipt.name, source: receipt.source, revision: receipt.revision }
      const valid = yield* post("/skill/validate", selected)
      expect(valid.error).toBeUndefined()
      expect(JSON.stringify(valid.data)).not.toContain(draft.instructions)
      const again = yield* post("/skill/create", { ...draft, token: review.token })
      expect(again.response.status).toBe(400)
      const fs = yield* FileSystem.FileSystem
      yield* fs.remove(receipt.destination)
      const missing = yield* post("/skill/validate", selected)
      expect(missing.response.status).toBe(400)
    }),
  )

  it.live("serves the OpenAPI document", () =>
    Effect.gen(function* () {
      const response = yield* HttpClient.get("/doc")

      expect(response.status).toBe(200)
      expect(response.headers["content-type"]).toContain("application/json")
      expect(yield* response.json).toMatchObject({
        openapi: expect.any(String),
        info: expect.any(Object),
        paths: expect.objectContaining({
          "/global/health": expect.any(Object),
          "/session": expect.any(Object),
        }),
      })
    }),
  )

  it.live("emits a sync fence header for fixed-workspace mutations", () =>
    Effect.gen(function* () {
      const originalWorkspaceID = Flag.OPENCODE_WORKSPACE_ID
      Flag.OPENCODE_WORKSPACE_ID = WorkspaceV2.ID.ascending()
      yield* Effect.addFinalizer(() =>
        Effect.sync(() => {
          Flag.OPENCODE_WORKSPACE_ID = originalWorkspaceID
        }),
      )

      const dir = yield* tmpdirScoped({ git: true })
      const response = yield* HttpClientRequest.post(SessionPaths.create).pipe(
        directoryHeader(dir),
        HttpClientRequest.bodyJson({ title: "fenced" }),
        Effect.flatMap(HttpClient.execute),
      )

      expect(response.status).toBe(200)
      expect(JSON.parse(response.headers[FenceHeader] ?? "{}")).not.toEqual({})
    }),
  )

  it.live("does not emit sync fence headers for fixed-workspace reads or no-op mutations", () =>
    Effect.gen(function* () {
      const originalWorkspaceID = Flag.OPENCODE_WORKSPACE_ID
      Flag.OPENCODE_WORKSPACE_ID = WorkspaceV2.ID.ascending()
      yield* Effect.addFinalizer(() =>
        Effect.sync(() => {
          Flag.OPENCODE_WORKSPACE_ID = originalWorkspaceID
        }),
      )

      const dir = yield* tmpdirScoped({ git: true })
      const read = yield* HttpClientRequest.get(InstancePaths.path).pipe(directoryHeader(dir), HttpClient.execute)
      const log = yield* HttpClientRequest.post(ControlPaths.log).pipe(
        directoryHeader(dir),
        HttpClientRequest.bodyJson({ service: "fence-test", level: "info", message: "noop" }),
        Effect.flatMap(HttpClient.execute),
      )

      expect(read.status).toBe(200)
      expect(read.headers[FenceHeader]).toBeUndefined()
      expect(log.status).toBe(200)
      expect(log.headers[FenceHeader]).toBeUndefined()
    }),
  )

  it.live("rejects malformed permission and question request ids", () =>
    Effect.gen(function* () {
      const dir = yield* tmpdirScoped({ git: true })
      const request = (path: string, init?: RequestInit) =>
        Effect.promise(() =>
          HttpApiApp.webHandler().handler(
            new Request(`http://localhost${path}`, {
              ...init,
              headers: { "x-opencode-directory": dir, "content-type": "application/json", ...init?.headers },
            }),
            handlerContext,
          ),
        )
      const [permission, questionReply, questionReject] = yield* Effect.all(
        [
          request("/permission/invalid-permission-id/reply", {
            method: "POST",
            body: JSON.stringify({ reply: "once" }),
          }),
          request("/question/invalid-question-id/reply", {
            method: "POST",
            body: JSON.stringify({ answers: [["Yes"]] }),
          }),
          request("/question/invalid-question-id/reject", { method: "POST" }),
        ],
        { concurrency: "unbounded" },
      )

      expect(permission.status).toBe(400)
      expect(questionReply.status).toBe(400)
      expect(questionReject.status).toBe(400)
    }),
  )

  it.live("returns typed not found bodies for missing permission and question requests", () =>
    Effect.gen(function* () {
      const dir = yield* tmpdirScoped({ git: true })
      const request = (path: string, init?: RequestInit) =>
        Effect.promise(() =>
          HttpApiApp.webHandler().handler(
            new Request(`http://localhost${path}`, {
              ...init,
              headers: { "x-opencode-directory": dir, "content-type": "application/json", ...init?.headers },
            }),
            handlerContext,
          ),
        )
      const permissionID = PermissionV1.ID.ascending()
      const questionReplyID = QuestionID.ascending()
      const questionRejectID = QuestionID.ascending()
      const [permission, questionReply, questionReject] = yield* Effect.all(
        [
          request(`/permission/${permissionID}/reply`, {
            method: "POST",
            body: JSON.stringify({ reply: "once" }),
          }),
          request(`/question/${questionReplyID}/reply`, {
            method: "POST",
            body: JSON.stringify({ answers: [["Yes"]] }),
          }),
          request(`/question/${questionRejectID}/reject`, { method: "POST" }),
        ],
        { concurrency: "unbounded" },
      )

      expect(permission.status).toBe(404)
      expect(yield* Effect.promise(() => permission.json())).toEqual({
        _tag: "PermissionNotFoundError",
        requestID: permissionID,
        message: `Permission request not found: ${permissionID}`,
      })
      expect(questionReply.status).toBe(404)
      expect(yield* Effect.promise(() => questionReply.json())).toEqual({
        _tag: "QuestionNotFoundError",
        requestID: questionReplyID,
        message: `Question request not found: ${questionReplyID}`,
      })
      expect(questionReject.status).toBe(404)
      expect(yield* Effect.promise(() => questionReject.json())).toEqual({
        _tag: "QuestionNotFoundError",
        requestID: questionRejectID,
        message: `Question request not found: ${questionRejectID}`,
      })
    }),
  )

  it.live("returns typed not found bodies for missing projects", () =>
    Effect.gen(function* () {
      const dir = yield* tmpdirScoped({ git: true })
      const projectID = ProjectV2.ID.make("project_missing")
      const response = yield* Effect.promise(() =>
        HttpApiApp.webHandler().handler(
          new Request(`http://localhost/project/${projectID}`, {
            method: "PATCH",
            headers: { "x-opencode-directory": dir, "content-type": "application/json" },
            body: JSON.stringify({ name: "Missing" }),
          }),
          handlerContext,
        ),
      )

      expect(response.status).toBe(404)
      expect(yield* Effect.promise(() => response.json())).toEqual({
        _tag: "ProjectNotFoundError",
        projectID,
        message: `Project not found: ${projectID}`,
      })
    }),
  )

  it.live("serves path and VCS read endpoints", () =>
    Effect.gen(function* () {
      const dir = yield* tmpdirScoped({ git: true })
      const fs = yield* FileSystem.FileSystem
      const path = yield* Path.Path
      yield* fs.writeFileString(path.join(dir, "changed.txt"), "hello")

      const [paths, vcs, diff] = yield* Effect.all(
        [
          HttpClientRequest.get(InstancePaths.path).pipe(directoryHeader(dir), HttpClient.execute),
          HttpClientRequest.get(InstancePaths.vcs).pipe(directoryHeader(dir), HttpClient.execute),
          HttpClientRequest.get(InstancePaths.vcsDiff).pipe(
            HttpClientRequest.setUrlParam("mode", "git"),
            directoryHeader(dir),
            HttpClient.execute,
          ),
        ],
        { concurrency: "unbounded" },
      )

      expect(paths.status).toBe(200)
      expect(yield* paths.json).toMatchObject({ directory: dir, worktree: dir })

      expect(vcs.status).toBe(200)
      expect(yield* vcs.json).toMatchObject({ branch: expect.any(String) })

      expect(diff.status).toBe(200)
      expect(yield* diff.json).toContainEqual(
        expect.objectContaining({ file: "changed.txt", additions: 1, status: "added" }),
      )
    }),
  )
})
