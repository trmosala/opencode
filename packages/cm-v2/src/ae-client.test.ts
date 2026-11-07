import { expect, test } from "bun:test"
import type { SessionMessageInfo } from "@opencode/client"
import { aeProjection, legacyMessages } from "./ae-client"

const message: SessionMessageInfo = {
  id: "msg_fixture",
  type: "assistant",
  agent: "build",
  model: { providerID: "fixture", id: "m" },
  time: { created: 1 },
  content: [],
}

test("live AE projection preserves streamed text/reasoning, Session isolation and newer durable content", () => {
  const live = aeProjection()
  live.event({
    id: "evt_a",
    created: 1,
    type: "session.text.delta",
    data: { sessionID: "ses_a", assistantMessageID: message.id, ordinal: 0, delta: "partial" },
  })
  live.event({
    id: "evt_b",
    created: 2,
    type: "session.reasoning.delta",
    data: { sessionID: "ses_a", assistantMessageID: message.id, ordinal: 1, delta: "thinking" },
  })
  expect(live.apply([message], "ses_a")[0]).toMatchObject({
    content: [
      { type: "text", text: "partial" },
      { type: "reasoning", text: "thinking" },
    ],
  })
  expect(live.apply([message], "ses_b")[0]).toEqual(message)
  expect(
    live.apply([{ ...message, content: [{ type: "text", text: "partial completed" }] }], "ses_a")[0],
  ).toMatchObject({
    content: [
      { type: "text", text: "partial completed" },
      { type: "reasoning", text: "thinking" },
    ],
  })
  live.event({
    id: "evt_c",
    created: 3,
    type: "session.deleted",
    durable: { aggregateID: "ses_a", seq: 1, version: 2 },
    data: { sessionID: "ses_a" },
  })
  expect(live.apply([message], "ses_a")[0]).toEqual(message)
})

test("live AE projection bounds text and retained messages and clears on disposal", () => {
  const live = aeProjection()
  Array.from({ length: 61 }, (_, index) =>
    live.event({
      id: `evt_${index}`,
      created: index,
      type: "session.text.delta",
      data: { sessionID: "ses_a", assistantMessageID: `msg_${index}`, ordinal: 0, delta: "x".repeat(100000) },
    }),
  )
  expect(live.apply([{ ...message, id: "msg_0" }], "ses_a")[0].type).toBe("assistant")
  expect(live.apply([{ ...message, id: "msg_0" }], "ses_a")[0]).toMatchObject({ content: [] })
  expect(live.apply([{ ...message, id: "msg_60" }], "ses_a")[0]).toMatchObject({
    content: [{ text: "x".repeat(64000) }],
  })
  live.clear()
  expect(live.apply([{ ...message, id: "msg_60" }], "ses_a")[0]).toMatchObject({ content: [] })
})

test("AE history keeps attachments, tool results, errors and truthful V2 skill activations", () => {
  const history: SessionMessageInfo[] = [
    {
      id: "msg_1",
      type: "user",
      time: { created: 1 },
      text: "Original request",
      files: [{ data: "Zg==", mime: "text/plain", source: { type: "inline" }, name: "reference.txt" }],
    },
    {
      id: "msg_2",
      type: "skill",
      time: { created: 2 },
      skill: "skill_fixture",
      name: "Technique",
      text: "Loaded instructions",
    },
    {
      ...message,
      id: "msg_3",
      error: { type: "fixture", message: "Provider failed" },
      content: [
        {
          type: "tool",
          id: "call_1",
          name: "ae_capture",
          time: { created: 3 },
          state: {
            status: "completed",
            input: {},
            content: [
              { type: "text", text: '{"compId":1,"time":0}' },
              { type: "file", uri: "data:image/png;base64,Zg==", mime: "image/png", name: "frame.png" },
            ],
          },
        },
      ],
    },
  ]
  const result = legacyMessages(history, "ses_a", [{ id: "skill_fixture", path: "/fixture/SKILL.md" }])
  expect(result[0]).toMatchObject({
    parts: [
      { type: "text", text: "Original request" },
      { type: "file", url: "data:text/plain;base64,Zg==", filename: "reference.txt" },
    ],
  })
  expect(result[1]).toMatchObject({
    parts: [{ tool: "skill", state: { status: "completed", metadata: { name: "Technique" } } }],
  })
  expect(result[2]).toMatchObject({
    info: { parentID: "msg_1", error: { data: { message: "Provider failed" } } },
    parts: [
      { tool: "ae_capture", state: { output: '{"compId":1,"time":0}', attachments: [{ filename: "frame.png" }] } },
    ],
  })
})
