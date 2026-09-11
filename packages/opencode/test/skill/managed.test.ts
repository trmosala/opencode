import { describe, expect, test } from "bun:test"
import path from "node:path"
import fs from "node:fs/promises"
import { Effect, Layer } from "effect"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { CrossSpawnSpawner } from "@opencode-ai/core/cross-spawn-spawner"
import { ManagedSkill } from "../../src/skill/managed"
import { Skill } from "../../src/skill"
import { Global } from "@opencode-ai/core/global"
import { TestInstance, tmpdir, provideTmpdirInstance, testInstanceStoreLayer } from "../fixture/fixture"
import { testEffect } from "../lib/effect"

const draft: ManagedSkill.Draft = {
  name: "brand-motion",
  description: "Brand title motion",
  instructions: "Use a short ease out.\nKeep the logo fixed.",
  scope: "workspace",
}
const it = testEffect(
  Layer.mergeAll(LayerNode.compile(Skill.node), LayerNode.compile(CrossSpawnSpawner.node), testInstanceStoreLayer),
)

const globalIt = testEffect(
  Layer.mergeAll(
    LayerNode.compile(Skill.node, [
      [
        Global.node,
        Layer.effect(
          Global.Service,
          Effect.gen(function* () {
            const dir = yield* Effect.acquireRelease(
              Effect.promise(() => tmpdir()),
              (dir) => Effect.promise(() => dir[Symbol.asyncDispose]()),
            )
            return Global.make({ config: path.join(dir.path, "global-config") })
          }),
        ),
      ],
    ]),
    LayerNode.compile(CrossSpawnSpawner.node),
    testInstanceStoreLayer,
  ),
)

describe("managed skills", () => {
  globalIt.instance("global save uses the configured root and is visible across workspaces", () =>
    Effect.gen(function* () {
      const service = yield* Skill.Service
      const globalDraft = { ...draft, scope: "global" as const }
      const review = yield* service.review(globalDraft)
      expect(review.destination).toContain(path.join("global-config", "skills", draft.name, "SKILL.md"))
      const receipt = yield* service.create({ ...globalDraft, token: review.token })
      yield* provideTmpdirInstance(
        () =>
          Effect.gen(function* () {
            expect((yield* service.catalog()).find((s) => s.name === draft.name)?.source).toBe(receipt.source)
            expect((yield* service.resolve(receipt)).content.trim()).toBe(draft.instructions)
          }),
        { git: true },
      )
    }),
  )

  it.instance("same-name substitution and duplicate definitions cannot satisfy a selection", () =>
    Effect.gen(function* () {
      const service = yield* Skill.Service
      const dir = (yield* TestInstance).directory
      const review = yield* service.review(draft)
      const receipt = yield* service.create({ ...draft, token: review.token })
      const other = path.join(dir, ".opencode", "skill", "other", "SKILL.md")
      yield* Effect.promise(() => Bun.write(other, ManagedSkill.validate(draft)))
      expect(yield* service.resolve(receipt).pipe(Effect.flip)).toBeInstanceOf(ManagedSkill.Error)
      yield* Effect.promise(() => fs.unlink(receipt.destination))
      expect(yield* service.resolve(receipt).pipe(Effect.flip)).toBeInstanceOf(ManagedSkill.Error)
      const replacement = (yield* service.catalog()).find((s) => s.name === draft.name)
      expect(replacement?.source).not.toBe(receipt.source)
    }),
  )

  for (const kind of ["file", "junction"] as const) {
    it.instance(`linked ${kind} skills remain available and retargeting invalidates selection`, () =>
      Effect.gen(function* () {
        const service = yield* Skill.Service
        const dir = (yield* TestInstance).directory
        const first = path.join(dir, "first")
        const second = path.join(dir, "second")
        const root = path.join(dir, ".opencode", "skills")
        const link = path.join(root, "linked")
        yield* Effect.promise(async () => {
          await fs.mkdir(first)
          await fs.mkdir(second)
          await fs.mkdir(root, { recursive: true })
          await fs.writeFile(path.join(first, "SKILL.md"), ManagedSkill.validate(draft))
          await fs.writeFile(path.join(second, "SKILL.md"), ManagedSkill.validate(draft))
          if (kind === "file") {
            await fs.mkdir(link)
            await fs.symlink(path.join(first, "SKILL.md"), path.join(link, "SKILL.md"), "file")
          } else {
            await fs.symlink(first, link, "junction")
          }
        })
        const selected = (yield* service.catalog()).find((item) => item.name === draft.name)
        expect(selected).toBeDefined()
        if (!selected) throw new Error("Linked skill missing")
        expect((yield* service.require(draft.name)).content.trim()).toBe(draft.instructions)
        expect((yield* service.available()).some((item) => item.name === draft.name)).toBe(true)
        expect((yield* service.resolve(selected)).location).toBe(path.join(first, "SKILL.md"))
        yield* Effect.promise(async () => {
          if (kind === "file") {
            await fs.unlink(path.join(link, "SKILL.md"))
            await fs.symlink(path.join(second, "SKILL.md"), path.join(link, "SKILL.md"), "file")
          } else {
            await fs.unlink(link)
            await fs.symlink(second, link, "junction")
          }
        })
        expect(yield* service.resolve(selected).pipe(Effect.flip)).toBeInstanceOf(ManagedSkill.Error)
        const next = (yield* service.catalog()).find((item) => item.name === draft.name)
        expect(next?.source).not.toBe(selected.source)
        expect(next?.revision).toBe(selected.revision)
      }),
    )
  }

  it.instance("disk customize-opencode overrides fallback but duplicate disk definitions are rejected", () =>
    Effect.gen(function* () {
      const service = yield* Skill.Service
      const dir = (yield* TestInstance).directory
      const override = { ...draft, name: "customize-opencode" }
      const fallback = (yield* service.catalog()).filter((item) => item.name === override.name)
      expect(fallback).toHaveLength(1)
      expect((yield* service.resolve(fallback[0])).location).toBe("<built-in>")
      const location = path.join(dir, ".opencode", "skills", override.name, "SKILL.md")
      yield* Effect.promise(() => Bun.write(location, ManagedSkill.validate(override)))
      const entries = (yield* service.catalog()).filter((item) => item.name === override.name)
      expect(entries).toHaveLength(1)
      expect((yield* service.resolve(entries[0])).content.trim()).toBe(draft.instructions)
      expect(yield* service.resolve(fallback[0]).pipe(Effect.flip)).toBeInstanceOf(ManagedSkill.Error)
      yield* Effect.promise(() =>
        Bun.write(path.join(dir, ".opencode", "skill", "duplicate", "SKILL.md"), ManagedSkill.validate(override)),
      )
      expect((yield* service.catalog()).filter((item) => item.name === override.name)).toHaveLength(2)
      expect(yield* service.resolve(entries[0]).pipe(Effect.flip)).toBeInstanceOf(ManagedSkill.Error)
    }),
  )

  test("validates portable names and bounded reviewed fields", () => {
    for (const name of ["../escape", "CON", "con", "lpt1", "aux", "name.", "a/b", "a\\b", "a--b", "a".repeat(65)])
      expect(() => ManagedSkill.validate({ ...draft, name })).toThrow()
    expect(() => ManagedSkill.validate({ ...draft, instructions: "" })).toThrow()
    expect(() => ManagedSkill.validate({ ...draft, instructions: "x".repeat(64001) })).toThrow()
    expect(() => ManagedSkill.validate({ ...draft, description: "a\nb" })).toThrow()
    expect(() => ManagedSkill.validate({ ...draft, description: "x".repeat(1025) })).toThrow()
  })

  test("writes standard markdown exclusively and refuses junctions and collisions", async () => {
    await using dir = await tmpdir()
    const root = path.join(dir.path, "skills")
    const info = await ManagedSkill.create(root, draft)
    expect(info.content.trim()).toBe(draft.instructions)
    const bytes = await fs.readFile(info.location, "utf8")
    await expect(ManagedSkill.create(root, { ...draft, instructions: "overwrite" })).rejects.toThrow()
    expect(await fs.readFile(info.location, "utf8")).toBe(bytes)
    await fs.mkdir(path.join(dir.path, "other"))
    await fs.symlink(path.join(dir.path, "other"), path.join(dir.path, "linked"), "junction")
    await expect(ManagedSkill.create(path.join(dir.path, "linked"), draft)).rejects.toThrow()
    expect(await fs.readdir(path.join(dir.path, "other"))).toEqual([])
  })

  it.instance("save is reviewed, one-shot, fresh without disposal and revision pinned", () =>
    Effect.gen(function* () {
      const service = yield* Skill.Service
      const dir = (yield* TestInstance).directory
      yield* service.all()
      expect((yield* service.catalog()).some((s) => s.name === draft.name)).toBe(false)
      const review = yield* service.review(draft)
      expect(review.destination).toBe(path.join(dir, ".opencode", "skills", draft.name, "SKILL.md"))
      expect(
        yield* Effect.promise(() =>
          fs.stat(review.destination).then(
            () => true,
            () => false,
          ),
        ),
      ).toBe(false)
      const receipt = yield* service.create({ ...draft, token: review.token })
      expect(receipt.digest).toBe(review.digest)
      expect((yield* service.require(draft.name)).content.trim()).toBe(draft.instructions)
      expect((yield* service.catalog()).find((s) => s.name === draft.name)).toMatchObject({
        source: receipt.source,
        revision: receipt.revision,
      })
      expect(yield* service.create({ ...draft, token: review.token }).pipe(Effect.flip)).toBeInstanceOf(
        ManagedSkill.Error,
      )
      expect(yield* service.review(draft).pipe(Effect.flip)).toBeInstanceOf(ManagedSkill.Error)
      yield* Effect.promise(() =>
        fs.writeFile(receipt.destination, ManagedSkill.validate({ ...draft, instructions: "Changed" })),
      )
      expect(yield* service.resolve(receipt).pipe(Effect.flip)).toBeInstanceOf(ManagedSkill.Error)
      yield* Effect.promise(() => fs.unlink(receipt.destination))
      expect((yield* service.catalog()).some((s) => s.name === draft.name)).toBe(false)
      expect(yield* service.require(draft.name).pipe(Effect.flip)).toBeInstanceOf(Skill.NotFoundError)
    }),
  )

  it.instance("review cannot authorize different instructions or a different workspace", () =>
    Effect.gen(function* () {
      const service = yield* Skill.Service
      const review = yield* service.review(draft)
      expect(
        yield* service.create({ ...draft, token: review.token, instructions: "Different" }).pipe(Effect.flip),
      ).toBeInstanceOf(ManagedSkill.Error)
      const next = yield* service.review(draft)
      yield* provideTmpdirInstance(
        () =>
          Effect.gen(function* () {
            expect(yield* service.create({ ...draft, token: next.token }).pipe(Effect.flip)).toBeInstanceOf(
              ManagedSkill.Error,
            )
          }),
        { git: true },
      )
    }),
  )

  it.instance("workspace techniques do not appear in an unrelated git workspace", () =>
    Effect.gen(function* () {
      const service = yield* Skill.Service
      const review = yield* service.review(draft)
      const receipt = yield* service.create({ ...draft, token: review.token })
      yield* provideTmpdirInstance(
        () =>
          Effect.gen(function* () {
            expect((yield* service.catalog()).some((s) => s.name === draft.name)).toBe(false)
            expect(yield* service.resolve(receipt).pipe(Effect.flip)).toBeInstanceOf(ManagedSkill.Error)
          }),
        { git: true },
      )
    }),
  )
})
