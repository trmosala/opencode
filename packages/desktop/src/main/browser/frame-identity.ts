import type { WebFrameMain } from "electron"

export type NativeFrameIdentity = Pick<WebFrameMain, "frameTreeNodeId" | "processId" | "routingId">

export function nativeFrameIdentity(frame: WebFrameMain): NativeFrameIdentity {
  return {
    frameTreeNodeId: frame.frameTreeNodeId,
    processId: frame.processId,
    routingId: frame.routingId,
  }
}

export function sameNativeFrame(left: NativeFrameIdentity, right: NativeFrameIdentity) {
  return (
    left.frameTreeNodeId === right.frameTreeNodeId &&
    left.processId === right.processId &&
    left.routingId === right.routingId
  )
}
