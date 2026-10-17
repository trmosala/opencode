import { expect, test } from "bun:test"
import type { Page, Route } from "@playwright/test"
import { mockOpenCodeServer } from "../../utils/mock-server"

test("applies message latency after a list response gate is released", async () => {
  const events: string[] = []
  const gate = Promise.withResolvers<void>()
  let handler: ((route: Route) => Promise<void>) | undefined
  const page = {
    route: (_url: string, callback: (route: Route) => Promise<void>) => {
      handler = callback
      return Promise.resolve()
    },
  } as unknown as Page
  await mockOpenCodeServer(page, {
    provider: {},
    directory: "C:/OpenCode",
    project: {},
    sessions: [{ id: "session" }],
    messageDelay: 25,
    beforeMessagesResponse: () => {
      events.push("before")
      return gate.promise
    },
    onMessages: (request) => events.push(request.phase),
    pageMessages: () => {
      events.push("page")
      return { items: [] }
    },
  })

  const response = handler!({
    request: () => ({ url: () => "http://127.0.0.1:4096/session/session/message" }),
    fulfill: () => {
      events.push("fulfill")
      return Promise.resolve()
    },
  } as unknown as Route)
  expect(events).toEqual(["start", "before"])

  const released = performance.now()
  gate.resolve()
  await response
  expect(performance.now() - released).toBeGreaterThanOrEqual(20)
  expect(events).toEqual(["start", "before", "page", "end", "fulfill"])
})

test("serves current file-search results to the command palette", async () => {
  let handler: ((route: Route) => Promise<void>) | undefined
  const searches: unknown[] = []
  const page = {
    route: (_url: string, callback: (route: Route) => Promise<void>) => {
      handler = callback
      return Promise.resolve()
    },
  } as unknown as Page
  await mockOpenCodeServer(page, {
    provider: {},
    directory: "C:/OpenCode",
    project: { id: "project" },
    sessions: [],
    pageMessages: () => ({ items: [] }),
    findFiles: (input) => {
      searches.push(input)
      return ["src/index.ts"]
    },
  })
  let response: unknown
  await handler!({
    request: () => ({ url: () => "http://127.0.0.1:4096/api/fs/find?query=index&type=file&limit=200" }),
    fulfill: (input: { body: string }) => {
      response = JSON.parse(input.body)
      return Promise.resolve()
    },
  } as unknown as Route)
  expect(searches).toEqual([{ query: "index", dirs: "false", limit: 200 }])
  expect(response).toEqual({
    location: { directory: "C:/OpenCode", project: { id: "project", directory: "C:/OpenCode" } },
    data: [{ path: "src/index.ts", type: "file" }],
  })
})
