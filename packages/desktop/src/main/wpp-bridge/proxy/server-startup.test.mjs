import { describe, expect, test } from "bun:test"
import {
  COOKIEMONSTER_BRIDGE_EXECUTOR,
  isCookieMonsterBridgeHealth,
  probeProxyOccupant,
  proxyInstanceConflictError,
  proxyPortConflictError,
  shouldIgnoreListenError,
} from "./server-startup.mjs"

describe("server startup", () => {
  test("recognizes EADDRINUSE as a listen conflict candidate", () => {
    expect(shouldIgnoreListenError({ code: "EADDRINUSE" })).toBe(true)
    expect(shouldIgnoreListenError({ code: "EACCES" })).toBe(false)
  })

  test("accepts only CookieMonster worker-pool bridge health", () => {
    expect(isCookieMonsterBridgeHealth({ ok: true, executor: COOKIEMONSTER_BRIDGE_EXECUTOR })).toBe(true)
    expect(isCookieMonsterBridgeHealth({ ok: true })).toBe(false)
    expect(isCookieMonsterBridgeHealth({ ok: true, executor: "extension" })).toBe(false)
    expect(isCookieMonsterBridgeHealth({ ok: false, executor: COOKIEMONSTER_BRIDGE_EXECUTOR })).toBe(false)
  })

  test("probes /bridge/health before treating EADDRINUSE as ours", async () => {
    const calls = []
    const fetchImpl = async (url, init) => {
      calls.push({ url, method: init?.method, authorization: init?.headers?.authorization })
      return {
        ok: true,
        json: async () => ({ ok: true, executor: COOKIEMONSTER_BRIDGE_EXECUTOR }),
      }
    }
    expect(await probeProxyOccupant("127.0.0.1", 8787, { fetchImpl, token: "launch-token" })).toBe("ours")
    expect(calls).toEqual([
      { url: "http://127.0.0.1:8787/bridge/health", method: "GET", authorization: "Bearer launch-token" },
    ])
  })

  test("rejects foreign or unreachable occupants", async () => {
    expect(
      await probeProxyOccupant("127.0.0.1", 8787, {
        fetchImpl: async () => ({ ok: true, json: async () => ({ ok: true }) }),
      }),
    ).toBe("foreign")
    expect(
      await probeProxyOccupant("127.0.0.1", 8787, {
        fetchImpl: async () => ({ ok: false, status: 401, json: async () => ({ message: "nope" }) }),
      }),
    ).toBe("foreign")
    expect(
      await probeProxyOccupant("127.0.0.1", 8787, {
        fetchImpl: async () => {
          throw new Error("connection refused")
        },
      }),
    ).toBe("foreign")
  })

  test("recognizes another CookieMonster launch that refuses this launch's token", async () => {
    expect(
      await probeProxyOccupant("127.0.0.1", 8787, {
        fetchImpl: async () => ({
          ok: false,
          status: 401,
          json: async () => ({
            error: { message: "Missing or invalid O1-Code proxy access token.", type: "unauthorized" },
          }),
        }),
      }),
    ).toBe("cookiemonster")
    expect(proxyInstanceConflictError("127.0.0.1", 8787)).toMatchObject({
      code: "EADDRINUSE",
      type: "o1_code_proxy_instance_conflict",
    })
  })

  test("builds a typed port-conflict error", () => {
    expect(proxyPortConflictError("127.0.0.1", 8787)).toMatchObject({
      code: "EADDRINUSE",
      type: "o1_code_proxy_port_conflict",
      statusCode: 500,
    })
  })
})
