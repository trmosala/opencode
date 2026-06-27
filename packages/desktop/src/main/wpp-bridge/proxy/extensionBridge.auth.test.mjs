import { describe, expect, mock, test } from "bun:test";

// extensionBridge -> worker-pool -> session.ts imports electron, which has no usable export
// outside an Electron runtime. Stub it; the auth-edge logic touches none of it.
mock.module("electron", () => ({ BrowserWindow: class {}, session: { fromPartition: () => ({}) } }));

const { ExtensionBridge } = await import("./extensionBridge.mjs");

describe("auth-required login trigger", () => {
  test("fires onAuthRequired once on the false->true edge", () => {
    const bridge = new ExtensionBridge();
    let calls = 0;
    bridge.onAuthRequired = () => { calls += 1; };

    bridge.markAuthRequired("first");
    bridge.markAuthRequired("still required"); // no re-fire while required
    expect(calls).toBe(1);

    bridge.clearAuthRequired();
    bridge.markAuthRequired("after re-auth"); // edge again -> fires
    expect(calls).toBe(2);
  });
});
