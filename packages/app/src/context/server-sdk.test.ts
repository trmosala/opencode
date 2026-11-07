import { describe, expect, test } from "bun:test"
import {
  adaptServerEvent,
  coalesceServerEvents,
  eventDirectory,
  enqueueServerEvent,
  resumeStreamAfterPageShow,
} from "./server-sdk"
import type { OpenCodeEvent } from "@opencode/client/promise"
import type { Event } from "@opencode-ai/sdk/v2/client"

describe("resumeStreamAfterPageShow", () => {
  test("restarts a stream only after a back-forward cache restore", () => {
    let starts = 0
    const start = () => starts++

    resumeStreamAfterPageShow({ persisted: false } as PageTransitionEvent, start)
    resumeStreamAfterPageShow({ persisted: true } as PageTransitionEvent, start)

    expect(starts).toBe(1)
  })
})

describe("adaptServerEvent", () => {
  test("adapts durable V2 archive events for the session cache", () => {
    expect(
      adaptServerEvent({
        id: "evt_archive",
        type: "session.next.archived",
        data: { sessionID: "ses_1", timestamp: 123 },
      }),
    ).toEqual({ id: "evt_archive", type: "session.next.archived", properties: { sessionID: "ses_1", timestamp: 123 } })
  })
  test("preserves V2 events while adapting permission requests for existing consumers", () => {
    const current = {
      id: "evt_1",
      created: 1,
      type: "permission.asked",
      data: { id: "perm_1", sessionID: "ses_1", action: "read", resources: ["src/**"] },
    } as OpenCodeEvent

    expect(adaptServerEvent(current)).toMatchObject({
      type: "permission.asked",
      properties: { id: "perm_1", sessionID: "ses_1", permission: "read", patterns: ["src/**"] },
      current,
    })
  })
  test("adapts 2.2.5 session lifecycle events to the records the sync reducers keep", () => {
    const created = {
      id: "evt_c",
      created: 50,
      type: "session.created",
      durable: { aggregateID: "ses_1", seq: 1, version: 1 },
      data: {
        sessionID: "ses_1",
        projectID: "prj",
        location: { directory: "/repo" },
        slug: "brave-otter",
        version: "2.2.5",
      },
    } as OpenCodeEvent
    expect(adaptServerEvent(created)).toMatchObject({
      type: "session.created",
      properties: {
        sessionID: "ses_1",
        info: {
          id: "ses_1",
          slug: "brave-otter",
          projectID: "prj",
          directory: "/repo",
          title: "",
          time: { created: 50, updated: 50 },
        },
      },
      current: created,
    })

    const archived = {
      id: "evt_a",
      created: 77,
      type: "session.archived",
      durable: { aggregateID: "ses_1", seq: 2, version: 1 },
      data: { sessionID: "ses_1" },
    } as OpenCodeEvent
    expect(adaptServerEvent(archived)).toMatchObject({
      type: "session.next.archived",
      properties: { sessionID: "ses_1", timestamp: 77 },
      current: archived,
    })
  })
})

describe("eventDirectory", () => {
  test("routes location-less 2.2.5 session events to the cached session directory", () => {
    const resolve = (sessionID: string) => (sessionID === "ses_known" ? "/repo" : undefined)
    const event = (sessionID: string, location?: { directory: string }) =>
      ({ id: "e", created: 1, type: "session.renamed", data: { sessionID, title: "t" }, location }) as OpenCodeEvent
    expect(eventDirectory(event("ses_known"), resolve)).toBe("/repo")
    expect(eventDirectory(event("ses_known", { directory: "/elsewhere" }), resolve)).toBe("/elsewhere")
    expect(eventDirectory(event("ses_unknown"), resolve)).toBe("global")
    expect(eventDirectory({ id: "p", type: "project.updated", data: {} } as unknown as OpenCodeEvent, resolve)).toBe(
      "global",
    )
  })

  test("adapts 2.2.5 project updates to worktree-rooted project records", () => {
    const current = {
      id: "evt_p",
      created: 1,
      type: "project.updated",
      data: { id: "prj", canonical: "/repo", time: { created: 1, updated: 2 }, sandboxes: [] },
    } as unknown as OpenCodeEvent
    expect(adaptServerEvent(current)).toMatchObject({
      type: "project.updated",
      properties: { id: "prj", worktree: "/repo" },
    })
  })
})

describe("coalesceServerEvents", () => {
  const delta = (value: string, field = "text", partID = "part") => ({
    directory: "/repo",
    payload: {
      type: "message.part.delta",
      properties: { messageID: "msg", partID, field, delta: value },
    } as Event,
  })

  test("merges adjacent deltas for the same field", () => {
    const first = delta("hello ")
    const second = delta("world")
    first.payload.id = "first"
    second.payload.id = "second"
    const result = coalesceServerEvents([first, second])

    expect(result).toHaveLength(1)
    expect(result[0]?.payload).toMatchObject({ id: "second", properties: { delta: "hello world" } })
  })

  test("merges adjacent current text deltas", () => {
    const current = (id: string, value: string) =>
      adaptServerEvent({
        id,
        created: 1,
        type: "session.text.delta",
        location: { directory: "/repo" },
        data: { sessionID: "ses", assistantMessageID: "msg", ordinal: 0, delta: value },
      } as OpenCodeEvent)
    const result = coalesceServerEvents([
      { directory: "/repo", payload: current("evt_1", "hello ") },
      { directory: "/repo", payload: current("evt_2", "world") },
    ])

    expect(result).toHaveLength(1)
    expect(result[0]?.payload.current).toMatchObject({ id: "evt_2", data: { delta: "hello world" } })
  })

  test("preserves event boundaries and distinct fields", () => {
    const status = {
      directory: "/repo",
      payload: { type: "session.status", properties: { sessionID: "ses", status: { type: "idle" } } } as Event,
    }
    const result = coalesceServerEvents([delta("a"), delta("b", "metadata"), status, delta("c")])

    expect(result.map((event) => event.payload.type)).toEqual([
      "message.part.delta",
      "message.part.delta",
      "session.status",
      "message.part.delta",
    ])
  })

  test("preserves event ID order across interleaved deltas", () => {
    const first = delta("a")
    const other = delta("b", "text", "other")
    const last = delta("c")
    first.payload.id = "1"
    other.payload.id = "2"
    last.payload.id = "3"

    const result = coalesceServerEvents([first, other, last])

    expect(result.map((event) => event.payload.id)).toEqual(["1", "2", "3"])
  })
})

describe("enqueueServerEvent", () => {
  const partUpdated = (text: string) =>
    ({
      type: "message.part.updated",
      properties: {
        sessionID: "session",
        part: { id: "part", sessionID: "session", messageID: "message", type: "text", text },
      },
    }) as Event

  test("preserves part updates across message remove and re-add barriers", () => {
    const events: Array<{ directory: string; payload: Event }> = []
    const enqueue = (payload: Event) => enqueueServerEvent(events, { directory: "/repo", payload })

    enqueue(partUpdated("old"))
    enqueue({ type: "message.removed", properties: { sessionID: "session", messageID: "message" } } as Event)
    enqueue({
      type: "message.updated",
      properties: {
        sessionID: "session",
        info: {
          id: "message",
          sessionID: "session",
          role: "user",
          time: { created: 1 },
          agent: "build",
          model: { providerID: "provider", modelID: "model" },
        },
      },
    } as Event)
    enqueue(partUpdated("new"))

    expect(events.map((event) => event.payload.type)).toEqual([
      "message.part.updated",
      "message.removed",
      "message.updated",
      "message.part.updated",
    ])
  })

  test("preserves deltas after a replacement snapshot", () => {
    const events: Array<{ directory: string; payload: Event }> = []
    const enqueue = (payload: Event) => enqueueServerEvent(events, { directory: "/repo", payload })

    enqueue(partUpdated("a"))
    enqueue(partUpdated("ab"))
    enqueue({
      type: "message.part.delta",
      properties: { sessionID: "session", messageID: "message", partID: "part", field: "text", delta: "c" },
    } as Event)

    const result = coalesceServerEvents(events)
    expect(result.map((event) => event.payload.type)).toEqual(["message.part.updated", "message.part.delta"])
    expect(result[0]?.payload).toMatchObject({ properties: { part: { text: "ab" } } })
    expect(result[1]?.payload).toMatchObject({ properties: { delta: "c" } })
  })

  test("preserves updates after session deletion", () => {
    const events: Array<{ directory: string; payload: Event }> = []
    const enqueue = (payload: Event) => enqueueServerEvent(events, { directory: "/repo", payload })

    enqueue(partUpdated("old"))
    enqueue({
      type: "session.deleted",
      properties: { sessionID: "session", info: { id: "session" } },
    } as Event)
    enqueue(partUpdated("new"))

    expect(events.map((event) => event.payload.type)).toEqual([
      "message.part.updated",
      "session.deleted",
      "message.part.updated",
    ])
  })

  test("does not coalesce edge-triggered session statuses", () => {
    const events: Array<{ directory: string; payload: Event }> = []
    const enqueue = (status: "retry" | "busy") =>
      enqueueServerEvent(events, {
        directory: "/repo",
        payload: {
          type: "session.status",
          properties: {
            sessionID: "session",
            status: status === "retry" ? { type: "retry", attempt: 1, message: "retry", next: 1 } : { type: "busy" },
          },
        } as Event,
      })

    enqueue("retry")
    enqueue("busy")

    expect(events).toHaveLength(2)
  })
})
