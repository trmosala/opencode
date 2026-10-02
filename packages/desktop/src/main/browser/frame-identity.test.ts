import { expect, test } from "bun:test"
import { sameNativeFrame, type NativeFrameIdentity } from "./frame-identity"

test("native frame wrappers compare by stable frame identity, not object reference", () => {
  const first: NativeFrameIdentity = { frameTreeNodeId: 12, processId: 34, routingId: 56 }
  const nextWrapper: NativeFrameIdentity = { ...first }
  expect(first === nextWrapper).toBe(false)
  expect(sameNativeFrame(first, nextWrapper)).toBe(true)
  expect(sameNativeFrame(first, { ...first, frameTreeNodeId: 13 })).toBe(false)
  expect(sameNativeFrame(first, { ...first, processId: 35 })).toBe(false)
  expect(sameNativeFrame(first, { ...first, routingId: 57 })).toBe(false)
})
