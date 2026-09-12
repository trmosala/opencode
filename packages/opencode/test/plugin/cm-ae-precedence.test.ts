import { afterEach, expect } from "bun:test"
import assert from "node:assert/strict"
import { isAbsolute, join, resolve } from "node:path"
import { pathToFileURL } from "node:url"
import { Effect, Layer } from "effect"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { httpClient } from "@opencode-ai/core/effect/app-node-platform"
import { HttpClient } from "effect/unstable/http"
import { CrossSpawnSpawner } from "@opencode-ai/core/cross-spawn-spawner"
import { FSUtil } from "@opencode-ai/core/fs-util"
import { Npm } from "@opencode-ai/core/npm"
import { Config } from "../../src/config/config"
import { Plugin } from "../../src/plugin"
import { Permission } from "../../src/permission"
import { RuntimeFlags } from "../../src/effect/runtime-flags"
import { Auth } from "../../src/auth"
import { Account } from "../../src/account/account"
import { AuthTest } from "../fake/auth"
import { AccountTest } from "../fake/account"
import { NpmTest } from "../fake/npm"
import { disposeAllInstances, TestInstance } from "../fixture/fixture"
import { testEffect } from "../lib/effect"
import { o1CodeConfigContent } from "../../../desktop/src/main/wpp-bridge/proxy/providerConfig.mjs"

// Explicit external input: current AE source or a refreshed bundle, never a developer path in production.
const entry = process.env.CM_AE_TEST_ENTRY
if (entry && !isAbsolute(entry)) throw new Error("CM_AE_TEST_ENTRY must be an absolute plugin.mjs path")
const it = testEffect(
  LayerNode.compile(LayerNode.group([Plugin.node, Config.node, FSUtil.node, CrossSpawnSpawner.node]), [
    [Auth.node, AuthTest.empty],
    [Account.node, AccountTest.empty],
    [Npm.node, NpmTest.noop],
    [RuntimeFlags.node, RuntimeFlags.layer({ disableDefaultPlugins: true })],
    [
      httpClient,
      Layer.succeed(
        HttpClient.HttpClient,
        HttpClient.make(() => Effect.die("Unexpected HTTP")),
      ),
    ],
  ]),
)
afterEach(disposeAllInstances)

// Opt-in artifact smoke: configs and versions come from a paused Electron app.getVersion() probe.
const smoke = process.env.CM_AE_SMOKE_SCENARIOS
if (smoke) {
  const scenarios = await Bun.file(smoke).json()
  const { EventEmitter } = await import("node:events")
  const parent = new EventEmitter()
  const previous = Object.getOwnPropertyDescriptor(process, "parentPort")
  const port = {
    configurable: true,
    value: Object.assign(parent, {
      postMessage(message: { type: string; id: string; sessionID: string; request: { op: string } }) {
        assert.equal(message.type, "browser_request")
        assert.equal(message.sessionID, "artifact-smoke")
        assert.equal(message.request.op, "read_state")
        queueMicrotask(() =>
          parent.emit("message", {
            data: {
              type: "browser_result",
              id: message.id,
              response: {
                ok: true,
                result: {
                  url: "http://127.0.0.1/cj1-smoke",
                  title: "Controlled Browser IPC",
                  visibleText: "local transport success",
                  elements: [],
                },
              },
            },
          }),
        )
      },
    }),
  }
  for (const scenario of scenarios) {
    it.instance(
      `desktop artifact smoke: ${scenario.name}`,
      () =>
        Effect.gen(function* () {
          const { directory } = yield* TestInstance
          yield* Effect.acquireRelease(
            Effect.sync(() => Object.defineProperty(process, "parentPort", port)),
            () =>
              Effect.sync(() => {
                if (previous) Object.defineProperty(process, "parentPort", previous)
                else Reflect.deleteProperty(process, "parentPort")
              }),
          )
          const content = structuredClone(scenario.config)
          for (const plugin of content.plugin) {
            if (Array.isArray(plugin)) plugin[1].dataDir = join(directory, "ae-data")
          }
          yield* Effect.acquireRelease(
            Effect.sync(() => {
              const value = process.env.OPENCODE_CONFIG_CONTENT
              process.env.OPENCODE_CONFIG_CONTENT = JSON.stringify(content)
              return value
            }),
            (value) =>
              Effect.sync(() => {
                if (value === undefined) delete process.env.OPENCODE_CONFIG_CONTENT
                else process.env.OPENCODE_CONFIG_CONTENT = value
              }),
          )
          const plugins = yield* Plugin.Service
          const hooks = yield* plugins.list()
          const tools = Object.assign({}, ...hooks.map((hook) => hook.tool))
          const browser = Object.keys(tools).filter((name) => name.startsWith("browser_"))
          const ae = Object.keys(tools).filter((name) => name.startsWith("ae_"))
          expect(browser.length).toBe(5)
          yield* Effect.promise(async () => {
            const plugin = content.plugin.find((item: unknown) => Array.isArray(item))
            const expected = plugin ? Object.keys(await Bun.file(new URL("./permissions.json", plugin[0])).json()) : []
            assert.deepEqual(ae.sort(), expected.sort())
            const result = await tools.browser_read_state.execute(
              {},
              {
                sessionID: "artifact-smoke",
                ask: async (request: { permission: string }) => assert.equal(request.permission, "browser_read_state"),
              },
            )
            assert.match(result.output, /local transport success/)
            if (scenario.expectedVersion) {
              const result = JSON.parse(
                await tools.ae_connections.execute({ includeCompatibility: true }, { sessionID: "artifact-smoke" }),
              )
              assert.deepEqual(result.connections, [])
              assert.equal(result.compatibility.cookieMonsterVersion, scenario.expectedVersion)
              assert.equal(result.compatibility.cookieMonsterVersionStatus, "configured")
              for (const entry of Object.values(result.compatibility.updates)) {
                assert.deepEqual(entry, { status: "not_configured", version: null, protocol: null, url: null })
              }
            } else assert.match(scenario.warnings[0], /installed bundle (absent|invalid); AE integration omitted/)
            console.log(
              JSON.stringify({
                scenario: scenario.name,
                loader: "Config.node + Plugin.node",
                browserTools: browser.length,
                aeTools: ae.length,
                browserIPC: "controlled-success",
                desktopVersion: scenario.expectedVersion ?? null,
                diagnostics: scenario.warnings.length,
              }),
            )
          })
        }),
      { timeout: 30_000 },
    )
  }
}

const cases: { name: string; config: object; action: "ask" | "deny" | "allow"; unsafe?: boolean }[] = [
  { name: "default ask", config: {}, action: "ask" },
  { name: "exact deny", config: { permission: { ae_bind: "deny", ae_execute: "deny" } }, action: "deny" },
  { name: "wildcard deny", config: { permission: { "ae_*": "deny" } }, action: "deny" },
  { name: "global deny", config: { permission: "deny" }, action: "deny" },
  { name: "global ask", config: { permission: "ask" }, action: "ask" },
  { name: "exact autoallow", config: { permission: { ae_bind: "allow" } }, action: "allow", unsafe: true },
  { name: "wildcard autoallow", config: { permission: { "ae_*": "allow" } }, action: "allow", unsafe: true },
  { name: "global autoallow", config: { permission: "allow" }, action: "allow", unsafe: true },
  { name: "agent deny", config: { agent: { reviewer: { permission: { "ae_*": "deny" } } } }, action: "deny" },
  { name: "agent ask", config: { agent: { reviewer: { permission: "ask" } } }, action: "ask" },
  {
    name: "agent autoallow",
    config: { agent: { reviewer: { permission: { "ae_*": "allow" } } } },
    action: "allow",
    unsafe: true,
  },
  {
    name: "agent global autoallow",
    config: { agent: { reviewer: { permission: "allow" } } },
    action: "allow",
    unsafe: true,
  },
]

const instance = entry ? it.instance : it.instance.skip
for (const scenario of cases) {
  instance(
    `desktop AE precedence: ${scenario.name}`,
    () =>
      Effect.gen(function* () {
        const { directory } = yield* TestInstance
        const fs = yield* FSUtil.Service
        const wrapper = join(directory, "ae-test.mjs")
        // Real server/config/tool hooks; only external I/O is replaced. Binding reaches the real approval guard.
        yield* fs.writeWithDirs(
          wrapper,
          `
import plugin from ${JSON.stringify(pathToFileURL(entry!).href)}
export default {
  id: "cm-ae",
  server(input, options) {
    return plugin.server(input, {
      ...options,
      factories: {
        bridge: async () => ({
          dataDir: ${JSON.stringify(directory)},
          connections: async () => [{ connectionId: "test", connected: true, project: { saved: false, path: "" } }],
          bind() { throw new Error("Must not bind") },
          release() {}, close() {}, onRelease() {}, setPanelHandler() {}, setChatHandler() {},
        }),
        renderer: async () => ({ list: async () => [], close() {} }),
      },
    })
  },
}
`,
        )
        yield* fs.writeWithDirs(join(directory, "opencode.json"), JSON.stringify(scenario.config))
        const browser = pathToFileURL(resolve(import.meta.dir, "../../../cm-browser/src/plugin.ts")).href
        const content = o1CodeConfigContent(browser, [
          pathToFileURL(wrapper).href,
          { releaseMetadata: { cookieMonsterVersion: "1.18.27" } },
        ])
        yield* Effect.acquireRelease(
          Effect.sync(() => {
            const previous = process.env.OPENCODE_CONFIG_CONTENT
            process.env.OPENCODE_CONFIG_CONTENT = content
            return previous
          }),
          (previous) =>
            Effect.sync(() => {
              if (previous === undefined) delete process.env.OPENCODE_CONFIG_CONTENT
              else process.env.OPENCODE_CONFIG_CONTENT = previous
            }),
        )
        const config = yield* Config.Service
        const merged = yield* config.get()
        // This is the P1 regression: file denies must survive the actual env-last merge, before hooks.
        if (scenario.name === "exact deny") {
          expect(merged.permission?.ae_execute).toBe("deny")
          expect(merged.permission?.ae_bind).toBe("deny")
        }
        const plugins = yield* Plugin.Service
        const hooks = yield* plugins.list()
        const tools = Object.assign({}, ...hooks.map((hook) => hook.tool))
        expect(typeof tools.browser_read_state?.execute).toBe("function")
        expect(typeof tools.ae_bind?.execute).toBe("function")
        const rules = Permission.fromConfig(merged.permission ?? {})
        const agentRules = Permission.fromConfig(merged.agent?.reviewer?.permission ?? {})
        expect(Permission.evaluate("ae_bind", "*", rules, agentRules).action).toBe(scenario.action)
        expect(Permission.evaluate("browser_read_state", "*", rules).action).toBe("allow")
        expect(Permission.evaluate("browser_click", "*", rules).action).toBe("ask")
        expect(tools.ae_raw_execute).toBeUndefined()
        if (scenario.name === "default ask") expect(merged.permission?.ae_execute).toBe("allow")
        if (scenario.name === "exact deny") expect(merged.permission?.ae_execute).toBe("deny")

        expect(Permission.visibleTools(tools, Permission.merge(rules, agentRules)).ae_bind === undefined).toBe(
          scenario.action === "deny",
        )
        yield* Effect.promise(async () => {
          // Agent denies are enforced by OpenCode's tool filter; AE rejects unsafe autoallow config itself.
          if (scenario.name !== "agent deny") {
            const refusal = scenario.unsafe
              ? "permission_policy_required"
              : scenario.action === "deny"
                ? "permission_denied"
                : "test_approval"
            await assert.rejects(
              tools.ae_bind.execute(
                { connectionId: "test" },
                {
                  sessionID: "precedence",
                  abort: new AbortController().signal,
                  ask: async () => {
                    throw Object.assign(new Error("Approval cancelled"), { code: "test_approval" })
                  },
                },
              ),
              { code: refusal },
            )
          }
          await assert.rejects(
            tools.browser_read_state.execute(
              {},
              {
                sessionID: "precedence",
                ask: async (request: { permission: string; patterns: string[] }) => {
                  expect(request.permission).toBe("browser_read_state")
                  expect(Permission.evaluate(request.permission, request.patterns[0], rules).action).toBe("allow")
                },
              },
            ),
            /unavailable/i,
          )
        })
      }),
    { timeout: 30_000 },
  )
}
