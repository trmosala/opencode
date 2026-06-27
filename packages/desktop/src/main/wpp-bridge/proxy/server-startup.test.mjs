import { describe, expect, test } from "bun:test";
import { shouldIgnoreListenError } from "./server-startup.mjs";

describe("server startup", () => {
  test("handles EADDRINUSE without exiting the Electron process", () => {
    expect(shouldIgnoreListenError({ code: "EADDRINUSE" })).toBe(true);
    expect(shouldIgnoreListenError({ code: "EACCES" })).toBe(false);
  });
});
