import { expect, test } from "bun:test"
import { realpath } from "node:fs/promises"
import { join } from "node:path"
import { createBrowserSessionResolver, parseBrowserSession } from "./session-resolver"

const session = (input: Record<string, unknown> = {}) => ({
  id: "child",
  parentID: "parent",
  projectID: "project",
  location: { directory: process.cwd(), workspaceID: "work" },
  ...input,
})
const envelope = (data: unknown) => Response.json({ data })

test("session records use the V2 session location and require exact identities", () => {
  const record = parseBrowserSession(session(), "child")
  expect(record).toEqual({
    id: "child",
    parentID: "parent",
    projectID: "project",
    directory: process.cwd(),
    workspaceID: "work",
  })
  for (const change of [
    { id: "other" },
    { id: undefined },
    { projectID: "" },
    { parentID: 1 },
    { location: null },
    { location: { directory: "relative" } },
    { location: { directory: "x".repeat(32768) } },
    { location: { directory: `${process.cwd()}\0` } },
    { location: { directory: process.cwd(), workspaceID: null } },
  ])
    expect(() => parseBrowserSession(session(change), "child")).toThrow()
  for (const value of [null, [], "text", 1]) expect(() => parseBrowserSession(value, "child")).toThrow()
})

test("resolver uses authenticated GET /api/session and canonical V2 ownership metadata", async () => {
  const requests: { url: URL; auth: string | null }[] = []
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch(request) {
      requests.push({ url: new URL(request.url), auth: request.headers.get("authorization") })
      const id = new URL(request.url).pathname.split("/").at(-1)
      return envelope(
        session({
          id,
          ...(id === "parent" ? { parentID: undefined } : {}),
          location: { directory: join(process.cwd(), "src", ".."), workspaceID: "work" },
        }),
      )
    },
  })
  try {
    const resolver = createBrowserSessionResolver(server.url.href, "test-password")
    const owner = await resolver.resolveOwnerScope!("parent", new AbortController().signal)
    expect(owner).toEqual({
      projectID: "project",
      directory: await realpath(process.cwd()),
      workspaceID: "work",
      serverURL: server.url.href,
    })
    expect(await resolver("child", { ...owner, generation: 1 }, new AbortController().signal)).toEqual({
      id: "child",
      parentID: "parent",
      projectID: "project",
      directory: await realpath(process.cwd()),
      workspaceID: "work",
    })
    expect(requests).toHaveLength(2)
    expect(
      requests.every((request) => request.auth === `Basic ${Buffer.from("opencode:test-password").toString("base64")}`),
    ).toBe(true)
    expect(requests[0].url.pathname).toBe("/api/session/parent")
    expect(requests[1].url.pathname).toBe("/api/session/child")
    expect(requests[1].url.searchParams.get("directory")).toBe(owner.directory)
    expect(requests[1].url.searchParams.get("workspace")).toBe("work")
    await expect(
      resolver("child", { ...owner, serverURL: "http://127.0.0.1:1", generation: 1 }, new AbortController().signal),
    ).rejects.toThrow()
    await expect(resolver("../child", { ...owner, generation: 1 }, new AbortController().signal)).rejects.toThrow()
    expect(requests).toHaveLength(2)
  } finally {
    await server.stop(true)
  }
})

test.each(["id", "workspace", "directory", "oversize", "malformed", "envelope", "redirect", "status"] as const)(
  "resolver fails closed on %s",
  async (mode) => {
    let requests = 0
    const server = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      fetch() {
        requests++
        if (mode === "oversize") return new Response(" ".repeat(65537))
        if (mode === "malformed") return new Response("{")
        if (mode === "envelope") return Response.json(session())
        if (mode === "redirect") return new Response(null, { status: 302, headers: { location: "/redirected" } })
        if (mode === "status") return new Response(null, { status: 401 })
        return envelope(
          session({
            id: mode === "id" ? "other" : "child",
            location: {
              directory: mode === "directory" ? join(process.cwd(), "..") : process.cwd(),
              workspaceID: mode === "workspace" ? "other" : "work",
            },
          }),
        )
      },
    })
    try {
      const resolver = createBrowserSessionResolver(server.url.href, "password")
      await expect(
        resolver(
          "child",
          {
            projectID: "project",
            directory: process.cwd(),
            workspaceID: "work",
            serverURL: server.url.href,
            generation: 1,
          },
          new AbortController().signal,
        ),
      ).rejects.toThrow()
      expect(requests).toBe(1)
    } finally {
      await server.stop(true)
    }
  },
)

test("aborted session lookup cannot return authority from a late HTTP response", async () => {
  const entered = Promise.withResolvers<void>()
  const release = Promise.withResolvers<void>()
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch() {
      entered.resolve()
      await release.promise
      return envelope(session())
    },
  })
  const controller = new AbortController()
  try {
    const resolver = createBrowserSessionResolver(server.url.href, "password")
    const result = resolver(
      "child",
      {
        projectID: "project",
        directory: process.cwd(),
        workspaceID: "work",
        serverURL: server.url.href,
        generation: 1,
      },
      controller.signal,
    ).then(
      () => true,
      () => false,
    )
    await entered.promise
    controller.abort()
    expect(await result).toBe(false)
  } finally {
    release.resolve()
    await server.stop(true)
  }
})

test("resolver refuses untrusted server endpoints and missing authentication", () => {
  for (const url of [
    "https://example.test",
    "http://example.test",
    "http://127.0.0.1/path",
    "http://user:pass@127.0.0.1",
    "http://127.0.0.1/?q=1",
  ])
    expect(() => createBrowserSessionResolver(url, "password")).toThrow()
  expect(() => createBrowserSessionResolver("http://127.0.0.1", "")).toThrow()
})
