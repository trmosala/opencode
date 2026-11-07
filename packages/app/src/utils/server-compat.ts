import type { ServerApi } from "./server"
import type { ServerProtocol } from "./server-protocol"
import type {
  AgentPartInput,
  FileContent,
  FileNode,
  FilePartInput,
  OpencodeClient,
  ProviderAuthMethod,
  QuestionRequest,
  Session,
  TextPartInput,
} from "@opencode-ai/sdk/v2/client"
import type {
  FormField,
  FormFields,
  FormInfo,
  Project,
  SessionApi,
  SessionCommandInput,
  SessionCommandOutput,
  SessionCompactInput,
  SessionCompactOutput,
  SessionInfo,
  SessionPromptInput,
  SessionPromptOutput,
  SessionShellInput,
  SessionShellOutput,
} from "@opencode/client/promise"
import { fileExtension, mediaKindFromPath } from "@opencode-ai/session-ui/pierre/media"

type LegacyClient = OpencodeClient
type LegacyProject = NonNullable<Awaited<ReturnType<LegacyClient["project"]["current"]>>["data"]>
type LegacyFor = (directory?: string) => LegacyClient
type CompatibleSessionApi = Omit<SessionApi, "prompt" | "command" | "shell" | "compact" | "remove"> & {
  prompt: (input: SessionPromptInput & LegacyPrompt) => Promise<SessionPromptOutput>
  command: (input: LegacyCommandInput) => Promise<SessionCommandOutput>
  shell: (input: SessionShellInput & LegacyPrompt) => Promise<SessionShellOutput>
  compact: (input: SessionCompactInput & { model?: LegacyPrompt["model"] }) => Promise<SessionCompactOutput>
  // 2.2.5 renames and archives through session.update; kept as one call each for both protocols.
  rename: (input: { sessionID: string; title: string } & LegacyLocation) => Promise<void>
  archive: (input: { sessionID: string } & LegacyLocation) => Promise<void>
  remove: (input: Parameters<SessionApi["remove"]>[0] & LegacyLocation) => ReturnType<SessionApi["remove"]>
}
type CompatiblePermissionApi = Omit<ServerApi["permission"], "reply"> & {
  reply: (
    input: Parameters<ServerApi["permission"]["reply"]>[0] & { location?: { directory?: string } },
  ) => ReturnType<ServerApi["permission"]["reply"]>
}
export type ProjectCurrent = { id: string; directory: string }
type CompatibleProjectApi = ServerApi["project"] & {
  current: (input?: { location?: LegacyLocation }) => Promise<ProjectCurrent>
  directories: (input: { projectID: string; location?: LegacyLocation }) => Promise<{ directory: string }[]>
  // Initializes git in the Location and returns its (possibly new) project.
  initGit: (input?: { location?: LegacyLocation }) => Promise<Project | LegacyProject>
}
// 2.2.5 asks the question tool's questions through a Form; the app keeps its question UI and request shape.
type CompatibleQuestionApi = {
  request: { list: (input?: { location?: LegacyLocation }) => Promise<{ data: QuestionRequest[] }> }
  reply: (input: { sessionID: string; requestID: string; answers: readonly (readonly string[])[] }) => Promise<void>
  reject: (input: { sessionID: string; requestID: string }) => Promise<void>
}
// The file tree and viewers keep the V1 FileNode / FileContent shapes on both protocols.
type CompatibleFileApi = ServerApi["file"] & {
  nodes: (input: { path: string; location?: LegacyLocation }) => Promise<FileNode[]>
  content: (input: { path: string; location?: LegacyLocation }) => Promise<FileContent>
}
type CompatibleIntegrationApi = ServerApi["integration"] & {
  // Removes every stored credential for the integration (V1: auth.remove).
  disconnect: (input: { integrationID: string; location?: LegacyLocation }) => Promise<void>
}
export type CompatibleApi = Omit<ServerApi, "session" | "permission" | "project" | "file" | "integration"> & {
  readonly session: CompatibleSessionApi
  readonly permission: CompatiblePermissionApi
  readonly project: CompatibleProjectApi
  readonly question: CompatibleQuestionApi
  readonly file: CompatibleFileApi
  readonly integration: CompatibleIntegrationApi
}
// The app keeps the V1 command vocabulary; 2.2.5 runs commands with the Session's selected agent and model.
type LegacyCommandInput = {
  sessionID: string
  id?: string
  command: string
  arguments?: string
  agent?: string
  model?: { providerID: string; id: string; variant?: string }
  files?: SessionCommandInput["files"]
}
type LegacyPrompt = {
  agent?: string
  model?: { providerID: string; modelID: string }
  variant?: string
  legacyParts?: (TextPartInput | FilePartInput | AgentPartInput)[]
}
type LegacyLocation = { directory?: string }
type CompatibleInput = {
  protocol: Promise<ServerProtocol>
  current: ServerApi
  legacy: LegacyFor
  directory?: string
}

function mime(uri: string) {
  const match = /^data:([^;,]+)/.exec(uri)
  return match?.[1] ?? "application/octet-stream"
}

function sessionInfo(session: Session): SessionInfo {
  return {
    id: session.id,
    parentID: session.parentID,
    projectID: session.projectID,
    agent: session.agent,
    model: session.model && {
      id: session.model.id,
      providerID: session.model.providerID,
      variant: session.model.variant,
    },
    cost: session.cost ?? 0,
    tokens: session.tokens ?? { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
    time: session.time,
    title: session.title,
    location: { directory: session.directory },
    subpath: session.path,
    revert: session.revert && {
      messageID: session.revert.messageID,
      partID: session.revert.partID,
      snapshot: session.revert.snapshot,
    },
  }
}

export function createCompatibleApi(input: CompatibleInput): CompatibleApi {
  const v1 = createV1Api(input)
  const v2 = createV2Api(input.current, input.directory)
  return lazyApi(
    input.protocol.then((protocol) => (protocol === "v1" ? v1 : v2)),
    v2,
  )
}

export function questionFromForm(form: FormInfo): QuestionRequest | undefined {
  if (form.metadata?.kind !== "question") return
  const tool = form.metadata.tool as { messageID?: unknown; id?: unknown } | undefined
  return {
    id: form.id,
    sessionID: form.sessionID,
    questions: form.fields.flatMap((field) =>
      field.type === "string" || field.type === "multiselect"
        ? [
            {
              header: field.title ?? "",
              question: field.description ?? "",
              options: (field.options ?? []).map((option) => ({
                label: option.label,
                description: option.description ?? "",
              })),
              multiple: field.type === "multiselect",
              custom: field.custom,
            },
          ]
        : [],
    ),
    tool:
      typeof tool?.messageID === "string" && typeof tool.id === "string"
        ? { messageID: tool.messageID, callID: tool.id }
        : undefined,
  }
}

function createV2Api(current: ServerApi, directory?: string): CompatibleApi {
  const forms = (location?: LegacyLocation) => current.form.list({ location }).then((result) => result.data)
  const at = (location?: LegacyLocation) => {
    const value = location?.directory ?? directory
    return value ? { directory: value } : undefined
  }
  const select = async (sessionID: string, value: LegacyPrompt) => {
    if (!value.agent && !value.model) return
    const session = await current.session.get({ sessionID })
    if (value.agent && value.agent !== session.agent)
      await current.session.switchAgent({ sessionID, agent: value.agent })
    if (
      value.model &&
      (value.model.providerID !== session.model?.providerID ||
        value.model.modelID !== session.model?.id ||
        (value.variant ?? "default") !== (session.model?.variant ?? "default"))
    )
      await current.session.switchModel({
        sessionID,
        model: { providerID: value.model.providerID, id: value.model.modelID, variant: value.variant },
      })
  }
  return {
    ...current,
    file: {
      ...current.file,
      nodes: async (value) => {
        const location = at(value.location)
        const result = await current.file.list({ location, path: value.path || undefined })
        return result.data.map((entry) => fileNode(result.location.directory, entry))
      },
      content: async (value) =>
        fileContent(value.path, await current.file.read({ location: at(value.location), path: value.path })),
    },
    integration: {
      ...current.integration,
      disconnect: async (value) => {
        const credentials = await current.credential.list()
        await Promise.all(
          credentials
            .filter((item) => item.integrationID === value.integrationID)
            .map((item) => current.credential.remove({ credentialID: item.id })),
        )
      },
    },
    session: {
      ...current.session,
      rename: (value) => current.session.update({ sessionID: value.sessionID, title: value.title }).then(() => {}),
      archive: (value) => current.session.update({ sessionID: value.sessionID, archived: true }),
      async prompt(value) {
        await select(value.sessionID, value)
        return current.session.prompt(value)
      },
      async command(value) {
        await select(value.sessionID, {
          agent: value.agent,
          model: value.model && { providerID: value.model.providerID, modelID: value.model.id },
          variant: value.model?.variant,
        })
        return current.session.command({
          sessionID: value.sessionID,
          name: value.command,
          text: value.arguments ?? "",
          files: value.files,
        })
      },
      async compact(value) {
        await select(value.sessionID, value)
        return current.session.compact(value)
      },
      async shell(value) {
        await select(value.sessionID, value)
        return current.session.shell(value)
      },
    },
    project: {
      ...current.project,
      current: (value) =>
        current.location
          .get({ location: value?.location })
          .then((location) => ({ id: location.project.id, directory: location.project.directory })),
      directories: (value) =>
        current.worktree
          .list({ projectID: value.projectID })
          .then((list) => list.map((item) => ({ directory: item.directory }))),
      async initGit(value) {
        const location = at(value?.location)
        await current.vcs.init({ location })
        const info = await current.location.get({ location })
        const project = (await current.project.list()).find((item) => item.id === info.project.id)
        if (!project) throw new Error(`Project not found: ${info.project.id}`)
        return project
      },
    },
    question: {
      request: {
        list: (value) =>
          forms(at(value?.location)).then((list) => ({ data: list.flatMap((form) => questionFromForm(form) ?? []) })),
      },
      async reply(value) {
        // Session-scoped lookup: the form lives in the Session's Location, not the server default.
        const form = await current.session.form.get({ sessionID: value.sessionID, formID: value.requestID })
        // Fields follow the question order (q0, q1, ...); multiselect keeps every answer, string keeps the first.
        await current.session.form.reply({
          sessionID: value.sessionID,
          formID: value.requestID,
          answer: Object.fromEntries(
            form.fields.flatMap((field, index): [string, string | string[]][] => {
              const answer = value.answers[index] ?? []
              if (field.type === "multiselect") return [[field.key, [...answer]]]
              return answer[0] === undefined ? [] : [[field.key, answer[0]]]
            }),
          ),
        })
      },
      reject: (value) => current.session.form.cancel({ sessionID: value.sessionID, formID: value.requestID }),
    },
  }
}

function lazyApi<T extends object>(implementation: Promise<T>, shape: T): T {
  const cache = new Map<PropertyKey, unknown>()
  return new Proxy(shape, {
    get(target, property, receiver) {
      const sample = Reflect.get(target, property, receiver)
      if (typeof sample === "function") {
        return (...args: unknown[]) =>
          implementation.then((value) => {
            const method = Reflect.get(value, property)
            if (typeof method !== "function") throw new Error(`API method unavailable: ${String(property)}`)
            return Reflect.apply(method, value, args)
          })
      }
      if (sample === null || typeof sample !== "object") return sample
      if (cache.has(property)) return cache.get(property)
      const nested = lazyApi(
        implementation.then((value) => {
          const result = Reflect.get(value, property)
          if (result === null || typeof result !== "object") {
            throw new Error(`API namespace unavailable: ${String(property)}`)
          }
          return result
        }),
        sample,
      )
      cache.set(property, nested)
      return nested
    },
  })
}

function createV1Api(input: CompatibleInput): CompatibleApi {
  const directory = (location?: { directory?: string }) => location?.directory ?? input.directory
  const legacy = (location?: { directory?: string }) => input.legacy(directory(location))
  const located = <T>(data: T, value?: { directory?: string }) => ({
    location: {
      directory: directory(value) ?? "",
      project: { id: "", directory: directory(value) ?? "" },
    },
    data,
  })

  return {
    ...input.current,
    session: {
      ...input.current.session,
      async list(
        value?: Parameters<ServerApi["session"]["list"]>[0],
        options?: Parameters<ServerApi["session"]["list"]>[1],
      ) {
        if (!value?.directory && value?.search !== undefined) {
          const result = await legacy().experimental.session.list(
            {
              roots: value.parentID === null ? true : undefined,
              search: value.search,
              limit: value.limit,
            },
            options,
          )
          return { data: (result.data ?? []).map(sessionInfo), cursor: {} }
        }
        const result = await legacy({ directory: value?.directory }).session.list({
          directory: value?.directory,
          roots: value?.parentID === null ? true : undefined,
          search: value?.search,
          limit: value?.limit,
        })
        return { data: (result.data ?? []).map(sessionInfo), cursor: {} }
      },
      async create(value?: Parameters<ServerApi["session"]["create"]>[0]) {
        const result = await legacy(value?.location ?? undefined).session.create({
          directory: directory(value?.location ?? undefined),
        })
        if (!result.data) throw new Error("Failed to create session")
        return sessionInfo(result.data)
      },
      async get(value: Parameters<ServerApi["session"]["get"]>[0]) {
        const result = await legacy().session.get(value)
        if (!result.data) throw new Error(`Session not found: ${value.sessionID}`)
        return sessionInfo(result.data)
      },
      async active() {
        const result = await legacy().session.status()
        return Object.fromEntries(
          Object.entries(result.data ?? {}).flatMap(([sessionID, status]) =>
            status.type === "idle" ? [] : [[sessionID, { type: "running" as const }]],
          ),
        )
      },
      async rename(value: { sessionID: string; title: string } & LegacyLocation) {
        await legacy(value).session.update({ sessionID: value.sessionID, title: value.title })
      },
      async archive(value: { sessionID: string } & LegacyLocation) {
        await legacy(value).session.update({
          sessionID: value.sessionID,
          directory: directory(value),
          time: { archived: Date.now() },
        })
      },
      async remove(value: Parameters<ServerApi["session"]["remove"]>[0] & LegacyLocation) {
        await legacy(value).session.delete(value)
      },
      async fork(value: Parameters<ServerApi["session"]["fork"]>[0]) {
        const result = await legacy().session.fork({ sessionID: value.sessionID, messageID: value.before })
        if (!result.data) throw new Error("Failed to fork session")
        return sessionInfo(result.data)
      },
      async interrupt(value: Parameters<ServerApi["session"]["interrupt"]>[0]) {
        await legacy().session.abort(value)
        return { interrupted: true }
      },
      async prompt(value: SessionPromptInput & LegacyPrompt) {
        await legacy().session.promptAsync({
          sessionID: value.sessionID,
          messageID: value.id ?? undefined,
          agent: value.agent,
          model: value.model,
          variant: value.variant,
          parts: value.legacyParts ?? [
            { type: "text", text: value.text },
            ...(value.files ?? []).map((file) => ({
              type: "file" as const,
              mime: file.mention ? "text/plain" : mime(file.uri),
              url: file.uri,
              filename: file.name,
              source: file.mention
                ? {
                    type: "file" as const,
                    text: { value: file.mention.text, start: file.mention.start, end: file.mention.end },
                    path: file.uri,
                  }
                : undefined,
            })),
            ...(value.agents ?? []).map((agent) => ({
              type: "agent" as const,
              name: agent.name,
              source: agent.mention
                ? { value: agent.mention.text, start: agent.mention.start, end: agent.mention.end }
                : undefined,
            })),
          ],
        })
        return {
          id: value.id ?? "",
          sessionID: value.sessionID,
          time: { created: Date.now() },
          type: "user" as const,
          payload: { text: value.text },
          delivery: value.delivery ?? "steer",
        }
      },
      async command(value: LegacyCommandInput) {
        await legacy().session.command({
          sessionID: value.sessionID,
          messageID: value.id ?? undefined,
          command: value.command,
          arguments: value.arguments ?? "",
          agent: value.agent ?? undefined,
          model: value.model ? `${value.model.providerID}/${value.model.id}` : undefined,
          variant: value.model?.variant,
          parts: value.files?.map((file) => ({
            type: "file" as const,
            mime: mime(file.uri),
            url: file.uri,
            filename: file.name,
          })),
        })
      },
      async shell(value: SessionShellInput & LegacyPrompt) {
        await legacy().session.shell({
          sessionID: value.sessionID,
          command: value.command,
          agent: value.agent,
          model: value.model,
        })
      },
      compact: async (value: SessionCompactInput & { model?: LegacyPrompt["model"] }) => {
        if (!value.model) throw new Error("A model is required to compact a V1 session")
        await legacy().session.summarize({
          sessionID: value.sessionID,
          providerID: value.model.providerID,
          modelID: value.model.modelID,
        })
        return {
          id: value.id ?? "",
          sessionID: value.sessionID,
          time: { created: Date.now() },
          type: "compaction" as const,
          payload: {},
          delivery: value.delivery ?? "steer",
        }
      },
      revert: {
        stage: async (value: Parameters<ServerApi["session"]["revert"]["stage"]>[0]) => {
          await legacy().session.revert(value)
          return { messageID: value.messageID }
        },
        clear: async (value: Parameters<ServerApi["session"]["revert"]["clear"]>[0]) => {
          await legacy().session.unrevert(value)
        },
        commit: input.current.session.revert.commit,
      },
    },
    project: {
      ...input.current.project,
      async list() {
        return ((await legacy().project.list()).data ?? []).map(
          (project): Project => ({
            id: project.id,
            canonical: project.worktree,
            vcs: project.vcs,
            name: project.name,
            icon: project.icon,
            commands: project.commands,
            time: { ...project.time, active: project.time.updated },
            sandboxes: project.sandboxes,
          }),
        )
      },
      async current(value?: { location?: LegacyLocation }) {
        const result = await legacy(value?.location).project.current()
        if (!result.data) throw new Error("Project not found")
        return { id: result.data.id, directory: result.data.worktree } satisfies ProjectCurrent
      },
      // async update(value: Parameters<ServerApi["project"]["update"]>[0]) {
      //   const project = (await legacy().project.list()).data?.find((item) => item.id === value.projectID)
      //   const result = await legacy({ directory: project?.worktree }).project.update({
      //     ...value,
      //     directory: project?.worktree,
      //   })
      //   if (!result.data) throw new Error(`Project not found: ${value.projectID}`)
      //   return result.data as Project
      // },
      async directories(value: { projectID: string; location?: LegacyLocation }) {
        const result = await legacy(value.location).worktree.list()
        return (result.data ?? []).map((item) => ({ directory: item }))
      },
      async initGit(value?: { location?: LegacyLocation }) {
        const result = await legacy(value?.location).project.initGit()
        if (!result.data) throw new Error("Failed to initialize git")
        return result.data
      },
    },
    // path: {
    //   ...input.current.path,
    //   async get(value?: Parameters<ServerApi["path"]["get"]>[0]) {
    //     const result = await legacy(value?.location).path.get()
    //     if (!result.data) throw new Error("Path unavailable")
    //     return result.data
    //   },
    // },
    vcs: {
      ...input.current.vcs,
      // async get(value?: Parameters<ServerApi["vcs"]["get"]>[0]) {
      //   const result = await legacy(value?.location).vcs.get()
      //   return located({ branch: result.data?.branch, defaultBranch: result.data?.default_branch }, value?.location)
      // },
      async status(value?: Parameters<ServerApi["vcs"]["status"]>[0]) {
        const result = await legacy(value?.location).vcs.status()
        return located(result.data ?? [], value?.location)
      },
      async diff(value: Parameters<ServerApi["vcs"]["diff"]>[0]) {
        const result = await legacy(value.location).vcs.diff({
          mode: value.mode === "working" ? "git" : value.mode === "branch" ? "branch" : unsupported("committed diff"),
          context: value.context,
        })
        return located(
          (result.data ?? []).map((file) => ({
            file: file.file,
            patch: file.patch ?? "",
            additions: file.additions,
            deletions: file.deletions,
            status: file.status ?? "modified",
          })),
          value.location,
        )
      },
    },
    file: {
      ...input.current.file,
      async nodes(value: { path: string; location?: LegacyLocation }) {
        return (await legacy(value.location).file.list({ path: value.path })).data ?? []
      },
      async content(value: { path: string; location?: LegacyLocation }) {
        const result = await legacy(value.location).file.read({ path: value.path })
        if (!result.data) throw new Error(`File not found: ${value.path}`)
        return result.data
      },
      async list(value?: Parameters<ServerApi["file"]["list"]>[0]) {
        const result = await legacy(value?.location).file.list({ path: value?.path ?? "" })
        return located(result.data ?? [], value?.location)
      },
      async find(value: Parameters<ServerApi["file"]["find"]>[0]) {
        const result = await legacy(value.location).find.files({
          query: value.query,
          dirs: value.type === undefined ? undefined : value.type === "directory" ? "true" : "false",
          limit: value.limit,
        })
        return located(
          (result.data ?? []).map((path) => ({ path, type: value.type ?? "file" })),
          value.location,
        )
      },
    },
    integration: {
      ...input.current.integration,
      async disconnect(value: { integrationID: string; location?: LegacyLocation }) {
        await legacy(value.location).auth.remove({ providerID: value.integrationID })
        await input.legacy().global.dispose()
      },
      async get(value: Parameters<ServerApi["integration"]["get"]>[0]) {
        const methods = ((await legacy(value.location).provider.auth()).data?.[value.integrationID] ?? []).map(
          (method, index) =>
            method.type === "api"
              ? { type: "key" as const, label: method.label }
              : { type: "oauth" as const, id: String(index), label: method.label, form: oauthForm(method.prompts) },
        )
        return located(
          {
            id: value.integrationID,
            name: value.integrationID,
            methods,
            connections: [],
          },
          value.location,
        )
      },
      connect: {
        ...input.current.integration.connect,
        key: async (value: Parameters<ServerApi["integration"]["connect"]["key"]>[0]) => {
          await legacy(value.location).auth.set({
            providerID: value.integrationID,
            auth: { type: "api", key: value.key },
          })
          await legacy(value.location).instance.dispose()
          await input.legacy().instance.dispose()
        },
      },
      oauth: {
        ...input.current.integration.oauth,
        connect: async (value: Parameters<ServerApi["integration"]["oauth"]["connect"]>[0]) => {
          const method = Number(value.methodID)
          const result = await legacy(value.location).provider.oauth.authorize(
            {
              providerID: value.integrationID,
              method,
              inputs:
                value.answer &&
                Object.fromEntries(Object.entries(value.answer).map(([key, item]) => [key, String(item)])),
            },
            { throwOnError: true },
          )
          if (!result.data) throw new Error("Failed to start OAuth authorization")
          return located(
            {
              attemptID: `${value.integrationID}:${method}`,
              url: result.data.url,
              instructions: result.data.instructions,
              mode: result.data.method,
              time: { created: Date.now(), expires: Date.now() + 10 * 60 * 1000 },
            },
            value.location,
          )
        },
        complete: async (value: Parameters<ServerApi["integration"]["oauth"]["complete"]>[0]) => {
          const method = Number(value.attemptID.split(":").at(-1))
          await legacy(value.location).provider.oauth.callback(
            { providerID: value.integrationID, method, code: value.code },
            { throwOnError: true },
          )
          await legacy(value.location).instance.dispose()
          await input.legacy().instance.dispose()
        },
        status: async (value: Parameters<ServerApi["integration"]["oauth"]["status"]>[0]) => {
          const method = Number(value.attemptID.split(":").at(-1))
          await legacy(value.location).provider.oauth.callback(
            { providerID: value.integrationID, method },
            { throwOnError: true },
          )
          await legacy(value.location).instance.dispose()
          await input.legacy().instance.dispose()
          return located(
            { status: "complete" as const, time: { created: Date.now(), expires: Date.now() } },
            value.location,
          )
        },
      },
    },
    pty: {
      ...input.current.pty,
      // async shells(value?: Parameters<ServerApi["pty"]["shells"]>[0]) {
      //   return located((await legacy(value?.location).pty.shells()).data ?? [], value?.location)
      // },
      async list(value?: Parameters<ServerApi["pty"]["list"]>[0]) {
        return located((await legacy(value?.location).pty.list()).data ?? [], value?.location)
      },
      async create(value?: Parameters<ServerApi["pty"]["create"]>[0]) {
        const result = await legacy(value?.location).pty.create({
          command: value?.command,
          args: value?.args ? [...value.args] : undefined,
          cwd: value?.cwd,
          title: value?.title,
          env: value?.env,
        })
        if (!result.data) throw new Error("Failed to create terminal")
        return located(result.data, value?.location)
      },
      async get(value: Parameters<ServerApi["pty"]["get"]>[0]) {
        const result = await legacy(value.location).pty.get({ ptyID: value.ptyID })
        if (!result.data) throw new Error(`Terminal not found: ${value.ptyID}`)
        return located(result.data, value.location)
      },
      async update(value: Parameters<ServerApi["pty"]["update"]>[0]) {
        const result = await legacy(value.location).pty.update({
          ptyID: value.ptyID,
          title: value.title,
          size: value.size,
        })
        if (!result.data) throw new Error(`Terminal not found: ${value.ptyID}`)
        return located(result.data, value.location)
      },
      async remove(value: Parameters<ServerApi["pty"]["remove"]>[0]) {
        await legacy(value.location).pty.remove({ ptyID: value.ptyID })
      },
      // async connectToken(value: Parameters<ServerApi["pty"]["connectToken"]>[0]) {
      //   const result = await legacy(value.location).pty.connectToken({ ptyID: value.ptyID })
      //   if (!result.data) throw new Error(`Failed to connect terminal: ${value.ptyID}`)
      //   return located(result.data, value.location)
      // },
    },
    permission: {
      ...input.current.permission,
      async reply(value: Parameters<ServerApi["permission"]["reply"]>[0] & { location?: { directory?: string } }) {
        await legacy(value.location).permission.respond({
          sessionID: value.sessionID,
          permissionID: value.requestID,
          response: value.decision,
          directory: directory(value.location),
        })
      },
    },
    question: {
      request: {
        list: async (value) => ({ data: (await legacy(value?.location).question.list()).data ?? [] }),
      },
      async reply(value) {
        await legacy().question.reply({
          requestID: value.requestID,
          answers: value.answers.map((answer) => [...answer]),
        })
      },
      async reject(value) {
        await legacy().question.reject({ requestID: value.requestID })
      },
    },
  }
}

// 2.2.5 lists paths relative to the Location root, with a trailing separator on directories.
export function fileNode(root: string, entry: { path: string; type: "file" | "directory" }): FileNode {
  const path = entry.path.replace(/[\\/]+$/, "")
  const separator = root.includes("\\") && !root.includes("/") ? "\\" : "/"
  return {
    name: path.split(/[\\/]/).at(-1) ?? path,
    path,
    absolute: root.replace(/[\\/]+$/, "") + separator + path,
    type: entry.type,
    // shortcut: 2.2.5 does not report ignore status, so ignored paths render like tracked ones.
    ignored: false,
  }
}

const mediaMime: Record<string, string> = {
  jpg: "image/jpeg",
  svg: "image/svg+xml",
  ico: "image/x-icon",
  tif: "image/tiff",
  mp3: "audio/mpeg",
  m4a: "audio/mp4",
  opus: "audio/ogg",
}

// 2.2.5 returns raw bytes; viewers expect V1 text, or base64 plus a mime type for media.
export function fileContent(path: string, bytes: Uint8Array): FileContent {
  const kind = mediaKindFromPath(path)
  const ext = fileExtension(path)
  if (kind && kind !== "svg") {
    let binary = ""
    for (let index = 0; index < bytes.length; index += 0x8000)
      binary += String.fromCharCode(...bytes.subarray(index, index + 0x8000))
    return { type: "binary", content: btoa(binary), encoding: "base64", mimeType: mediaMime[ext] ?? `${kind}/${ext}` }
  }
  try {
    const text = new TextDecoder("utf-8", { fatal: true }).decode(bytes)
    if (!text.includes("\u0000")) return { type: "text", content: text, mimeType: kind ? mediaMime.svg : undefined }
  } catch {}
  return { type: "binary", content: "" }
}

function unsupported(feature: string): never {
  throw new Error(`The V1 server does not support ${feature}`)
}

type LegacyAuthPrompts = ProviderAuthMethod["prompts"]

// V1 OAuth prompts become the 2.2.5 Form fields the connect dialog renders: text fields, or option lists for selects.
function oauthForm(prompts: LegacyAuthPrompts): FormFields | undefined {
  const fields = (prompts ?? []).map(
    (prompt): FormField => ({
      type: "string",
      key: prompt.key,
      title: prompt.message,
      ...(prompt.type === "text"
        ? { placeholder: prompt.placeholder }
        : {
            options: prompt.options.map((option) => ({
              value: option.value,
              label: option.label,
              description: option.hint,
            })),
          }),
      ...(prompt.when ? { when: [prompt.when] } : {}),
    }),
  )
  const [first, ...rest] = fields
  return first ? [first, ...rest] : undefined
}
