import { describe, expect, test } from "bun:test"
import { createExtensionClient } from "./cm-extensions"

const server = { url: "http://localhost:4096/", username: "opencode", password: "secret" }

describe("createExtensionClient skills", () => {
  test("reads the catalog for one workspace with sidecar auth", async () => {
    const requests: Request[] = []
    const client = createExtensionClient(server, async (input, init) => {
      requests.push(new Request(input, init))
      return Response.json([
        { name: "review", description: "Review", source: "/repo/.opencode/skill/review/SKILL.md", revision: "r1" },
        { name: "broken" },
      ])
    })

    expect(await client.skills.catalog("/repo")).toEqual([
      { name: "review", description: "Review", source: "/repo/.opencode/skill/review/SKILL.md", revision: "r1" },
    ])
    const url = new URL(requests[0]!.url)
    expect(url.pathname).toBe("/skill/catalog")
    expect(url.searchParams.get("directory")).toBe("/repo")
    expect(requests[0]!.headers.get("authorization")).toBe(`Basic ${btoa("opencode:secret")}`)
  })

  test("treats servers without the extension as having no managed skills", async () => {
    const client = createExtensionClient(server, async () => Response.json({ message: "nope" }, { status: 404 }))
    expect(await client.skills.catalog("/repo")).toEqual([])
  })

  test("selects exact skill identities and surfaces validation messages", async () => {
    const bodies: unknown[] = []
    const client = createExtensionClient(server, async (input, init) => {
      const request = new Request(input, init)
      bodies.push(await request.json())
      return Response.json({ message: "Skill is missing, changed or has a duplicate name." }, { status: 400 })
    })
    const skill = { name: "review", description: "Review", source: "/s", revision: "r1" }

    await expect(client.skills.select("/repo", "ses_1", [skill])).rejects.toThrow("Skill is missing")
    expect(bodies).toEqual([{ sessionID: "ses_1", selected: [{ name: "review", source: "/s", revision: "r1" }] }])
  })
})

describe("createExtensionClient worktree", () => {
  test("resets a target worktree under its project root", async () => {
    const requests: Request[] = []
    const client = createExtensionClient(server, async (input, init) => {
      requests.push(new Request(input, init))
      return Response.json(true)
    })

    expect(await client.worktree.reset("/repo", "/repo-worktrees/a")).toBe(true)
    const url = new URL(requests[0]!.url)
    expect(url.pathname).toBe("/worktree/reset")
    expect(url.searchParams.get("directory")).toBe("/repo")
    expect(requests[0]!.method).toBe("POST")
    expect(await requests[0]!.json()).toEqual({ directory: "/repo-worktrees/a" })
  })

  test("surfaces the extension's refusal message", async () => {
    const client = createExtensionClient(server, async () =>
      Response.json({ message: "Workspace has an active session" }, { status: 400 }),
    )
    await expect(client.worktree.reset("/repo", "/repo-worktrees/a")).rejects.toThrow("Workspace has an active session")
  })
})
