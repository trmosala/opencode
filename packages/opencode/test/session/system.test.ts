import { describe, expect, test } from "bun:test"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { Effect, Layer } from "effect"
import type { Agent } from "../../src/agent/agent"
import { NamedError } from "@opencode-ai/core/util/error"
import { Skill } from "../../src/skill"
import { Permission } from "../../src/permission"
import type { Provider } from "../../src/provider/provider"
import { SystemPrompt } from "../../src/session/system"
import PROMPT_GPT from "../../src/session/prompt/gpt.txt"
import PROMPT_ASTRA from "../../src/session/prompt/gpt-astra.txt"
import PROMPT_CODEX from "../../src/session/prompt/codex.txt"
import { MCP } from "../../src/mcp"
import { testEffect } from "../lib/effect"

const skills: Skill.Info[] = [
  {
    name: "zeta-skill",
    description: "Zeta skill.",
    location: "/tmp/zeta-skill/SKILL.md",
    content: "# zeta-skill",
  },
  {
    name: "alpha-skill",
    description: "Alpha skill.",
    location: "/tmp/alpha-skill/SKILL.md",
    content: "# alpha-skill",
  },
  {
    name: "middle-skill",
    description: "Middle skill.",
    location: "/tmp/middle-skill/SKILL.md",
    content: "# middle-skill",
  },
  {
    name: "manual-skill",
    location: "/tmp/manual-skill/SKILL.md",
    content: "# manual-skill",
  },
]

const build: Agent.Info = {
  name: "build",
  mode: "primary",
  permission: Permission.fromConfig({ "*": "allow" }),
  options: {},
}

const it = testEffect(
  LayerNode.compile(SystemPrompt.node, [
    [
      MCP.node,
      Layer.mock(MCP.Service, {
        instructions: () =>
          Effect.succeed([
            {
              name: "guide-server",
              instructions: "Use lookup before mutate.",
              tools: [],
            },
            {
              name: "tool-server",
              instructions: "Prefer search before update.",
              tools: ["tool-server_search", "tool-server_update"],
            },
          ]),
      }),
    ],
    [
      Skill.node,
      Layer.mock(Skill.Service, {
        get: (name) => Effect.succeed(skills.find((skill) => skill.name === name)),
        require: (name) => {
          const info = skills.find((skill) => skill.name === name)
          if (info) return Effect.succeed(info)
          return Effect.fail(new Skill.NotFoundError({ name, available: skills.map((skill) => skill.name) }))
        },
        all: () => Effect.succeed(skills),
        dirs: () => Effect.succeed([]),
        available: () => Effect.succeed(skills),
      }),
    ],
  ]),
)

describe("session.system", () => {
  test("selects the Meta prompt for Muse Spark model IDs", () => {
    for (const id of ["meta/muse-spark-preview", "muse-spark-1.1", "muse-spark-1.2"]) {
      const prompt = SystemPrompt.provider({ api: { id } } as Provider.Model)[0]
      expect(prompt).toContain("powered by Muse Spark,")
      expect(prompt).toContain("using Meta Muse Spark.")
      expect(prompt).not.toContain("{{MODEL_NAME}}")
    }
  })

  test("selects the Meta prompt for Muse Glimmer model IDs", () => {
    for (const id of ["meta/muse-glimmer", "meta/muse-glimmer-30b", "muse-glimmer-30b"]) {
      const prompt = SystemPrompt.provider({ api: { id } } as Provider.Model)[0]
      expect(prompt).toContain("powered by Muse Glimmer,")
      expect(prompt).toContain("using Meta Muse Glimmer.")
      expect(prompt).not.toContain("{{MODEL_NAME}}")
    }
  })

  test("selects the Kimi prompt for official provider model IDs", () => {
    for (const providerID of ["kimi-for-coding", "moonshotai", "moonshotai-cn"]) {
      const prompt = SystemPrompt.provider({ providerID, api: { id: "k3" } } as Provider.Model)[0]
      expect(prompt).toContain("# Prompt and Tool Use")
    }
  })

  test("selects upstream GPT-6 prompts by model ID or family without changing older Codex routing", () => {
    for (const model of [
      { api: { id: "gpt-6" } },
      { api: { id: "gpt-6-codex" } },
      { api: { id: "custom-model" }, family: "GPT-6" },
    ]) {
      expect(SystemPrompt.provider(model as Provider.Model)).toEqual([PROMPT_ASTRA])
    }
    expect(SystemPrompt.provider({ api: { id: "gpt-5-codex" } } as Provider.Model)).toEqual([PROMPT_CODEX])
  })

  test("preserves CookieMonster GPT-6 prompt routing", () => {
    for (const id of ["CM_GPT6_Astra_High", "CM_GPT-6 Sol - High"]) {
      expect(
        SystemPrompt.provider({ providerID: "cookiemonster", family: "gpt-6", api: { id } } as Provider.Model),
      ).toEqual([PROMPT_GPT])
    }
  })

  test("uses model-family prompts for CookieMonster models", () => {
    const gpt = SystemPrompt.provider({
      api: { id: "CM_GPT-5.6 Sol - High" },
      family: "gpt-5",
      providerID: "cookiemonster",
    } as Provider.Model)
    const opus = SystemPrompt.provider({
      api: { id: "CM_Opus 5 - Extra High" },
      family: "claude",
      providerID: "cookiemonster",
    } as Provider.Model)

    expect(gpt).not.toEqual(opus)
    expect(gpt[0]).toContain("deeply pragmatic, effective software engineer")
    expect(gpt[0]).toContain("same assistant response")
    expect(opus[0]).toContain("TodoWrite tools")
  })

  it.effect("skills output is sorted by name and stable across calls", () =>
    Effect.gen(function* () {
      const prompt = yield* SystemPrompt.Service
      const first = yield* prompt.skills(build)
      const second = yield* prompt.skills(build)
      const output = first ?? (yield* Effect.fail(new NamedError.Unknown({ message: "missing skills output" })))

      expect(first).toBe(second)

      const alpha = output.indexOf("<name>alpha-skill</name>")
      const middle = output.indexOf("<name>middle-skill</name>")
      const zeta = output.indexOf("<name>zeta-skill</name>")

      expect(alpha).toBeGreaterThan(-1)
      expect(middle).toBeGreaterThan(alpha)
      expect(zeta).toBeGreaterThan(middle)
      expect(output).not.toContain("manual-skill")
    }),
  )

  it.effect("MCP output includes connected server instructions", () =>
    Effect.gen(function* () {
      const prompt = yield* SystemPrompt.Service
      const output = yield* prompt.mcp(build)

      expect(output).toBe(
        [
          "<mcp_instructions>",
          '  <server name="guide-server">',
          "    Use lookup before mutate.",
          "  </server>",
          '  <server name="tool-server">',
          "    Prefer search before update.",
          "  </server>",
          "</mcp_instructions>",
        ].join("\n"),
      )
    }),
  )

  it.effect("MCP output omits servers when all advertised tools are denied", () =>
    Effect.gen(function* () {
      const prompt = yield* SystemPrompt.Service
      const output = yield* prompt.mcp(build, Permission.fromConfig({ "tool-server_*": "deny" }))

      expect(output).toBe(
        [
          "<mcp_instructions>",
          '  <server name="guide-server">',
          "    Use lookup before mutate.",
          "  </server>",
          "</mcp_instructions>",
        ].join("\n"),
      )
    }),
  )
})
