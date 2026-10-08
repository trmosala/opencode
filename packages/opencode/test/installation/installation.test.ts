import { describe, expect } from "bun:test"
import { Effect } from "effect"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { InstallationVersion } from "@opencode-ai/core/installation/version"
import { Installation } from "../../src/installation"
import { testEffect } from "../lib/effect"

const it = testEffect(LayerNode.compile(Installation.node))
const methods: Installation.Method[] = ["curl", "npm", "yarn", "pnpm", "bun", "brew", "scoop", "choco", "unknown"]

describe("CookieMonster installation", () => {
  it.effect("reports the bundled version without checking an upstream feed", () =>
    Effect.gen(function* () {
      const service = yield* Installation.Service
      expect(yield* service.info()).toEqual({ version: InstallationVersion, latest: InstallationVersion })
      expect(yield* service.method()).toBe("unknown")
      expect(yield* service.latest()).toBe(InstallationVersion)
    }),
  )

  methods.forEach((method) => {
    it.effect(`does not check upstream versions or install via ${method}`, () =>
      Effect.gen(function* () {
        const service = yield* Installation.Service
        expect(yield* service.latest(method)).toBe(InstallationVersion)
        const error = yield* Effect.flip(service.upgrade(method, "9.9.9"))
        expect(error).toBeInstanceOf(Installation.UpgradeFailedError)
        expect(error.stderr).toContain("CookieMonster's desktop updater")
        expect(error.stderr).toContain("https://github.com/trmosala/opencode/releases/latest")
      }),
    )
  })
})
