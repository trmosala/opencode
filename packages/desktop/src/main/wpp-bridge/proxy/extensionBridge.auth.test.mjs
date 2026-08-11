import { describe, expect, test } from "bun:test";

// extensionBridge -> worker-pool -> session.ts imports electron, which has no usable export
// outside an Electron runtime. Stub it; the auth-edge logic touches none of it.
// The shared stub in packages/desktop/test/preload.ts supplies it before any test file links.

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

describe("client cancellation", () => {
  test("forwards the abort signal and clears the leased job", async () => {
    const bridge = new ExtensionBridge();
    const controller = new AbortController();
    let receivedSignal;
    bridge.workerPoolUrl = "https://example.test/chat";
    bridge.workerPool = {
      run: (_job, _onProgress, signal) => {
        receivedSignal = signal;
        return new Promise((_resolve, reject) => {
          signal.addEventListener("abort", () => {
            const error = new Error("client disconnected");
            error.statusCode = 499;
            error.type = "o1_code_client_aborted";
            reject(error);
          }, { once: true });
        });
      },
      destroy: () => {},
    };

    const run = bridge.run("prompt", {
      url: bridge.workerPoolUrl,
      signal: controller.signal,
    });
    controller.abort();

    await expect(run).rejects.toMatchObject({ type: "o1_code_client_aborted" });
    expect(receivedSignal).toBe(controller.signal);
    expect(bridge.health().inFlightJobs).toBe(0);
    expect(bridge.health().counters.failed).toBe(1);
  });
});
